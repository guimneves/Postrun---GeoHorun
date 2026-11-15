"""Deconvolução no PostRun (pedido do usuário, 16/10/2026) — rotas.

Fluxo pensado para os polímeros:

1. Corridas do material puro → deconvolução livre (1 pico, gaussiana ou
   assimétrica) → "Aplicar a todas" → Salvar → "Criar referência" (centro e
   largura médios).
2. Misturas → deconvolução guiada pelas referências da composição, com
   tolerância no centro (°C) e na largura (%) → Salvar.
3. Cada pico salvo é uma "amostra virtual" (análise + material): entra nas
   curvas de calibração (`area_source="gaussian"`) e no quantificador.

Ajuste: `app.modules.postrun_deconv`. Nada é gravado em `/fit`; só em
`/save` (o botão Salvar), que reajusta no servidor com as mesmas escolhas.
"""

from __future__ import annotations

import json
import math
from pathlib import PurePosixPath
from datetime import datetime, timezone

import numpy as np
from scipy.signal import savgol_filter
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun import _check_region_token, _effective_mass, _read_analysis
from app.db.models import PostrunDeconvolution, PostrunDeconvReference, Role
from app.modules import postrun_b00, postrun_calc, postrun_deconv, postrun_timebase

router = APIRouter(prefix="/postrun/deconvolution", tags=["postrun"])

MODES = ("free", "guided", "template")
METHODS = ("gauss", "molde")


def method_of(mode: str) -> str:
    """Livre e guiada dão áreas de gaussianas ("gauss"); o molde, "molde".
    Cada análise guarda uma deconvolução de cada método."""
    return "molde" if mode == "template" else "gauss"


def check_method(method: str) -> str:
    if method not in METHODS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Método inválido: {method} (use gauss ou molde)")
    return method


def saved_row(session, token: str, channel: str, method: str = "gauss") -> PostrunDeconvolution | None:
    return session.exec(
        select(PostrunDeconvolution).where(
            PostrunDeconvolution.token == token, PostrunDeconvolution.channel == channel,
            PostrunDeconvolution.method == method,
        )
    ).first()
_MAX_PEAKS = 8


# ---------------------------------------------------------------- schemas

class DeconvSpecIn(BaseModel):
    token: str
    channel: str = "pyro:FID"
    start_idx: int
    end_idx: int
    baseline_mode: str = "fixed"
    fixed_baseline: float = 0.0
    shape: str = "gaussian"
    mode: str = "free"
    n_peaks: int = 1
    reference_ids: list[int] = []
    tol_c: float = 10.0
    tol_width_pct: float = 30.0
    names: list[str] = []
    guesses_c: list[float] = []


class DeconvPeakOut(BaseModel):
    name: str
    material: str
    h: float
    mu_s: float
    mu_c: float | None
    sigma_l_s: float
    sigma_r_s: float
    fwhm_s: float
    area_s: float
    u_area_s: float
    pct_of_total: float
    reference_id: int | None = None
    ref_mu_c: float | None = None
    delta_mu_c: float | None = None
    delta_width_pct: float | None = None
    at_bound: bool = False
    # modo molde: centro do molde (s) e dilatação (1 = mesma largura do puro)
    center_s: float | None = None
    stretch: float | None = None
    # largura à meia altura (°C): do componente na mistura e do molde do puro
    fwhm_c: float | None = None
    pure_fwhm_c: float | None = None


class DeconvCurveOut(BaseModel):
    """Para desenhar: valores alinhados aos índices da janela."""

    idx: list[int]
    signal: list[float]  # sinal − linha de base
    fitted: list[float]
    components: list[list[float]]
    # modo molde (24/10/2026): o molde do PURO de cada componente (dilatação 1,
    # na posição da referência) com a MESMA área — para ver o deslocamento e o
    # alargamento — e a temperatura de cada ponto (°C)
    pure_components: list[list[float]] = []
    temps: list[float] = []


class DeconvOut(BaseModel):
    id: int | None = None
    spec: DeconvSpecIn
    cycle_key: str
    cycle_label: str
    seconds_per_point: float
    peaks: list[DeconvPeakOut]
    total_area_s: float
    window_area_s: float  # área integrada da janela (para comparar com a soma dos picos)
    r2: float
    rmse: float
    bic: float
    area_correlation: list[list[float]]
    warnings: list[str]
    curve: DeconvCurveOut | None = None
    updated_at: datetime | None = None
    method: str = "gauss"


class DeconvFitIn(BaseModel):
    items: list[DeconvSpecIn]


class DeconvFitItemOut(BaseModel):
    token: str
    ok: bool
    error: str | None = None
    data: DeconvOut | None = None


class DeconvSaveIn(BaseModel):
    upserts: list[DeconvSpecIn] = []
    delete_ids: list[int] = []


class RefPeakOut(BaseModel):
    mu_s: float
    mu_c: float | None
    sigma_l_s: float
    sigma_r_s: float
    sd_mu_c: float | None = None
    sd_sigma_pct: float | None = None


class ReferenceIn(BaseModel):
    name: str
    channel: str = "pyro:FID"
    tokens: list[str]
    notes: str = ""


class ReferenceOut(BaseModel):
    id: int
    name: str
    channel: str
    cycle_key: str
    cycle_label: str
    shape: str
    peaks: list[RefPeakOut]
    n_runs: int
    tokens: list[str]
    notes: str
    created_at: datetime
    has_template: bool = False
    excluded: list[str] = []  # corridas tiradas pelo usuário


class RefRunOut(BaseModel):
    """Uma corrida pura da referência, para ver se ela segue o molde."""

    token: str
    sample: str = ""
    # para reconhecer a corrida (pedido do usuário: só a amostra não basta)
    filename: str = ""  # nome da análise (.B00)
    job: str = ""
    mass_mg: float | None = None
    date: datetime | None = None
    ok: bool = True
    error: str | None = None
    max_c: float | None = None  # temperatura do máximo do sinal (°C)
    area_s: float | None = None  # área na janela (sinal·s)
    fwhm_s: float | None = None  # largura à meia altura (s)
    # largura desta corrida ÷ largura do molde: a "dilatação natural"
    stretch: float | None = None
    # quanto a forma difere do molde: RMS da diferença ÷ altura do molde (%)
    rms_pct: float | None = None
    density: list[float] = []  # forma normalizada (área 1) na grade do molde


class ReferenceDetailOut(BaseModel):
    reference: ReferenceOut
    tau: list[float] = []  # s, relativo ao máximo de cada corrida
    mold: list[float] = []  # molde (média, área 1)
    sd: list[float] = []  # desvio-padrão entre as corridas, ponto a ponto
    center_s: float | None = None  # tempo médio do máximo (s) — para comparar moldes
    max_c: float | None = None
    mold_fwhm_s: float | None = None
    runs: list[RefRunOut] = []


# ------------------------------------------------------------------ cálculo

def material_of(name: str) -> str:
    """"PS" → PS; "PS-2" (2º pico de uma referência de 2 picos) → PS."""
    return postrun_deconv.base_name(name)


def _validate(spec: DeconvSpecIn) -> None:
    if spec.shape not in postrun_deconv.SHAPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Forma inválida: {spec.shape}")
    if spec.mode not in MODES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Modo inválido: {spec.mode}")
    if spec.baseline_mode not in ("fixed", "linear"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Baseline inválida: {spec.baseline_mode}")
    if spec.mode == "free" and not 1 <= spec.n_peaks <= _MAX_PEAKS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Número de picos entre 1 e {_MAX_PEAKS}")
    if spec.mode in ("guided", "template") and not spec.reference_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Escolha as referências dos materiais")
    if spec.tol_c < 0 or spec.tol_width_pct < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tolerâncias não podem ser negativas")


def _time_at_temp(t: np.ndarray, temp: np.ndarray, value_c: float) -> float:
    """Primeiro instante da janela em que a temperatura atinge `value_c`."""
    above = np.nonzero(temp >= value_c)[0]
    return float(t[above[0]]) if above.size else float(t[-1])


def _window(analysis: postrun_b00.B00Analysis, spec: DeconvSpecIn):
    curve_name, ch = spec.channel.split(":", 1) if ":" in spec.channel else ("", "")
    curve = analysis.pyro if curve_name == "pyro" else analysis.oxi if curve_name == "oxi" else None
    if curve is None or ch not in curve.channels:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"canal {spec.channel} não encontrado nessa análise")
    try:
        xs, _ys, corrected = postrun_calc.baseline_corrected(
            curve.idx, curve.channels[ch], spec.start_idx, spec.end_idx, spec.baseline_mode,  # type: ignore[arg-type]
            spec.fixed_baseline,
        )
    except postrun_calc.RegionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    pos = {v: i for i, v in enumerate(curve.idx)}
    temps = [curve.temp[pos[x]] for x in xs]
    tb = postrun_timebase.time_base(analysis.pyro, analysis.header.cycle_pyro)
    t = np.asarray(xs, dtype=float) * tb.seconds_per_point
    return xs, np.asarray(corrected, dtype=float), t, np.asarray(temps, dtype=float), tb


def _references(session: SessionDep, ids: list[int], channel: str, cycle_key: str,
                ref_override: dict[int, PostrunDeconvReference] | None = None) -> list[PostrunDeconvReference]:
    # `ref_override`: referências montadas em memória (ex.: molde sem uma corrida, F8) no lugar das gravadas
    out = []
    for rid in ids:
        ref = (ref_override or {}).get(rid) or session.get(PostrunDeconvReference, rid)
        if ref is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Referência {rid} não encontrada")
        if ref.channel != channel:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"A referência {ref.name} é do canal {ref.channel}")
        if ref.cycle_key != cycle_key:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"A referência {ref.name} é de outro ciclo ({ref.cycle_label}) — referências valem para um ciclo só",
            )
        out.append(ref)
    return out


def _peak_values(t: np.ndarray, pk: dict, shape: str) -> np.ndarray:
    mu, h = pk["mu_s"], pk["h"]
    s = np.where(t < mu, pk["sigma_l_s"], pk["sigma_r_s"]) if shape == "bigaussian" else pk["sigma_l_s"]
    return h * np.exp(-0.5 * ((t - mu) / s) ** 2)


def _compute(session: SessionDep, spec: DeconvSpecIn,
             ref_override: dict[int, PostrunDeconvReference] | None = None,
             y_override: np.ndarray | None = None) -> DeconvOut:
    # `y_override`: sinal substituto na mesma janela (bootstrap dos resíduos, F9)
    _validate(spec)
    _check_region_token(session, spec.token)
    try:
        analysis = _read_analysis(session, spec.token)
    except postrun_b00.B00ParseError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    xs, y, t, temps, tb = _window(analysis, spec)
    if y_override is not None:
        if len(y_override) != len(y):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "sinal substituto com tamanho diferente da janela")
        y = np.asarray(y_override, dtype=float)
    rate_c_per_s = (analysis.header.cycle_pyro.rate / 60.0) if analysis.header.cycle_pyro else 25 / 60.0

    refs: dict[int, PostrunDeconvReference] = {}
    if spec.mode == "template":
        return _compute_template(session, spec, analysis, xs, y, t, temps, tb, rate_c_per_s, ref_override)
    if spec.mode == "guided":
        guesses: list[postrun_deconv.PeakGuess] = []
        for ref in _references(session, spec.reference_ids, spec.channel, analysis.header.cycle_key, ref_override):
            refs[ref.id] = ref
            ref_peaks = json.loads(ref.peaks or "[]")
            for i, rp in enumerate(ref_peaks):
                tol_s = max(spec.tol_c / rate_c_per_s, 1e-3 * tb.seconds_per_point)
                sig = (rp["sigma_l_s"] + rp["sigma_r_s"]) / 2
                tw = max(spec.tol_width_pct / 100.0, 1e-4)
                guesses.append(postrun_deconv.PeakGuess(
                    mu=rp["mu_s"], sigma=rp["sigma_l_s"] if spec.shape == "bigaussian" else sig, sigma_r=rp["sigma_r_s"],
                    name=ref.name if len(ref_peaks) == 1 else f"{ref.name}-{i + 1}",
                    mu_bounds=(rp["mu_s"] - tol_s, rp["mu_s"] + tol_s),
                    sigma_bounds=(rp["sigma_l_s"] * (1 - tw), rp["sigma_l_s"] * (1 + tw))
                    if spec.shape == "bigaussian" else (sig * (1 - tw), sig * (1 + tw)),
                    sigma_r_bounds=(rp["sigma_r_s"] * (1 - tw), rp["sigma_r_s"] * (1 + tw)),
                    reference_id=ref.id, ref_mu=rp["mu_s"], ref_sigma=sig,
                ))
    elif spec.guesses_c:
        sigma0 = max(3 * tb.seconds_per_point, float(t[-1] - t[0]) / (6 * len(spec.guesses_c)))
        guesses = [postrun_deconv.PeakGuess(mu=_time_at_temp(t, temps, c), sigma=sigma0) for c in spec.guesses_c]
    else:
        try:
            guesses = postrun_deconv.auto_guesses(t, y, spec.n_peaks)
        except postrun_deconv.DeconvError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    try:
        res = postrun_deconv.fit(t, y, guesses, spec.shape)
    except postrun_deconv.DeconvError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    if spec.mode == "free" and spec.names:
        for pk, name in zip(res.peaks, spec.names):
            if name.strip():
                pk.name = name.strip().upper()

    guess_by_name = {g.name: g for g in guesses}
    total = res.total_area or 1.0
    peaks: list[DeconvPeakOut] = []
    for pk in res.peaks:
        mu_c = float(np.interp(pk.mu, t, temps))
        g = guess_by_name.get(pk.name)
        ref_mu_c = delta_mu = delta_w = None
        if g is not None and g.ref_mu is not None:
            ref_mu_c = float(np.interp(g.ref_mu, t, temps))
            delta_mu = mu_c - ref_mu_c
            delta_w = 100.0 * (pk.sigma / g.ref_sigma - 1) if g.ref_sigma else None
        peaks.append(DeconvPeakOut(
            name=pk.name, material=material_of(pk.name), h=pk.h, mu_s=pk.mu, mu_c=mu_c, sigma_l_s=pk.sigma_l,
            sigma_r_s=pk.sigma_r, fwhm_s=pk.fwhm, area_s=pk.area, u_area_s=pk.u_area,
            pct_of_total=100.0 * pk.area / total, reference_id=pk.reference_id, ref_mu_c=ref_mu_c,
            delta_mu_c=delta_mu, delta_width_pct=delta_w, at_bound=pk.at_bound,
        ))

    window_area = float(np.trapezoid(y, t)) if len(t) > 1 else 0.0
    return DeconvOut(
        spec=spec, cycle_key=analysis.header.cycle_key, cycle_label=analysis.header.cycle_label,
        seconds_per_point=tb.seconds_per_point, peaks=peaks, total_area_s=res.total_area,
        window_area_s=window_area, r2=res.r2, rmse=res.rmse, bic=res.bic,
        area_correlation=res.area_correlation, warnings=res.warnings,
        curve=DeconvCurveOut(idx=list(xs), signal=res.y, fitted=res.fitted, components=res.components),
    )


def _template_of(ref: PostrunDeconvReference) -> tuple[postrun_deconv.Template, dict]:
    data = json.loads(ref.template or "{}")
    if not data.get("tau"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"A referência {ref.name} foi criada antes do molde — apague e crie de novo (as deconvoluções salvas dos puros bastam)",
        )
    return postrun_deconv.Template(tau=data["tau"], density=data["density"]), data


def _compute_template(session, spec, analysis, xs, y, t, temps, tb, rate_c_per_s, ref_override=None) -> DeconvOut:
    """Modo "Molde do material puro": cada componente = a curva média do puro
    (área 1), com área, centro (± tol °C) e dilatação (± tol %) livres."""
    guesses: list[postrun_deconv.TemplateGuess] = []
    meta: dict[int, dict] = {}
    for ref in _references(session, spec.reference_ids, spec.channel, analysis.header.cycle_key, ref_override):
        tpl, data = _template_of(ref)
        tol_s = max(spec.tol_c / rate_c_per_s, 1e-3)
        tw = spec.tol_width_pct / 100.0
        c0 = float(data["center_s"])
        guesses.append(postrun_deconv.TemplateGuess(
            name=ref.name, template=tpl, center=c0, center_bounds=(c0 - tol_s, c0 + tol_s),
            stretch_bounds=(max(1 - tw, 0.2), 1 + tw), reference_id=ref.id,
        ))
        meta[ref.id] = data
    try:
        res = postrun_deconv.fit_templates(t, y, guesses)
    except postrun_deconv.DeconvError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    total = res.total_area or 1.0
    peaks: list[DeconvPeakOut] = []
    for pk in res.peaks:
        data = meta.get(pk.reference_id or -1, {})
        mu_c = float(np.interp(pk.mu, t, temps))
        # máximo do puro: centro + posição do máximo no molde
        ref_max_s = float(data.get("center_s", pk.mu)) + float(data.get("tau_max", 0.0))
        ref_mu_c = data.get("max_c")
        if ref_mu_c is None:
            ref_mu_c = float(np.interp(ref_max_s, t, temps))
        peaks.append(DeconvPeakOut(
            name=pk.name, material=material_of(pk.name), h=pk.h, mu_s=pk.mu, mu_c=mu_c, sigma_l_s=pk.sigma_l,
            sigma_r_s=pk.sigma_r, fwhm_s=pk.fwhm, area_s=pk.area, u_area_s=pk.u_area,
            pct_of_total=100.0 * pk.area / total, reference_id=pk.reference_id, ref_mu_c=ref_mu_c,
            delta_mu_c=mu_c - ref_mu_c, delta_width_pct=100.0 * ((pk.stretch or 1.0) - 1.0), at_bound=pk.at_bound,
            center_s=pk.center, stretch=pk.stretch,
        ))
    window_area = float(np.trapezoid(y, t)) if len(t) > 1 else 0.0
    pure = _pure_overlay(session, peaks, t, np.asarray(temps, dtype=float), [np.asarray(c) for c in res.components])
    return DeconvOut(
        spec=spec, cycle_key=analysis.header.cycle_key, cycle_label=analysis.header.cycle_label,
        seconds_per_point=tb.seconds_per_point, peaks=peaks, total_area_s=res.total_area, window_area_s=window_area,
        r2=res.r2, rmse=res.rmse, bic=res.bic, area_correlation=res.area_correlation, warnings=res.warnings,
        curve=DeconvCurveOut(idx=list(xs), signal=res.y, fitted=res.fitted, components=res.components,
                             pure_components=pure, temps=[float(v) for v in temps]),
    )


def _fwhm_c(values: np.ndarray, temps: np.ndarray) -> float | None:
    """Largura à meia altura em °C, com interpolação linear nos dois lados."""
    if len(values) < 3 or float(np.max(values)) <= 0:
        return None
    i = int(np.argmax(values))
    half = float(values[i]) / 2
    left = i
    while left > 0 and values[left] > half:
        left -= 1
    right = i
    while right < len(values) - 1 and values[right] > half:
        right += 1
    if values[left] > half or values[right] > half:
        return None  # o pico não desce à meia altura dentro da janela

    def cross(a: int, b: int) -> float:
        va, vb = float(values[a]), float(values[b])
        f = (half - va) / (vb - va) if vb != va else 0.0
        return float(temps[a] + f * (temps[b] - temps[a]))

    return abs(cross(i, right) - cross(i, left)) if right > i and left < i else None


def _pure_overlay(session: SessionDep, peaks: list, t: np.ndarray, temps: np.ndarray, comps: list[np.ndarray]) -> list[list[float]]:
    """Molde do puro de cada componente (s = 1, centro da referência, mesma
    área) e as larguras (°C) do componente e do puro, gravadas nos picos."""
    out: list[list[float]] = []
    for p, comp in zip(peaks, comps):
        ref = session.get(PostrunDeconvReference, p.reference_id) if p.reference_id else None
        try:
            tpl, data = _template_of(ref) if ref is not None else (None, {})
        except HTTPException:
            tpl, data = None, {}
        if tpl is None:
            out.append([])
            continue
        pure = tpl.eval(t, float(data.get("center_s", p.center_s or p.mu_s)), 1.0) * p.area_s
        p.fwhm_c = _fwhm_c(np.asarray(comp), temps)
        p.pure_fwhm_c = _fwhm_c(pure, temps)
        out.append(pure.tolist())
    return out


def _from_row(session: SessionDep, row: PostrunDeconvolution, with_curve: bool = True) -> DeconvOut:
    """Deconvolução salva — curvas refeitas pelos parâmetros, sem reajustar."""
    spec = DeconvSpecIn(
        token=row.token, channel=row.channel, start_idx=row.start_idx, end_idx=row.end_idx,
        baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline, shape=row.shape, mode=row.mode,
        n_peaks=row.n_peaks, reference_ids=json.loads(row.reference_ids or "[]"), tol_c=row.tol_c,
        tol_width_pct=row.tol_width_pct, names=json.loads(row.names or "[]"), guesses_c=json.loads(row.guesses_c or "[]"),
    )
    data = json.loads(row.result or "{}")
    out = DeconvOut(spec=spec, curve=None, updated_at=row.updated_at, id=row.id, method=row.method or "gauss",
                    **{k: v for k, v in data.items() if k not in ("spec", "curve", "id", "updated_at", "method")})
    if with_curve:
        try:
            analysis = _read_analysis(session, row.token)
            xs, y, t, temps, _tb = _window(analysis, spec)
            if row.mode == "template":
                comps = []
                for p in out.peaks:
                    ref = session.get(PostrunDeconvReference, p.reference_id) if p.reference_id else None
                    tpl = _template_of(ref)[0] if ref is not None else None
                    comps.append(tpl.eval(t, p.center_s or p.mu_s, p.stretch or 1.0) * p.area_s if tpl else np.zeros_like(t))
            else:
                comps = [_peak_values(t, p.model_dump(), row.shape) for p in out.peaks]
            fitted = sum(comps, np.zeros_like(t))
            pure = _pure_overlay(session, out.peaks, t, np.asarray(temps, dtype=float), comps) if row.mode == "template" else []
            out.curve = DeconvCurveOut(idx=list(xs), signal=y.tolist(), fitted=fitted.tolist(),
                                       components=[c.tolist() for c in comps], pure_components=pure,
                                       temps=[float(v) for v in temps])
        except (HTTPException, postrun_b00.B00ParseError):
            out.curve = None
    return out


def saved_material_area(session: SessionDep, token: str, channel: str, material: str,
                        method: str = "gauss") -> tuple[float, float]:
    """Área (e incerteza) do material numa deconvolução salva — soma dos picos
    dele. Usada pelas curvas (`area_source="gaussian"`) e pelo quantificador."""
    row = saved_row(session, token, channel, method)
    if row is None:
        what = "por molde" if method == "molde" else "por gaussiana"
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"sem deconvolução {what} salva nessa análise")
    data = json.loads(row.result or "{}")
    peaks = data.get("peaks", [])
    mine_idx = [i for i, p in enumerate(peaks) if p.get("material") == material.strip().upper()]
    mine = [peaks[i] for i in mine_idx]
    if not mine:
        names = ", ".join(sorted({p.get("material", "") for p in peaks})) or "nenhum"
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"a deconvolução salva não tem pico de {material} (tem: {names})")
    u = postrun_deconv.material_area_u([p["u_area_s"] for p in mine], mine_idx, data.get("area_correlation"))
    return sum(p["area_s"] for p in mine), u


def _ref_out(r: PostrunDeconvReference) -> ReferenceOut:
    return ReferenceOut(
        id=r.id, name=r.name, channel=r.channel, cycle_key=r.cycle_key, cycle_label=r.cycle_label, shape=r.shape,
        peaks=[RefPeakOut(**p) for p in json.loads(r.peaks or "[]")], n_runs=r.n_runs,
        tokens=json.loads(r.tokens or "[]"), notes=r.notes, created_at=r.created_at,
        has_template=bool(r.template), excluded=json.loads(r.excluded or "[]"),
    )


# ------------------------------------------------------------------ rotas

@router.post("/fit", response_model=list[DeconvFitItemOut])
def fit_deconvolution(payload: DeconvFitIn, session: SessionDep, _user: CurrentUser):
    """Ajusta (sem gravar) — várias análises de uma vez ("Aplicar a todas")."""
    out: list[DeconvFitItemOut] = []
    for spec in payload.items:
        try:
            out.append(DeconvFitItemOut(token=spec.token, ok=True, data=_compute(session, spec)))
        except HTTPException as exc:
            out.append(DeconvFitItemOut(token=spec.token, ok=False, error=str(exc.detail)))
    return out


@router.get("", response_model=list[DeconvOut])
def list_deconvolutions(session: SessionDep, _user: CurrentUser, tokens: list[str] = Query(default=[]),
                        channel: str | None = None, method: str | None = None):
    query = select(PostrunDeconvolution)
    if method:
        query = query.where(PostrunDeconvolution.method == check_method(method))
    if tokens:
        query = query.where(PostrunDeconvolution.token.in_(tokens))
    if channel:
        query = query.where(PostrunDeconvolution.channel == channel)
    return [_from_row(session, r) for r in session.exec(query).all()]


@router.put("/save", response_model=list[DeconvOut])
def save_deconvolutions(payload: DeconvSaveIn, session: SessionDep, user: CurrentUser):
    """Botão Salvar: reajusta no servidor e grava (uma por análise + canal);
    apaga as marcadas. Uma falha cancela tudo."""
    results = []
    for spec in payload.upserts:
        try:
            results.append((spec, _compute(session, spec)))
        except HTTPException as exc:
            raise HTTPException(exc.status_code, f"{spec.token}: {exc.detail}") from exc
    for did in payload.delete_ids:
        row = session.get(PostrunDeconvolution, did)
        if row is not None:
            session.delete(row)
    saved: list[PostrunDeconvolution] = [
        persist(session, spec, res, user.id, skip_ids=set(payload.delete_ids)) for spec, res in results
    ]
    session.commit()
    for row in saved:
        session.refresh(row)
    return [_from_row(session, r) for r in saved]


def persist(session, spec: DeconvSpecIn, res: DeconvOut, user_id: int, skip_ids: set[int] = frozenset()) -> PostrunDeconvolution:
    """Grava (sem commit) a deconvolução de uma análise + canal + método."""
    method = method_of(spec.mode)
    row = saved_row(session, spec.token, spec.channel, method)
    if row is None or row.id in skip_ids:
        row = PostrunDeconvolution(token=spec.token, channel=spec.channel, method=method, start_idx=0, end_idx=0,
                                   created_by_id=user_id)
    row.start_idx, row.end_idx = spec.start_idx, spec.end_idx
    row.baseline_mode, row.fixed_baseline = spec.baseline_mode, spec.fixed_baseline
    row.shape, row.mode, row.n_peaks = spec.shape, spec.mode, spec.n_peaks
    row.reference_ids = json.dumps(spec.reference_ids)
    row.tol_c, row.tol_width_pct = spec.tol_c, spec.tol_width_pct
    row.names, row.guesses_c = json.dumps(spec.names), json.dumps(spec.guesses_c)
    row.result = json.dumps(res.model_dump(mode="json", exclude={"spec", "curve", "id", "updated_at", "method"}))
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    return row


@router.get("/references", response_model=list[ReferenceOut])
def list_references(session: SessionDep, _user: CurrentUser, channel: str | None = None):
    query = select(PostrunDeconvReference).order_by(PostrunDeconvReference.name)
    if channel:
        query = query.where(PostrunDeconvReference.channel == channel)
    return [_ref_out(r) for r in session.exec(query).all()]


@router.post("/references", response_model=ReferenceOut)
def create_reference(payload: ReferenceIn, session: SessionDep, user: CurrentUser):
    """Referência de um material puro: média do centro e da largura dos picos
    das deconvoluções SALVAS das análises escolhidas (mesmo número de picos,
    mesma forma, mesmo ciclo)."""
    name = payload.name.strip().upper()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dê o nome do material (ex.: PS)")
    parts = _reference_parts(session, payload.tokens, payload.channel)
    ref = PostrunDeconvReference(
        name=name, channel=payload.channel, notes=payload.notes, created_by_id=user.id, **parts,
    )
    session.add(ref)
    session.commit()
    session.refresh(ref)
    return _ref_out(ref)


class ReferenceRunsIn(BaseModel):
    tokens: list[str]


@router.put("/references/{ref_id}/runs", response_model=ReferenceOut)
def set_reference_runs(ref_id: int, payload: ReferenceRunsIn, session: SessionDep, user: CurrentUser):
    """Tirar (ou devolver) corridas de uma referência (pedido do usuário,
    16/10/2026): refaz centro, larguras e o molde só com as corridas que
    ficam — mesma referência (mesma id), então o que a usa continua ligado."""
    ref = session.get(PostrunDeconvReference, ref_id)
    if ref is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Referência não encontrada")
    if ref.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou a referência (ou um admin) pode alterá-la")
    keep = list(dict.fromkeys(payload.tokens))
    parts = _reference_parts(session, keep, ref.channel)
    if parts["cycle_key"] != ref.cycle_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Essas corridas são de outro ciclo")
    # lembra quem foi tirado (e esquece quem voltou)
    before = json.loads(ref.excluded or "[]") + json.loads(ref.tokens or "[]")
    ref.excluded = json.dumps([t for t in dict.fromkeys(before) if t not in keep])
    for k, v in parts.items():
        setattr(ref, k, v)
    session.add(ref)
    session.commit()
    session.refresh(ref)
    return _ref_out(ref)


def _reference_parts(session: SessionDep, tokens: list[str], channel: str) -> dict:
    """Centro, larguras e molde a partir das deconvoluções SALVAS das
    corridas escolhidas (mesmo número de picos, forma e ciclo)."""
    if not tokens:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Escolha as análises do material puro (pelo menos uma)")
    rows = []
    for token in tokens:
        row = saved_row(session, token, channel, "gauss")
        if row is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{token}: sem deconvolução salva — ajuste e salve antes")
        rows.append(row)
    datas = [json.loads(r.result or "{}") for r in rows]
    shapes = {r.shape for r in rows}
    cycles = {d.get("cycle_key") for d in datas}
    counts = {len(d.get("peaks", [])) for d in datas}
    if len(shapes) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "As deconvoluções usam formas diferentes (gaussiana × assimétrica)")
    if len(cycles) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "As análises são de ciclos diferentes — uma referência vale para um ciclo")
    if len(counts) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "As deconvoluções têm números de picos diferentes")
    n = counts.pop()
    peaks = []
    for i in range(n):
        mus = np.array([d["peaks"][i]["mu_s"] for d in datas])
        muc = np.array([d["peaks"][i]["mu_c"] for d in datas], dtype=float)
        sl = np.array([d["peaks"][i]["sigma_l_s"] for d in datas])
        sr = np.array([d["peaks"][i]["sigma_r_s"] for d in datas])
        sig = (sl + sr) / 2
        peaks.append({
            "mu_s": float(mus.mean()), "mu_c": float(np.nanmean(muc)), "sigma_l_s": float(sl.mean()),
            "sigma_r_s": float(sr.mean()),
            "sd_mu_c": float(np.nanstd(muc, ddof=1)) if len(muc) > 1 else None,
            "sd_sigma_pct": float(100 * sig.std(ddof=1) / sig.mean()) if len(sig) > 1 and sig.mean() else None,
        })
    return {
        "cycle_key": datas[0].get("cycle_key", ""), "cycle_label": datas[0].get("cycle_label", ""),
        "shape": shapes.pop(), "peaks": json.dumps(peaks), "n_runs": len(rows), "tokens": json.dumps(tokens),
        "template": _build_reference_template(session, rows, datas),
    }


def _build_reference_template(session: SessionDep, rows: list[PostrunDeconvolution], datas: list[dict]) -> str:
    """Molde do material: o SINAL (não o ajuste) de cada corrida pura, na
    janela da deconvolução salva, normalizado para área 1 e alinhado pelo
    máximo do próprio sinal; a média vai para uma grade de 1 s. Do ajuste
    livre só vem a janela (e, para o modo Guiado, centro e larguras)."""
    runs = [r for r in _pure_runs(session, rows) if r["ok"]]
    curves = [(r["t"], r["y"], r["c"]) for r in runs]
    centers = [r["c"] for r in runs]
    max_c = [r["max_c"] for r in runs]
    if not curves:
        return ""
    try:
        tpl = postrun_deconv.build_template(curves, step=1.0)
    except postrun_deconv.DeconvError:
        return ""
    tau = np.asarray(tpl.tau)
    tau_max = float(tau[int(np.argmax(tpl.density))])
    return json.dumps({
        "tau": tpl.tau, "density": tpl.density, "center_s": float(np.mean(centers)),
        "max_c": float(np.mean(max_c)), "tau_max": tau_max,
    })


def _pure_runs(session: SessionDep, rows: list[PostrunDeconvolution]) -> list[dict]:
    """Sinal de cada corrida pura na janela da deconvolução salva, com o
    tempo do máximo do próprio sinal (suavizado) — a base do molde."""
    out = []
    for row in rows:
        rel = PurePosixPath(row.token)
        item: dict = {"token": row.token, "ok": False, "error": None, "sample": "", "filename": rel.name,
                      "job": rel.parts[0] if len(rel.parts) > 1 else "", "mass_mg": None, "date": None}
        out.append(item)
        spec = _from_row(session, row, with_curve=False).spec
        try:
            analysis = _read_analysis(session, row.token)
            _xs, y, t, temps, _tb = _window(analysis, spec)
        except HTTPException as exc:
            item["error"] = str(exc.detail)
            continue
        except postrun_b00.B00ParseError as exc:
            item["error"] = str(exc)
            continue
        item["sample"] = analysis.header.sample
        # a massa que vale (a corrigida na tela, se houver)
        item["mass_mg"] = _effective_mass(session, row.token, analysis.header.quantity_mg)
        item["date"] = analysis.header.date
        # alinhamento pelo MÁXIMO DO PRÓPRIO SINAL (suavizado), não pelo centro
        # da gaussiana ajustada: o molde não depende de forma suposta nenhuma
        # (pico assimétrico: o μ da gaussiana fica alguns segundos fora do topo)
        if len(y) < 5 or float(np.max(y)) <= 0:
            item["error"] = "sem sinal acima da linha de base na janela"
            continue
        win = min(11, len(y) - (1 - len(y) % 2))
        smooth = savgol_filter(y, win, 3) if win >= 5 else y
        c = float(t[int(np.argmax(smooth))])
        item.update(ok=True, t=t, y=y, c=c, max_c=float(np.interp(c, t, temps)))
    return out


_RUN_ID_KEYS = ("token", "sample", "filename", "job", "mass_mg", "date")


def _fwhm(x: np.ndarray, y: np.ndarray) -> float | None:
    if len(y) < 3 or float(np.max(y)) <= 0:
        return None
    # largura à meia altura com interpolação linear nos dois lados (sem o
    # degrau de 1 ponto, que daria dilatações de 1,1 % em 1,1 %)
    i = int(np.argmax(y))
    half = float(y[i]) / 2
    left = i
    while left > 0 and y[left] > half:
        left -= 1
    right = i
    while right < len(y) - 1 and y[right] > half:
        right += 1
    if y[left] > half or y[right] > half:
        return None  # o pico não desce à meia altura dentro da janela
    xl = x[left] + (half - y[left]) * (x[left + 1] - x[left]) / ((y[left + 1] - y[left]) or 1)
    xr = x[right - 1] + (half - y[right - 1]) * (x[right] - x[right - 1]) / ((y[right] - y[right - 1]) or 1)
    return float(xr - xl) or None


@router.get("/references/{ref_id}/detail", response_model=ReferenceDetailOut)
def reference_detail(ref_id: int, session: SessionDep, _user: CurrentUser):
    """Para ver a referência (pedido do usuário, 16/10/2026): o molde, a
    faixa ± desvio entre as corridas puras e cada corrida normalizada (área
    1, alinhada pelo máximo) — com a largura de cada uma em relação ao molde
    (a "dilatação natural") e o quanto a forma dela foge do molde."""
    ref = session.get(PostrunDeconvReference, ref_id)
    if ref is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Referência não encontrada")
    out = ReferenceDetailOut(reference=_ref_out(ref))
    data = json.loads(ref.template or "{}")
    tokens = json.loads(ref.tokens or "[]")
    rows = []
    for token in tokens:
        row = saved_row(session, token, ref.channel, "gauss")
        if row is None:
            rel = PurePosixPath(token)
            out.runs.append(RefRunOut(
                token=token, filename=rel.name, job=rel.parts[0] if len(rel.parts) > 1 else "",
                ok=False, error="a deconvolução salva desta corrida foi apagada",
            ))
        else:
            rows.append(row)
    runs = _pure_runs(session, rows)
    if data.get("tau"):
        tau = np.asarray(data["tau"], dtype=float)
        mold = np.asarray(data["density"], dtype=float)
        out.tau, out.mold = tau.tolist(), mold.tolist()
        out.center_s, out.max_c = data.get("center_s"), data.get("max_c")
        out.mold_fwhm_s = _fwhm(tau, mold)
    else:
        tau = mold = None
    stack = []
    for r in runs:
        if not r["ok"]:
            out.runs.append(RefRunOut(**{k: r[k] for k in _RUN_ID_KEYS}, ok=False, error=r["error"]))
            continue
        t, y, c = r["t"], r["y"], r["c"]
        area = float(np.trapezoid(y, t))
        run = RefRunOut(**{k: r[k] for k in _RUN_ID_KEYS}, max_c=r["max_c"], area_s=area, fwhm_s=_fwhm(t, y))
        if tau is not None and area > 0:
            dens = np.interp(tau, t - c, y / area, left=0.0, right=0.0)
            stack.append(dens)
            run.density = dens.tolist()
            peak = float(mold.max()) or 1.0
            run.rms_pct = float(100 * np.sqrt(np.mean((dens - mold) ** 2)) / peak)
            if run.fwhm_s and out.mold_fwhm_s:
                run.stretch = run.fwhm_s / out.mold_fwhm_s
        out.runs.append(run)
    if len(stack) > 1:
        out.sd = np.std(np.asarray(stack), axis=0, ddof=1).tolist()
    return out


@router.delete("/references/{ref_id}")
def delete_reference(ref_id: int, session: SessionDep, user: CurrentUser):
    ref = session.get(PostrunDeconvReference, ref_id)
    if ref is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Referência não encontrada")
    if ref.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou a referência (ou um admin) pode apagá-la")
    from app.api.routes_postrun_study import guard_delete

    guard_delete(session, "reference", ref_id, f"A referência {ref.name}")
    session.delete(ref)
    session.commit()
    return {"ok": True}
