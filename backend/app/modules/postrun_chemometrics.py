"""PCA e PLS das curvas de pirólise (pedido do usuário, 17/11/2026).

Cada corrida vira uma LINHA da matriz X, cada temperatura uma COLUNA (grade
comum, interpolada). Depois do pré-tratamento:

- **PCA** (SVD da X centrada): X = T·Pᵀ + E — scores T, loadings P (lidos
  como curvas × temperatura), variância explicada, T² de Hotelling e resíduo
  Q, com os limites de 95 % (F para T²; Jackson–Mudholkar para Q).
- **PLS1** (NIPALS, uma propriedade por vez — ex.: a massa de um polímero):
  pesos W, scores T, loadings P e Q, vetor de regressão b = W(PᵀW)⁻¹Q, VIP;
  validação cruzada por GRUPO (as réplicas de uma composição saem juntas,
  senão o erro fica otimista) e escolha do número de variáveis latentes pela
  parcimônia: a menor com RMSECV ≤ 1,05 × o mínimo.

Só numpy/scipy, sem estado: conferido nos testes
(`tests/test_postrun_chemometrics.py`) contra cálculos independentes
(autovalores da covariância, pseudoinversa) e contra exemplos de brinquedo
calculados à parte.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import stats
from scipy.signal import savgol_filter

NORMALIZATIONS = ("none", "mass", "area", "max")


class ChemometricsError(ValueError):
    pass


# --------------------------------------------------------------- a matriz X

def monotonic(temps: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Só os pontos em que a temperatura SOBE (patamar isotérmico e ruído do
    termopar deixariam a interpolação ambígua)."""
    temps = np.asarray(temps, dtype=float)
    y = np.asarray(y, dtype=float)
    keep = [0]
    for i in range(1, len(temps)):
        if temps[i] > temps[keep[-1]]:
            keep.append(i)
    return temps[keep], y[keep]


def common_range(curves: list[tuple[np.ndarray, np.ndarray]]) -> tuple[float, float]:
    """A faixa que TODAS as corridas cobrem (interseção das janelas)."""
    lo = max(float(t[0]) for t, _ in curves)
    hi = min(float(t[-1]) for t, _ in curves)
    return lo, hi


def to_grid(curves: list[tuple[np.ndarray, np.ndarray]], t_min: float, t_max: float,
            step: float = 1.0, pad_zero: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Interpola cada curva (temperatura, sinal) na mesma grade → X (n × p).
    `pad_zero`: fora da janela da curva, zero (o sinal já está sem a linha de
    base); senão, o valor da ponta."""
    if step <= 0:
        raise ChemometricsError("passo da grade deve ser positivo")
    if t_max - t_min < 10 * step:
        raise ChemometricsError(f"faixa de temperatura comum curta demais ({t_min:.0f}–{t_max:.0f} °C)")
    grid = np.arange(t_min, t_max + step * 1e-9, step)
    X = np.vstack([np.interp(grid, t, y, left=0.0, right=0.0) if pad_zero else np.interp(grid, t, y) for t, y in curves])
    return grid, X


@dataclass
class Prep:
    normalize: str = "area"  # none | mass | area | max
    derivative: int = 0  # 0, 1 ou 2 (Savitzky–Golay)
    window_c: float = 15.0  # janela da derivada (°C)
    align: bool = False  # desloca cada curva para o máximo cair na mediana


def tmax_of(grid: np.ndarray, y: np.ndarray) -> float:
    win = min(11, len(y) - (1 - len(y) % 2))
    smooth = savgol_filter(y, win, 3) if win >= 5 else y
    return float(grid[int(np.argmax(smooth))])


def preprocess(grid: np.ndarray, X: np.ndarray, masses: np.ndarray | None, prep: Prep) -> tuple[np.ndarray, list[float]]:
    """Normalização → alinhamento → derivada. Devolve X tratada e o
    deslocamento aplicado a cada corrida (°C; zeros sem alinhamento)."""
    Xs, shifts = preprocess_blocks(grid, [X], masses, prep)
    return Xs[0], shifts


def preprocess_blocks(grid: np.ndarray, Xs: list[np.ndarray], masses: np.ndarray | None,
                      prep: Prep) -> tuple[list[np.ndarray], list[float]]:
    """O mesmo para vários blocos (um por detector, PCA multibloco): a
    normalização (área ou altura) e o alinhamento saem do 1º bloco e valem
    para todos — a proporção entre os detectores de uma corrida se mantém;
    a derivada é de cada bloco, sem atravessar a fronteira entre eles."""
    if prep.normalize not in NORMALIZATIONS:
        raise ChemometricsError(f"normalização inválida: {prep.normalize}")
    if prep.derivative not in (0, 1, 2):
        raise ChemometricsError("derivada deve ser 0, 1 ou 2")
    Xs = [np.array(X, dtype=float) for X in Xs]
    first = Xs[0]
    factor = None
    if prep.normalize == "mass":
        if masses is None or np.any(~np.isfinite(masses)) or np.any(masses <= 0):
            raise ChemometricsError("normalizar pela massa exige a massa de todas as corridas")
        factor = masses
    elif prep.normalize == "area":
        factor = np.trapezoid(first, grid, axis=1) if hasattr(np, "trapezoid") else np.trapz(first, grid, axis=1)
        if np.any(factor <= 0):
            raise ChemometricsError("alguma corrida tem área ≤ 0 na faixa — não dá para normalizar pela área")
    elif prep.normalize == "max":
        factor = first.max(axis=1)
        if np.any(factor <= 0):
            raise ChemometricsError("alguma corrida não tem sinal positivo na faixa")
    if factor is not None:
        Xs = [X / factor[:, None] for X in Xs]
    shifts = [0.0] * len(first)
    if prep.align:
        tm = np.array([tmax_of(grid, row) for row in Xs[0]])
        ref = float(np.median(tm))
        for i in range(len(first)):
            d = float(tm[i] - ref)
            shifts[i] = -d
            for X in Xs:
                X[i] = np.interp(grid + d, grid, X[i], left=X[i][0], right=X[i][-1])
    if prep.derivative:
        step = float(grid[1] - grid[0])
        win = max(5, int(round(prep.window_c / step)) | 1)
        if win >= first.shape[1]:
            raise ChemometricsError("janela da derivada maior que a faixa")
        Xs = [savgol_filter(X, win, 2, deriv=prep.derivative, delta=step, axis=1) for X in Xs]
    return Xs, shifts


def block_scale(Xs: list[np.ndarray], weights: list[float], eps: float = 1e-12) -> tuple[list[np.ndarray], list[float], list[bool]]:
    """Escalonamento por bloco (Westerhuis, Kourti e MacGregor, 1998): cada
    bloco dividido pela raiz da sua variância total (centrada) e multiplicado
    pelo peso — sem isso, o detector de números maiores manda na PCA. Bloco
    sem variância (ex.: SO2 sem sinal) fica com peso 0 em vez de virar NaN.
    Devolve os blocos SEM centrar (a PCA centra)."""
    out, scales, empty = [], [], []
    for X, w in zip(Xs, weights):
        Xc = X - X.mean(axis=0)
        sc = float(np.sqrt(Xc.var(axis=0).sum()))
        scales.append(sc)
        empty.append(sc < eps)
        out.append(X * (0.0 if sc < eps else w / sc))
    return out, scales, empty


def block_residuals(X: np.ndarray, res: "PCAResult", K: int, alpha: float = 0.95) -> tuple[np.ndarray, list[float | None]]:
    """Q de cada bloco (onde a corrida foge do modelo: em qual detector) e o
    limite de 95 % de cada um (aproximação de Box: g·χ²(h), g = var/2média,
    h = 2média²/var dos Q do próprio conjunto)."""
    E = (X - res.mean) - res.scores @ res.loadings.T
    L = E.shape[1] // K
    Qb = np.stack([np.sum(E[:, k * L:(k + 1) * L] ** 2, axis=1) for k in range(K)], axis=1)
    lims: list[float | None] = []
    for k in range(K):
        q = Qb[:, k]
        m, v = float(q.mean()), float(q.var(ddof=1)) if len(q) > 1 else 0.0
        lims.append(float(v / (2 * m) * stats.chi2.ppf(alpha, 2 * m * m / v)) if m > 0 and v > 0 else None)
    return Qb, lims


# --------------------------------------------------------------------- PCA

@dataclass
class PCAResult:
    mean: np.ndarray
    scores: np.ndarray  # n × k
    loadings: np.ndarray  # p × k (colunas unitárias)
    eigenvalues: np.ndarray  # todos (variância de cada PC)
    explained: np.ndarray  # fração de cada PC (todos)
    t2: np.ndarray
    q: np.ndarray
    t2_limit: float | None
    q_limit: float | None


def _orient(v: np.ndarray) -> np.ndarray:
    """Sinal de cada componente fixado (o maior |valor| positivo): SVD dá ±,
    e a figura não pode virar de cabeça para baixo a cada cálculo."""
    v = v.copy()
    for k in range(v.shape[1]):
        if v[int(np.argmax(np.abs(v[:, k]))), k] < 0:
            v[:, k] *= -1
    return v


def pca(X: np.ndarray, n_comp: int, alpha: float = 0.95) -> PCAResult:
    n, p = X.shape
    if n < 3:
        raise ChemometricsError("PCA precisa de pelo menos 3 corridas")
    mean = X.mean(axis=0)
    Xc = X - mean
    _u, s, vt = np.linalg.svd(Xc, full_matrices=False)
    eig = s ** 2 / (n - 1)
    total = float(eig.sum())
    if total <= 0:
        raise ChemometricsError("as curvas são todas iguais — não há variância para a PCA")
    k = max(1, min(n_comp, len(s), n - 1))
    P = _orient(vt[:k].T)
    T = Xc @ P
    E = Xc - T @ P.T
    lam = eig[:k]
    t2 = np.sum(T ** 2 / np.where(lam > 0, lam, np.inf), axis=1)
    q = np.sum(E ** 2, axis=1)
    t2_lim = None
    if n - k > 0:
        t2_lim = float(k * (n - 1) / (n - k) * stats.f.ppf(alpha, k, n - k))
    q_lim = _q_limit(eig[k:], alpha)
    return PCAResult(mean=mean, scores=T, loadings=P, eigenvalues=eig, explained=eig / total,
                     t2=t2, q=q, t2_limit=t2_lim, q_limit=q_lim)


def _q_limit(rest: np.ndarray, alpha: float) -> float | None:
    """Limite do resíduo Q (Jackson & Mudholkar, 1979) pelos autovalores
    que ficaram de fora do modelo."""
    th1, th2, th3 = (float(np.sum(rest ** i)) for i in (1, 2, 3))
    if th1 <= 0 or th2 <= 0:
        return None
    h0 = 1 - 2 * th1 * th3 / (3 * th2 ** 2)
    if h0 <= 0:
        return None
    z = stats.norm.ppf(alpha)
    base = z * np.sqrt(2 * th2 * h0 ** 2) / th1 + 1 + th2 * h0 * (h0 - 1) / th1 ** 2
    return float(th1 * base ** (1 / h0)) if base > 0 else None


# --------------------------------------------------------------------- PLS

@dataclass
class PLSModel:
    x_mean: np.ndarray
    y_mean: float
    W: np.ndarray  # p × a
    P: np.ndarray  # p × a
    q: np.ndarray  # a
    T: np.ndarray  # n × a
    b: np.ndarray  # p (coeficiente por temperatura)
    b0: float

    def predict(self, X: np.ndarray) -> np.ndarray:
        return X @ self.b + self.b0


def pls1(X: np.ndarray, y: np.ndarray, n_lv: int) -> PLSModel:
    """PLS1 por NIPALS (Geladi & Kowalski, 1986), X e y centrados."""
    n, p = X.shape
    a = max(1, min(n_lv, n - 1, p))
    xm = X.mean(axis=0)
    ym = float(np.mean(y))
    Xr = X - xm
    yr = np.asarray(y, dtype=float) - ym
    W = np.zeros((p, a))
    P = np.zeros((p, a))
    T = np.zeros((n, a))
    q = np.zeros(a)
    used = 0
    for k in range(a):
        w = Xr.T @ yr
        nw = float(np.linalg.norm(w))
        if nw < 1e-12:
            break  # nada mais de y para explicar
        w /= nw
        t = Xr @ w
        tt = float(t @ t)
        if tt < 1e-18:
            break
        P[:, k] = Xr.T @ t / tt
        q[k] = float(yr @ t) / tt
        W[:, k], T[:, k] = w, t
        Xr = Xr - np.outer(t, P[:, k])
        yr = yr - q[k] * t
        used = k + 1
    if used == 0:
        raise ChemometricsError("y não varia (ou X não tem relação nenhuma com y)")
    W, P, T, q = W[:, :used], P[:, :used], T[:, :used], q[:used]
    b = W @ np.linalg.solve(P.T @ W, q)
    return PLSModel(x_mean=xm, y_mean=ym, W=W, P=P, q=q, T=T, b=b, b0=float(ym - xm @ b))


def vip(model: PLSModel) -> np.ndarray:
    """Importância de cada variável na projeção (VIP > 1 = importante)."""
    p, a = model.W.shape
    ss = (model.q ** 2) * np.sum(model.T ** 2, axis=0)  # y explicada por LV
    if float(ss.sum()) <= 0:
        return np.zeros(p)
    wn = model.W / np.linalg.norm(model.W, axis=0)
    return np.sqrt(p * (wn ** 2 @ ss) / ss.sum())


@dataclass
class PLSCV:
    rmsec: list[float]
    rmsecv: list[float]
    chosen: int
    cv_pred: np.ndarray  # previsões de validação cruzada com `chosen` LVs
    fit_pred: np.ndarray
    model: PLSModel
    r2_cal: float | None
    q2: float | None
    n_groups: int = 0
    notes: list[str] = field(default_factory=list)


def _rmse(e: np.ndarray) -> float:
    return float(np.sqrt(np.mean(e ** 2)))


def pls_cv(X: np.ndarray, y: np.ndarray, groups: list[str], max_lv: int = 8,
           n_lv: int | None = None) -> PLSCV:
    """Validação cruzada deixando um GRUPO de fora (todas as réplicas de uma
    composição saem juntas). `n_lv` fixa o número de LVs; senão, parcimônia:
    a menor quantidade com RMSECV ≤ 1,05 × o mínimo."""
    y = np.asarray(y, dtype=float)
    n = len(y)
    keys = list(dict.fromkeys(groups))
    notes: list[str] = []
    if len(keys) < 3:
        raise ChemometricsError("a validação cruzada precisa de pelo menos 3 composições diferentes")
    if len(keys) < 6:
        notes.append(
            f"só {len(keys)} grupos na validação cruzada: tirar um deles (ex.: um puro) obriga o modelo a extrapolar — "
            "o erro sai pessimista; um planejamento com mais misturas resolve")
    # cada treino tem n − (maior grupo) corridas: as LVs não passam disso − 1
    biggest = max(groups.count(g) for g in keys)
    top = max(1, min(max_lv, n - biggest - 1, X.shape[1]))
    rmsec, rmsecv, preds = [], [], []
    for a in range(1, top + 1):
        full = pls1(X, y, a)
        rmsec.append(_rmse(full.predict(X) - y))
        pred = np.empty(n)
        for g in keys:
            out = np.array([gg == g for gg in groups])
            m = pls1(X[~out], y[~out], a)
            pred[out] = m.predict(X[out])
        preds.append(pred)
        rmsecv.append(_rmse(pred - y))
    if n_lv is not None:
        chosen = max(1, min(n_lv, top))
        if n_lv > top:
            notes.append(f"no máximo {top} variáveis latentes com estes dados")
    else:
        low = min(rmsecv)
        chosen = next(i + 1 for i, v in enumerate(rmsecv) if v <= low * 1.05 + 1e-12)
    model = pls1(X, y, chosen)
    fit = model.predict(X)
    ss = float(np.sum((y - y.mean()) ** 2))
    cvp = preds[chosen - 1]
    return PLSCV(
        rmsec=rmsec, rmsecv=rmsecv, chosen=chosen, cv_pred=cvp, fit_pred=fit, model=model,
        r2_cal=1 - float(np.sum((fit - y) ** 2)) / ss if ss > 0 else None,
        q2=1 - float(np.sum((cvp - y) ** 2)) / ss if ss > 0 else None,
        n_groups=len(keys), notes=notes,
    )
