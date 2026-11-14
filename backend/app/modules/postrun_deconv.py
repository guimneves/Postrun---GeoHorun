"""Deconvolução do sinal do PostRun em picos (pedido do usuário,
16/10/2026: "dividir cada gaussiana resultante nos sinais, criando amostras
virtuais, e aplicar uma curva de calibração a cada uma").

Modelo: sinal(t) − linha de base = Σ picos, t em segundos (eixo de tempo
do ciclo, `postrun_timebase`), ajustado por mínimos quadrados não lineares
(`scipy.optimize.least_squares`, com limites).

- Forma `gaussian`: h·exp(−(t−μ)²/2σ²) — área h·σ·√(2π).
- Forma `bigaussian` (gaussiana assimétrica): σ diferente de cada lado do
  pico — área h·√(π/2)·(σₑ+σ𝒹). Nos dados reais, PP e PEAD têm cauda para o
  lado frio (esquerdo ~30–40 % mais largo); PS é simétrico.
- Livre: N picos, chutes pelos máximos do sinal suavizado e pelos "ombros"
  (mínimos da 2ª derivada).
- Guiado por referência: cada pico parte do centro/largura da referência do
  material puro, livre dentro de uma tolerância (± °C no centro, ± % na
  largura) — se a rocha/outro polímero desloca o pico (interferência), o
  deslocamento aparece (ΔTmax, Δlargura) em vez de ser escondido.

- Molde do material puro (`fit_templates`, pedido do usuário de 16/10/2026):
  em vez de uma forma analítica, cada componente é a CURVA MÉDIA do material
  puro (normalizada para área 1), e o ajuste só solta a área, a posição e uma
  pequena dilatação no tempo — a forma real (núcleo estreito + caudas) entra
  exata, com 3 parâmetros por componente.

Áreas na mesma unidade da região (sinal × s): as curvas de calibração valem
para elas. Incerteza da área pela covariância do ajuste; correlação alta
entre as áreas de dois picos = a divisão entre eles não é confiável.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import least_squares, nnls
from scipy.signal import find_peaks, savgol_filter

SHAPES = ("gaussian", "bigaussian")
_SQRT_2PI = math.sqrt(2 * math.pi)
_SQRT_PI_2 = math.sqrt(math.pi / 2)
_HIGH_CORRELATION = 0.9


class DeconvError(ValueError):
    pass


def base_name(name: str) -> str:
    """Material de um pico: "PEAD-2" (2º pico da referência) → PEAD."""
    base = name.strip().upper()
    head, sep, tail = base.rpartition("-")
    return head if sep and tail.isdigit() and head else base


def material_area_u(peaks_u: list[float], idx: list[int], corr: list[list[float]] | None) -> float:
    """Incerteza da área de um material com vários picos: soma com a
    correlação entre eles (picos do mesmo material sobrepostos têm
    correlação negativa forte — somar sem ela superestima a incerteza)."""
    var = 0.0
    for a, i in enumerate(idx):
        for b, j in enumerate(idx):
            rho = 1.0 if i == j else (corr[i][j] if corr and i < len(corr) and j < len(corr[i]) else 0.0)
            var += rho * peaks_u[a] * peaks_u[b]
    return math.sqrt(max(var, 0.0))


@dataclass
class PeakGuess:
    """Ponto de partida de um pico (e, no modo guiado, os limites)."""

    mu: float  # s
    sigma: float  # s (na bigaussiana, vale para os dois lados)
    sigma_r: float | None = None  # bigaussiana: lado direito
    name: str = ""
    mu_bounds: tuple[float, float] | None = None
    sigma_bounds: tuple[float, float] | None = None  # gaussiana, ou lado esquerdo da assimétrica
    sigma_r_bounds: tuple[float, float] | None = None  # lado direito da assimétrica
    reference_id: int | None = None
    ref_mu: float | None = None
    ref_sigma: float | None = None  # média dos lados na bigaussiana


@dataclass
class Peak:
    name: str
    h: float
    mu: float  # s
    sigma_l: float  # s (= sigma_r na gaussiana)
    sigma_r: float
    area: float  # sinal × s
    u_area: float
    reference_id: int | None = None
    at_bound: bool = False
    # molde: centro do molde (s) e dilatação (1 = mesma largura do puro)
    center: float | None = None
    stretch: float | None = None

    @property
    def sigma(self) -> float:
        return (self.sigma_l + self.sigma_r) / 2

    @property
    def fwhm(self) -> float:
        return math.sqrt(2 * math.log(2)) * (self.sigma_l + self.sigma_r)


@dataclass
class DeconvResult:
    shape: str
    peaks: list[Peak]
    t: list[float]  # s, pontos ajustados
    y: list[float]  # sinal − linha de base
    fitted: list[float]
    components: list[list[float]]
    r2: float
    rmse: float
    bic: float
    area_correlation: list[list[float]]
    warnings: list[str] = field(default_factory=list)

    @property
    def total_area(self) -> float:
        return sum(p.area for p in self.peaks)


# ------------------------------------------------------------------ modelo

def _n_par(shape: str) -> int:
    return 3 if shape == "gaussian" else 4


def _peak_values(t: np.ndarray, p: np.ndarray, shape: str) -> np.ndarray:
    if shape == "gaussian":
        h, mu, s = p
        return h * np.exp(-0.5 * ((t - mu) / s) ** 2)
    h, mu, sl, sr = p
    s = np.where(t < mu, sl, sr)
    return h * np.exp(-0.5 * ((t - mu) / s) ** 2)


def _model(t: np.ndarray, params: np.ndarray, shape: str, n: int) -> np.ndarray:
    k = _n_par(shape)
    return sum((_peak_values(t, params[i * k:(i + 1) * k], shape) for i in range(n)), np.zeros_like(t))


def _area_and_grad(p: np.ndarray, shape: str) -> tuple[float, np.ndarray]:
    if shape == "gaussian":
        h, _, s = p
        return h * s * _SQRT_2PI, np.array([s * _SQRT_2PI, 0.0, h * _SQRT_2PI])
    h, _, sl, sr = p
    return h * _SQRT_PI_2 * (sl + sr), np.array([_SQRT_PI_2 * (sl + sr), 0.0, h * _SQRT_PI_2, h * _SQRT_PI_2])


# ------------------------------------------------------------------ chutes

def auto_guesses(t: np.ndarray, y: np.ndarray, n: int) -> list[PeakGuess]:
    """Chutes de N picos: máximos do sinal suavizado, depois ombros (mínimos
    da 2ª derivada), depois espalhados — mais altos primeiro."""
    if n < 1:
        raise DeconvError("informe pelo menos 1 pico")
    m = len(y)
    win = max(5, min(51, (m // 15) | 1))
    smooth = savgol_filter(y, win, 3) if m > win else y
    top = float(np.max(smooth)) if m else 0.0
    if top <= 0:
        raise DeconvError("sem sinal acima da linha de base na janela")
    dt = float(np.median(np.diff(t))) if m > 1 else 1.0
    picks: list[int] = []
    peaks, props = find_peaks(smooth, prominence=0.03 * top)
    order = np.argsort(-smooth[peaks]) if len(peaks) else []
    picks.extend(int(peaks[i]) for i in order)
    if len(picks) < n and m > win:
        d2 = savgol_filter(y, win, 3, deriv=2)
        shoulders, _ = find_peaks(-d2, prominence=0.02 * float(np.max(np.abs(d2)) or 1))
        for i in sorted(shoulders, key=lambda j: -smooth[j]):
            if smooth[i] > 0.05 * top and all(abs(i - j) > win // 2 for j in picks):
                picks.append(int(i))
    while len(picks) < n:  # espalha o resto pela janela
        picks.append(int((len(picks) + 0.5) * m / n) if m else 0)
    picks = sorted(picks[:n])
    span = float(t[-1] - t[0]) if m > 1 else 1.0
    sigma0 = max(3 * dt, span / (6 * n))
    return [PeakGuess(mu=float(t[i]), sigma=sigma0) for i in picks]


# ------------------------------------------------------------------ ajuste

def fit(t_values, y_values, guesses: list[PeakGuess], shape: str = "gaussian") -> DeconvResult:
    if shape not in SHAPES:
        raise DeconvError(f"forma desconhecida: {shape}")
    if not guesses:
        raise DeconvError("nenhum pico para ajustar")
    t = np.asarray(t_values, dtype=float)
    y = np.asarray(y_values, dtype=float)
    n = len(guesses)
    k = _n_par(shape)
    if len(t) < k * n + 2:
        raise DeconvError("janela curta demais para tantos picos")
    # escala: sinal ~1e5 e tempo ~1e3 s — ajusta em unidades normalizadas
    ys = float(np.max(np.abs(y))) or 1.0
    t0 = float(t[0])
    ts = float(t[-1] - t[0]) or 1.0
    tn = (t - t0) / ts
    yn = y / ys
    dt_n = float(np.median(np.diff(tn))) if len(tn) > 1 else 1e-3

    lo: list[float] = []
    hi: list[float] = []
    starts_mu: list[float] = []
    starts_s: list[tuple[float, float]] = []
    for g in guesses:
        mu_n = (g.mu - t0) / ts
        s_n = max(g.sigma / ts, dt_n)
        sr_n = max((g.sigma_r or g.sigma) / ts, dt_n)
        mlo, mhi = ((b - t0) / ts for b in g.mu_bounds) if g.mu_bounds else (-0.1, 1.1)
        slo, shi = ((b / ts) for b in g.sigma_bounds) if g.sigma_bounds else (dt_n, 1.0)
        srlo, srhi = ((b / ts) for b in g.sigma_r_bounds) if g.sigma_r_bounds else (slo, shi)
        slo, srlo = max(slo, dt_n * 0.5), max(srlo, dt_n * 0.5)
        shi, srhi = max(shi, slo * 1.01), max(srhi, srlo * 1.01)
        starts_mu.append(min(max(mu_n, mlo), mhi))
        starts_s.append((min(max(s_n, slo), shi), min(max(sr_n, srlo), srhi)))
        lo += [0.0, mlo, slo] + ([] if shape == "gaussian" else [srlo])
        hi += [np.inf, mhi, shi] + ([] if shape == "gaussian" else [srhi])
    lo_a, hi_a = np.array(lo), np.array(hi)

    def resid(p):
        return _model(tn, p, shape, n) - yn

    def start(shift: float) -> np.ndarray:
        """Ponto de partida com os centros deslocados de `shift` (fração da
        tolerância) e alturas pelos mínimos quadrados não negativos — com as
        formas fixas, as alturas são um problema linear."""
        p = []
        for i, g in enumerate(guesses):
            mlo_i, mhi_i = lo_a[i * k + 1], hi_a[i * k + 1]
            half = (mhi_i - mlo_i) / 2 if g.mu_bounds else 0.0
            mu_i = min(max(starts_mu[i] + shift * half, mlo_i), mhi_i)
            sl_i, sr_i = starts_s[i]
            p += [1.0, mu_i, sl_i] if shape == "gaussian" else [1.0, mu_i, sl_i, sr_i]
        p = np.array(p)
        basis = np.column_stack([_peak_values(tn, np.concatenate([[1.0], p[i * k + 1:(i + 1) * k]]), shape) for i in range(n)])
        heights, _ = nnls(basis, np.clip(yn, 0, None))
        for i in range(n):
            p[i * k] = max(heights[i], 0.02)
        return p

    guided = any(g.mu_bounds for g in guesses)
    shifts = (0.0, -0.5, 0.5) if guided else (0.0,)
    sol = None
    for shift in shifts:
        try:
            cand = least_squares(resid, start(shift), bounds=(lo_a, hi_a), x_scale="jac", max_nfev=4000)
        except ValueError as exc:
            raise DeconvError(f"ajuste falhou: {exc}") from exc
        if sol is None or cand.cost < sol.cost:
            sol = cand

    p = sol.x
    rn = sol.fun
    dof = max(len(yn) - len(p), 1)
    s2 = float(rn @ rn) / dof
    try:
        col = np.linalg.norm(sol.jac, axis=0)
        col[col == 0] = 1.0
        js = sol.jac / col
        cov_n = (np.linalg.pinv(js.T @ js) / np.outer(col, col)) * s2
    except np.linalg.LinAlgError:
        cov_n = np.full((len(p), len(p)), np.nan)

    # de volta às unidades reais: h·ys, μ·ts + t0, σ·ts
    scale = np.ones(len(p))
    for i in range(n):
        scale[i * k] = ys
        scale[i * k + 1:i * k + k] = ts
    cov = cov_n * np.outer(scale, scale)
    real = p * scale
    for i in range(n):
        real[i * k + 1] += t0

    peaks: list[Peak] = []
    grads = np.zeros((n, len(p)))
    comps: list[np.ndarray] = []
    for i, g in enumerate(guesses):
        pi = real[i * k:(i + 1) * k]
        area, grad = _area_and_grad(pi, shape)
        grads[i, i * k:(i + 1) * k] = grad
        u = float(np.sqrt(max(grad @ cov[i * k:(i + 1) * k, i * k:(i + 1) * k] @ grad, 0.0)))
        sl = float(pi[2])
        sr = float(pi[2] if shape == "gaussian" else pi[3])
        at_bound = bool(np.any(np.isclose(p[i * k + 1:(i + 1) * k], np.array(lo[i * k + 1:(i + 1) * k]), rtol=1e-4))
                        or np.any(np.isclose(p[i * k + 1:(i + 1) * k], np.array(hi[i * k + 1:(i + 1) * k]), rtol=1e-4)))
        peaks.append(Peak(name=g.name, h=float(pi[0]), mu=float(pi[1]), sigma_l=sl, sigma_r=sr, area=float(area),
                          u_area=u, reference_id=g.reference_id, at_bound=at_bound and g.mu_bounds is not None))
        comps.append(_peak_values(t, pi, shape))

    cov_a = grads @ cov @ grads.T
    d = np.sqrt(np.clip(np.diag(cov_a), 1e-300, None))
    corr = cov_a / np.outer(d, d)

    fitted = sum(comps, np.zeros_like(t))
    res = y - fitted
    ss_res = float(res @ res)
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 1.0
    m = len(y)
    bic = m * math.log(max(ss_res / m, 1e-300)) + len(p) * math.log(m)

    order = sorted(range(n), key=lambda i: peaks[i].mu)
    peaks = [peaks[i] for i in order]
    comps = [comps[i] for i in order]
    corr = corr[np.ix_(order, order)]
    for i, pk in enumerate(peaks):
        if not pk.name:
            pk.name = f"G{i + 1}"

    warnings: list[str] = []
    if r2 < 0.98:
        warnings.append(f"ajuste fraco (R² {r2:.3f}) — mude o número de picos, a forma ou a janela")
    for i in range(n):
        for j in range(i + 1, n):
            # dois picos do mesmo material (ex.: núcleo + base do PEAD) somam
            # na mesma amostra virtual — a sobreposição entre eles não importa
            if base_name(peaks[i].name) == base_name(peaks[j].name):
                continue
            if abs(corr[i, j]) > _HIGH_CORRELATION:
                warnings.append(
                    f"{peaks[i].name} e {peaks[j].name} muito sobrepostos (correlação {corr[i, j]:.2f}) — "
                    "a divisão da área entre eles é incerta"
                )
    for pk in peaks:
        if pk.at_bound:
            warnings.append(f"{pk.name} ficou no limite da tolerância da referência — o pico pode ter se deslocado mais")
    if not sol.success:
        warnings.append("o ajuste não convergiu totalmente")

    return DeconvResult(
        shape=shape, peaks=peaks, t=t.tolist(), y=y.tolist(), fitted=fitted.tolist(),
        components=[c.tolist() for c in comps], r2=r2, rmse=math.sqrt(ss_res / m), bic=bic,
        area_correlation=corr.tolist(), warnings=warnings,
    )


# ------------------------------------------------------------------ molde do material puro

@dataclass
class Template:
    """Forma média de um material puro: densidade (área 1) em função de
    τ = t − centro, em segundos."""

    tau: list[float]
    density: list[float]

    def eval(self, t: np.ndarray, center: float, stretch: float) -> np.ndarray:
        # f(t) = (1/s)·T((t − c)/s): dilatar no tempo sem mudar a área
        tau = np.asarray(self.tau)
        dens = np.asarray(self.density)
        return np.interp((t - center) / stretch, tau, dens, left=0.0, right=0.0) / stretch


def build_template(curves: list[tuple[np.ndarray, np.ndarray, float]], step: float = 1.0) -> Template:
    """Média das curvas dos puros: cada uma (t, sinal − linha de base,
    centro) é normalizada para área 1 e alinhada pelo centro; a média vai
    para uma grade comum de τ (passo de 1 s), no trecho que todas cobrem."""
    if not curves:
        raise DeconvError("nenhuma curva para o molde")
    lo = max(float(t[0] - c) for t, _, c in curves)
    hi = min(float(t[-1] - c) for t, _, c in curves)
    if hi - lo < 10 * step:
        raise DeconvError("as janelas das corridas puras não se sobrepõem o suficiente para o molde")
    grid = np.arange(lo, hi + step / 2, step)
    stack = []
    for t, y, c in curves:
        area = float(np.trapezoid(y, t))
        if area <= 0:
            raise DeconvError("corrida pura sem sinal acima da linha de base")
        stack.append(np.interp(grid, t - c, y / area))
    dens = np.clip(np.mean(stack, axis=0), 0.0, None)
    dens /= float(np.trapezoid(dens, grid))  # área 1 de novo, no trecho comum
    return Template(tau=grid.tolist(), density=dens.tolist())


@dataclass
class TemplateGuess:
    name: str
    template: Template
    center: float  # s — centro de partida (o da referência)
    center_bounds: tuple[float, float]
    stretch_bounds: tuple[float, float] = (0.9, 1.1)
    reference_id: int | None = None


def _half_widths(t: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """Posição do máximo e meia-largura à meia altura de cada lado."""
    i = int(np.argmax(y))
    half = y[i] / 2
    left = i
    while left > 0 and y[left] > half:
        left -= 1
    right = i
    while right < len(y) - 1 and y[right] > half:
        right += 1
    return float(t[i]), float(t[i] - t[left]), float(t[right] - t[i])


def fit_templates(t_values, y_values, guesses: list[TemplateGuess]) -> DeconvResult:
    """y(t) ≈ Σ Aₖ·(1/sₖ)·Tₖ((t − cₖ)/sₖ): Aₖ = área do componente (o molde
    tem área 1), cₖ = posição, sₖ = dilatação. Mínimos quadrados não lineares
    com limites; alturas iniciais por NNLS e alguns pontos de partida."""
    if not guesses:
        raise DeconvError("nenhum componente para ajustar")
    t = np.asarray(t_values, dtype=float)
    y = np.asarray(y_values, dtype=float)
    n = len(guesses)
    if len(t) < 3 * n + 2:
        raise DeconvError("janela curta demais para tantos componentes")
    ys = float(np.max(np.abs(y))) or 1.0
    t0 = float(t[0])
    ts = float(t[-1] - t[0]) or 1.0
    yn = y / ys
    lo = np.zeros(3 * n)
    hi = np.zeros(3 * n)
    for i, g in enumerate(guesses):
        lo[3 * i:3 * i + 3] = [0.0, (g.center_bounds[0] - t0) / ts, g.stretch_bounds[0]]
        hi[3 * i:3 * i + 3] = [np.inf, (g.center_bounds[1] - t0) / ts, max(g.stretch_bounds[1], g.stretch_bounds[0] + 1e-6)]
        if hi[3 * i + 1] <= lo[3 * i + 1]:
            hi[3 * i + 1] = lo[3 * i + 1] + 1e-6

    def comp(p: np.ndarray, i: int) -> np.ndarray:
        a, c, sk = p[3 * i:3 * i + 3]
        return a * guesses[i].template.eval(t, c * ts + t0, sk) / ys

    def resid(p: np.ndarray) -> np.ndarray:
        return sum((comp(p, i) for i in range(n)), np.zeros_like(t)) - yn

    def start(shift: float) -> np.ndarray:
        p = np.zeros(3 * n)
        basis = []
        for i, g in enumerate(guesses):
            half = (hi[3 * i + 1] - lo[3 * i + 1]) / 2
            c = min(max((g.center - t0) / ts + shift * half, lo[3 * i + 1]), hi[3 * i + 1])
            p[3 * i + 1], p[3 * i + 2] = c, 1.0 if lo[3 * i + 2] <= 1.0 <= hi[3 * i + 2] else lo[3 * i + 2]
            basis.append(g.template.eval(t, c * ts + t0, p[3 * i + 2]) / ys)
        areas, _ = nnls(np.column_stack(basis), np.clip(yn, 0, None))
        for i in range(n):
            p[3 * i] = max(areas[i], 1e-9)
        return p

    sol = None
    for shift in (0.0, -0.5, 0.5):
        cand = least_squares(resid, start(shift), bounds=(lo, hi), x_scale="jac", max_nfev=4000)
        if sol is None or cand.cost < sol.cost:
            sol = cand
    p = sol.x
    rn = sol.fun
    dof = max(len(yn) - len(p), 1)
    s2 = float(rn @ rn) / dof
    # parâmetros em escalas muito diferentes (área ~10⁶, centro ~1): escala as
    # colunas do jacobiano antes de inverter, senão a pseudo-inversa descarta
    # a direção da área e a incerteza sai ~0
    jac = sol.jac
    col = np.linalg.norm(jac, axis=0)
    col[col == 0] = 1.0
    js = jac / col
    cov_n = (np.linalg.pinv(js.T @ js) / np.outer(col, col)) * s2
    # a área Aₖ já é parâmetro direto, em sinal × s (o modelo divide o molde
    # por ys junto com o sinal): var(Aₖ) = Cov[Aₖ, Aₖ]
    idx_a = [3 * i for i in range(n)]
    cov_a = cov_n[np.ix_(idx_a, idx_a)]
    d = np.sqrt(np.clip(np.diag(cov_a), 1e-300, None))
    corr = cov_a / np.outer(d, d)

    peaks: list[Peak] = []
    comps: list[np.ndarray] = []
    for i, g in enumerate(guesses):
        a, c, sk = p[3 * i:3 * i + 3]
        area = float(a)
        curve = comp(p, i) * ys
        mu, hl, hr = _half_widths(t, curve) if curve.max() > 0 else (float(c * ts + t0), 0.0, 0.0)
        k = math.sqrt(2 * math.log(2))
        at_bound = bool(np.isclose(p[3 * i + 1], lo[3 * i + 1], rtol=1e-4) or np.isclose(p[3 * i + 1], hi[3 * i + 1], rtol=1e-4)
                        or (hi[3 * i + 2] - lo[3 * i + 2] > 1e-5 and (np.isclose(sk, lo[3 * i + 2], rtol=1e-4) or np.isclose(sk, hi[3 * i + 2], rtol=1e-4))))
        peaks.append(Peak(name=g.name, h=float(curve.max()), mu=mu, sigma_l=hl / k, sigma_r=hr / k, area=area,
                          u_area=float(d[i]), reference_id=g.reference_id, at_bound=at_bound,
                          center=float(c * ts + t0), stretch=float(sk)))
        comps.append(curve)

    fitted = sum(comps, np.zeros_like(t))
    res = y - fitted
    ss_res = float(res @ res)
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 1.0
    m = len(y)
    bic = m * math.log(max(ss_res / m, 1e-300)) + len(p) * math.log(m)
    order = sorted(range(n), key=lambda i: peaks[i].mu)
    peaks = [peaks[i] for i in order]
    comps = [comps[i] for i in order]
    corr = corr[np.ix_(order, order)]
    warnings: list[str] = []
    if r2 < 0.98:
        warnings.append(f"ajuste fraco (R² {r2:.3f}) — confira a janela e os componentes da mistura")
    for i in range(n):
        for j in range(i + 1, n):
            if base_name(peaks[i].name) != base_name(peaks[j].name) and abs(corr[i, j]) > _HIGH_CORRELATION:
                warnings.append(
                    f"{peaks[i].name} e {peaks[j].name} muito sobrepostos (correlação {corr[i, j]:.2f}) — "
                    "a divisão da área entre eles é incerta"
                )
    for pk in peaks:
        if pk.at_bound:
            warnings.append(f"{pk.name} ficou no limite da tolerância — o pico pode ter se deslocado/alargado mais")
    if not sol.success:
        warnings.append("o ajuste não convergiu totalmente")
    return DeconvResult(
        shape="template", peaks=peaks, t=t.tolist(), y=y.tolist(), fitted=fitted.tolist(),
        components=[c.tolist() for c in comps], r2=r2, rmse=math.sqrt(ss_res / m), bic=bic,
        area_correlation=corr.tolist(), warnings=warnings,
    )
