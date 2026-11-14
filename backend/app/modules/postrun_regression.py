"""Curvas de calibração massa × área (PostRun, pedido do usuário de
16/10/2026): regressão da área do sinal (sinal × s) contra a massa (da
amostra ou de um componente dela) e a inversa — da área de uma corrida
nova para a massa — com incerteza.

- Modelos: `linear` (a + b·m), `origin` (b·m, como a "Gain law" do
  GeoWorks) e `quadratic` (a + b·m + c·m², para a região perto da
  saturação do FID).
- Pesos: `none`, `1/x` ou `1/x2` — com massas de 0,1 a 4 mg a dispersão da
  área cresce com a massa; sem peso, as massas grandes mandam no ajuste.
- Inversa: m₀ tal que f(m₀) = A₀; incerteza pelo método delta,
  u(m₀)² = [s²/w(m₀) + gᵀ·Cov·g] / f'(m₀)² (uma medida nova + incerteza da
  curva), expandida com t de Student (95 %).
- LD/LQ (ICH Q2): 3,3·σ₀/b e 10·σ₀/b, σ₀ = erro-padrão da resposta prevista
  em massa zero (o do intercepto); no modelo pela origem, o desvio das
  réplicas do menor nível de massa (até 1,5 × a menor massa).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import stats

MODELS = ("linear", "origin", "quadratic")
WEIGHTINGS = ("none", "1/x", "1/x2")


class FitError(ValueError):
    pass


def _design(x: np.ndarray, model: str) -> np.ndarray:
    if model == "linear":
        return np.column_stack([np.ones_like(x), x])
    if model == "origin":
        return x.reshape(-1, 1)
    if model == "quadratic":
        return np.column_stack([np.ones_like(x), x, x * x])
    raise FitError(f"modelo desconhecido: {model}")


def _weights(x: np.ndarray, weighting: str) -> np.ndarray:
    if weighting == "none":
        return np.ones_like(x)
    if np.any(x <= 0):
        raise FitError("peso 1/x ou 1/x² exige todas as massas maiores que zero")
    if weighting == "1/x":
        return 1.0 / x
    if weighting == "1/x2":
        return 1.0 / (x * x)
    raise FitError(f"peso desconhecido: {weighting}")


@dataclass
class Fit:
    model: str
    weighting: str
    coef: list[float]  # [a, b] / [b] / [a, b, c]
    cov: list[list[float]]
    s: float  # desvio-padrão residual (ponderado): var(y | x) = s²/w(x)
    s_y: float  # desvio-padrão residual sem peso (na unidade da área)
    r2: float
    n: int
    dof: int
    x_min: float
    x_max: float
    residuals: list[float]
    lod: float | None
    loq: float | None
    # fator de resposta área/mg por ponto: média, desvio, CV %
    rf_mean: float | None = None
    rf_sd: float | None = None
    rf_cv_pct: float | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def slope_at_zero(self) -> float:
        return self.coef[0] if self.model == "origin" else self.coef[1]

    def predict(self, x: float) -> float:
        row = _design(np.array([x], dtype=float), self.model)[0]
        return float(row @ np.array(self.coef))

    def derivative(self, x: float) -> float:
        if self.model == "origin":
            return self.coef[0]
        if self.model == "linear":
            return self.coef[1]
        return self.coef[1] + 2 * self.coef[2] * x

    def weight_at(self, x: float) -> float:
        if self.weighting == "none":
            return 1.0
        x = max(x, 1e-12)
        return 1.0 / x if self.weighting == "1/x" else 1.0 / (x * x)


def fit(x_values: list[float], y_values: list[float], model: str = "linear", weighting: str = "none") -> Fit:
    if model not in MODELS:
        raise FitError(f"modelo desconhecido: {model}")
    if weighting not in WEIGHTINGS:
        raise FitError(f"peso desconhecido: {weighting}")
    x = np.asarray(x_values, dtype=float)
    y = np.asarray(y_values, dtype=float)
    p = {"linear": 2, "origin": 1, "quadratic": 3}[model]
    if len(x) != len(y):
        raise FitError("massas e áreas em número diferente")
    if len(x) < p + 1:
        raise FitError(f"o modelo precisa de pelo menos {p + 1} pontos")
    if len(np.unique(x)) < p:
        raise FitError("massas iguais demais para esse modelo — use mais níveis de massa")
    w = _weights(x, weighting)
    X = _design(x, model)
    XtW = X.T * w
    try:
        inv = np.linalg.inv(XtW @ X)
    except np.linalg.LinAlgError as exc:
        raise FitError("não deu para ajustar (pontos colineares)") from exc
    beta = inv @ (XtW @ y)
    resid = y - X @ beta
    dof = len(x) - p
    s2 = float(np.sum(w * resid * resid) / dof)
    cov = s2 * inv
    ss_res = float(np.sum(resid * resid))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 1.0

    slope = float(beta[0] if model == "origin" else beta[1])
    warnings: list[str] = []
    if slope <= 0:
        warnings.append("a área não cresce com a massa — confira os pontos")
    sigma0: float | None
    if model == "origin":
        # réplicas do menor nível de massa (massas pesadas variam um pouco:
        # 0,101 / 0,106 / 0,123 mg são o mesmo nível)
        lowest = x <= x.min() * 1.5
        sigma0 = float(np.std(resid[lowest], ddof=1)) if np.count_nonzero(lowest) >= 2 else None
    else:
        sigma0 = float(np.sqrt(cov[0, 0]))
    lod = 3.3 * sigma0 / slope if sigma0 is not None and slope > 0 else None
    loq = 10.0 * sigma0 / slope if sigma0 is not None and slope > 0 else None

    rf = y[x > 0] / x[x > 0]
    rf_mean = float(rf.mean()) if rf.size else None
    rf_sd = float(rf.std(ddof=1)) if rf.size > 1 else None
    rf_cv = 100.0 * rf_sd / rf_mean if rf_sd is not None and rf_mean else None

    return Fit(
        model=model, weighting=weighting, coef=[float(v) for v in beta], cov=cov.tolist(),
        s=float(np.sqrt(s2)), s_y=float(np.sqrt(ss_res / dof)), r2=r2, n=len(x), dof=dof,
        x_min=float(x.min()), x_max=float(x.max()), residuals=[float(v) for v in resid],
        lod=lod, loq=loq, rf_mean=rf_mean, rf_sd=rf_sd, rf_cv_pct=rf_cv, warnings=warnings,
    )


@dataclass
class Inverse:
    x: float
    u: float  # incerteza-padrão
    U95: float  # expandida (t de Student, 95 %)
    outside_range: bool
    below_lod: bool
    below_loq: bool


def inverse(f: Fit, y0: float) -> Inverse:
    """Massa a partir da área de uma corrida nova."""
    a = np.array(f.coef)
    if f.model == "origin":
        if a[0] == 0:
            raise FitError("curva com inclinação zero")
        x0 = y0 / a[0]
    elif f.model == "linear":
        if a[1] == 0:
            raise FitError("curva com inclinação zero")
        x0 = (y0 - a[0]) / a[1]
    else:
        c0, c1, c2 = a[0] - y0, a[1], a[2]
        if abs(c2) < 1e-300:
            x0 = -c0 / c1
        else:
            disc = c1 * c1 - 4 * c2 * c0
            if disc < 0:
                raise FitError("área fora do alcance da curva quadrática")
            roots = [(-c1 + s * np.sqrt(disc)) / (2 * c2) for s in (1, -1)]
            # a raiz no ramo crescente da curva, mais perto da faixa calibrada
            good = [r for r in roots if c1 + 2 * c2 * r > 0] or roots
            center = (f.x_min + f.x_max) / 2
            x0 = min(good, key=lambda r: abs(r - center))
    x0 = float(x0)
    slope = f.derivative(x0)
    g = _design(np.array([x0]), f.model)[0]
    var_curve = float(g @ np.array(f.cov) @ g)
    var_new = f.s * f.s / f.weight_at(abs(x0)) if f.weighting != "none" else f.s * f.s
    u = float(np.sqrt(var_new + var_curve) / abs(slope)) if slope else float("inf")
    t = float(stats.t.ppf(0.975, max(f.dof, 1)))
    span = f.x_max - f.x_min
    return Inverse(
        x=x0, u=u, U95=t * u,
        outside_range=x0 < f.x_min - 0.02 * span or x0 > f.x_max + 0.02 * span,
        below_lod=f.lod is not None and x0 < f.lod,
        below_loq=f.loq is not None and x0 < f.loq,
    )
