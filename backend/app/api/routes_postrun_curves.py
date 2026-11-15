"""Curvas de calibração massa × área e quantificador do PostRun (pedido do
usuário, 16/10/2026): "usar os sinais do Rock-Eval para construir curvas de
calibração com as áreas dos sinais de cada amostra — massa × área — e usar
essas curvas para calcular a massa a partir da área de um pirograma".

- Um ponto = uma análise + uma região (salva ou ainda não) + a massa.
  Eixo X: a massa da amostra (`sample_mass`) ou a de um componente dela
  (`component_mass`, massa × fração do nome/composição). Eixo Y: área no
  tempo (sinal × s, `postrun_timebase`). A tela também mostra área ÷ mg.
- Toda curva é de UM canal e UM ciclo (`cycle_key`): pontos de ciclos
  diferentes são recusados; o quantificador recusa análise de outro ciclo.
- Ajuste e inversa: `app.modules.postrun_regression`.
- Área de uma gaussiana (`area_source="gaussian"`, Fase 3): o ponto é o
  pico de um material numa deconvolução SALVA da análise ("amostra
  virtual") — `routes_postrun_deconv.saved_material_area`.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun import (
    AnalysisSummaryOut,
    RegionIn,
    _check_region_token,
    _read_analysis,
    _region_computation,
    _summary,
)
from app.db.models import PostrunAnalysisMeta, PostrunCurve, PostrunRegion, Role
from app.api.routes_postrun_deconv import check_method, saved_material_area
from app.modules import postrun_b00, postrun_calc, postrun_limits, postrun_regression, run_records

router = APIRouter(prefix="/postrun", tags=["postrun"])

X_KINDS = ("sample_mass", "component_mass")


# ---------------------------------------------------------------- schemas

class CurvePointIn(BaseModel):
    region: RegionIn
    excluded: bool = False
    # area_source="gaussian": material do pico na deconvolução salva
    gaussian: str = ""


class CurveSpecIn(BaseModel):
    channel: str = "pyro:FID"
    area_source: str = "region"  # "region" | "gaussian"
    # com "gaussian": área da deconvolução por gaussiana ("gauss") ou por molde
    deconv_method: str = "gauss"
    x_kind: str = "sample_mass"
    component: str = ""
    model: str = "linear"
    weighting: str = "none"
    points: list[CurvePointIn]


class CurveSaveIn(CurveSpecIn):
    name: str
    notes: str = ""


class CurvePointOut(BaseModel):
    token: str
    sample: str
    filename: str
    composition_text: str = ""
    mass_mg: float | None = None  # massa da amostra (efetiva)
    mass_source: str = ""
    fraction: float | None = None  # fração do componente (1 para a massa da amostra)
    x: float | None = None  # massa no eixo X (mg)
    area_s: float | None = None
    area_per_mg: float | None = None
    peak_temp: float | None = None
    residual: float | None = None
    excluded: bool = False
    start_idx: int
    end_idx: int
    baseline_mode: str
    fixed_baseline: float
    label: str = ""
    gaussian: str = ""
    u_area_s: float | None = None  # incerteza da área do pico (deconvolução)
    error: str | None = None


class CurveFitOut(BaseModel):
    coef: list[float]
    cov: list[list[float]]
    equation: str
    s: float
    s_y: float
    r2: float
    n: int
    dof: int
    x_min: float
    x_max: float
    lod: float | None
    loq: float | None
    rf_mean: float | None
    rf_sd: float | None
    rf_cv_pct: float | None
    warnings: list[str]


class CurvePreviewOut(BaseModel):
    channel: str
    area_source: str = "region"
    deconv_method: str = "gauss"
    cycle_key: str
    cycle_label: str
    x_kind: str
    component: str
    model: str
    weighting: str
    points: list[CurvePointOut]
    fit: CurveFitOut | None = None
    error: str | None = None


class CurveOut(CurvePreviewOut):
    id: int
    name: str
    notes: str
    # F2: último cálculo de brancos e limites guardado na curva (LimitsOut)
    limits: dict | None = None
    created_by_id: int
    created_at: datetime
    updated_at: datetime


class GaussianRef(BaseModel):
    token: str
    channel: str = "pyro:FID"
    material: str


class QuantifyIn(BaseModel):
    curve_id: int
    regions: list[RegionIn] = []
    # curva de gaussiana: os picos (amostras virtuais) a quantificar
    gaussians: list[GaussianRef] = []


class QuantifyItemOut(BaseModel):
    token: str
    channel: str
    material: str = ""
    area_s: float | None = None
    mass_mg: float | None = None  # massa calculada pela curva
    u_mg: float | None = None
    U95_mg: float | None = None
    outside_range: bool = False
    below_lod: bool = False
    below_loq: bool = False
    sample_mass_mg: float | None = None
    # massa esperada (da amostra, ou do componente pela composição) e recuperação
    expected_mg: float | None = None
    recovery_pct: float | None = None
    error: str | None = None


# ------------------------------------------------------------------ cálculo

def _equation(f: postrun_regression.Fit) -> str:
    c = f.coef

    def n(v: float) -> str:
        return f"{v:.6g}"

    if f.model == "origin":
        return f"A = {n(c[0])}·m"
    if f.model == "linear":
        return f"A = {n(c[0])} + {n(c[1])}·m"
    return f"A = {n(c[0])} + {n(c[1])}·m + {n(c[2])}·m²"


def _fit_out(f: postrun_regression.Fit) -> CurveFitOut:
    return CurveFitOut(
        coef=f.coef, cov=f.cov, equation=_equation(f), s=f.s, s_y=f.s_y, r2=f.r2, n=f.n, dof=f.dof,
        x_min=f.x_min, x_max=f.x_max, lod=f.lod, loq=f.loq, rf_mean=f.rf_mean, rf_sd=f.rf_sd,
        rf_cv_pct=f.rf_cv_pct, warnings=f.warnings,
    )


def _fit_from_json(data: dict, model: str, weighting: str) -> postrun_regression.Fit:
    return postrun_regression.Fit(
        model=model, weighting=weighting, coef=data["coef"], cov=data["cov"], s=data["s"], s_y=data["s_y"],
        r2=data["r2"], n=data["n"], dof=data["dof"], x_min=data["x_min"], x_max=data["x_max"], residuals=[],
        lod=data.get("lod"), loq=data.get("loq"),
    )


class _AnalysisInfo:
    def __init__(self, summary: AnalysisSummaryOut, analysis: postrun_b00.B00Analysis):
        self.summary = summary
        self.analysis = analysis


def _info(session: SessionDep, token: str, cache: dict[str, _AnalysisInfo]) -> _AnalysisInfo:
    if token not in cache:
        _check_region_token(session, token)
        try:
            analysis = _read_analysis(session, token)
        except postrun_b00.B00ParseError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{token}: {exc}") from exc
        summary = _summary(session, token, analysis.header, None, session.get(PostrunAnalysisMeta, token))
        cache[token] = _AnalysisInfo(summary, analysis)
    return cache[token]


def _draft(r: RegionIn) -> PostrunRegion:
    return PostrunRegion(
        token=r.token, channel=r.channel, label=r.label, start_idx=r.start_idx, end_idx=r.end_idx,
        baseline_mode=r.baseline_mode, fixed_baseline=r.fixed_baseline, created_by_id=0,
    )


def _validate_spec(spec: CurveSpecIn) -> None:
    if spec.area_source not in ("region", "gaussian"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Fonte de área inválida: {spec.area_source}")
    check_method(spec.deconv_method)
    if spec.area_source == "gaussian" and any(not p.gaussian.strip() for p in spec.points):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cada ponto de gaussiana precisa do material do pico")
    if spec.x_kind not in X_KINDS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Eixo X inválido: {spec.x_kind}")
    if spec.x_kind == "component_mass" and not spec.component.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Escolha o componente da curva")
    if spec.model not in postrun_regression.MODELS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Modelo inválido: {spec.model}")
    if spec.weighting not in postrun_regression.WEIGHTINGS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Peso inválido: {spec.weighting}")
    if not spec.points:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A curva precisa de pontos")


def _build(session: SessionDep, spec: CurveSpecIn) -> CurvePreviewOut:
    _validate_spec(spec)
    component = spec.component.strip().upper()
    cache: dict[str, _AnalysisInfo] = {}
    points: list[CurvePointOut] = []
    cycles: dict[str, str] = {}
    excluded = run_records.excluded_map(session, {p.region.token for p in spec.points})  # F4
    for p in spec.points:
        r = p.region
        if r.channel != spec.channel:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{r.token}: região de outro canal ({r.channel})")
        info = _info(session, r.token, cache)
        s = info.summary
        out = CurvePointOut(
            token=r.token, sample=s.sample, filename=s.filename, composition_text=s.composition_text,
            mass_mg=s.mass_mg, mass_source=s.mass_source, excluded=p.excluded, start_idx=r.start_idx,
            end_idx=r.end_idx, baseline_mode=r.baseline_mode, fixed_baseline=r.fixed_baseline, label=r.label,
            gaussian=p.gaussian.strip().upper(),
        )
        if not p.excluded:
            cycles[s.cycle_key] = s.cycle_label
        try:
            if spec.area_source == "gaussian":
                out.area_s, out.u_area_s = saved_material_area(
                    session, r.token, spec.channel, out.gaussian, spec.deconv_method
                )
            else:
                comp = _region_computation(session, _draft(r))
                out.area_s = comp.area * comp.seconds_per_point
                out.peak_temp = comp.peak_temp
        except (postrun_calc.RegionError, HTTPException) as exc:
            out.error = exc.detail if isinstance(exc, HTTPException) else str(exc)
        if spec.x_kind == "sample_mass":
            out.fraction = 1.0
        else:
            frac = (s.composition or {}).get(component)
            if frac is None:
                out.error = out.error or f"sem {component} na composição ({s.composition_text or 'composição desconhecida'})"
            out.fraction = frac
        if not s.mass_mg or s.mass_mg <= 0:
            out.error = out.error or "massa zero no arquivo — corrija a massa"
        if r.token in excluded:
            out.error = excluded[r.token]  # corrida excluída (F4): fora do ajuste, com o motivo
        if out.error is None and out.fraction:
            out.x = s.mass_mg * out.fraction
            out.area_per_mg = out.area_s / out.x if out.x and out.area_s is not None else None
        points.append(out)

    first = next(iter(cycles.items()), ("", ""))
    preview = CurvePreviewOut(
        channel=spec.channel, area_source=spec.area_source, cycle_key=first[0], cycle_label=first[1], x_kind=spec.x_kind,
        deconv_method=spec.deconv_method if spec.area_source == "gaussian" else "gauss",
        component=component if spec.x_kind == "component_mass" else "", model=spec.model,
        weighting=spec.weighting, points=points,
    )
    if len(cycles) > 1:
        preview.error = "Pontos de ciclos diferentes: " + "; ".join(sorted(cycles.values())) + \
            " — uma curva vale para um ciclo só."
        return preview
    used = [pt for pt in points if not pt.excluded and pt.error is None and pt.x is not None and pt.area_s is not None]
    try:
        f = postrun_regression.fit([pt.x for pt in used], [pt.area_s for pt in used], spec.model, spec.weighting)
    except postrun_regression.FitError as exc:
        preview.error = str(exc)
        return preview
    for pt, res in zip(used, f.residuals):
        pt.residual = res
    preview.fit = _fit_out(f)
    return preview


def _curve_out(c: PostrunCurve) -> CurveOut:
    fit = json.loads(c.fit) if c.fit else None
    return CurveOut(
        id=c.id, name=c.name, notes=c.notes, channel=c.channel, area_source=c.area_source,
        deconv_method=c.deconv_method or "gauss",
        cycle_key=c.cycle_key, cycle_label=c.cycle_label,
        x_kind=c.x_kind, component=c.component, model=c.model, weighting=c.weighting,
        points=[CurvePointOut(**p) for p in json.loads(c.points or "[]")],
        fit=CurveFitOut(**fit) if fit else None,
        limits=json.loads(c.limits) if c.limits else None,
        created_by_id=c.created_by_id, created_at=c.created_at, updated_at=c.updated_at,
    )


def _save_into(curve: PostrunCurve, payload: CurveSaveIn, preview: CurvePreviewOut) -> None:
    if not payload.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dê um nome à curva")
    if preview.error or preview.fit is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, preview.error or "Curva sem ajuste")
    curve.name = payload.name.strip()
    curve.notes = payload.notes
    curve.channel = preview.channel
    curve.area_source = preview.area_source
    curve.deconv_method = preview.deconv_method
    curve.cycle_key = preview.cycle_key
    curve.cycle_label = preview.cycle_label
    curve.x_kind = preview.x_kind
    curve.component = preview.component
    curve.model = preview.model
    curve.weighting = preview.weighting
    curve.points = json.dumps([p.model_dump() for p in preview.points])
    curve.fit = json.dumps(preview.fit.model_dump())


# ------------------------------------------------------------------ rotas

@router.post("/curves/preview", response_model=CurvePreviewOut)
def preview_curve(payload: CurveSpecIn, session: SessionDep, _user: CurrentUser):
    """Ajusta a curva com os pontos da tela, sem gravar."""
    return _build(session, payload)


@router.post("/curves", response_model=CurveOut)
def create_curve(payload: CurveSaveIn, session: SessionDep, user: CurrentUser):
    preview = _build(session, payload)
    curve = PostrunCurve(name="", channel="", cycle_key="", points="[]", fit="{}", created_by_id=user.id)
    _save_into(curve, payload, preview)
    session.add(curve)
    session.commit()
    session.refresh(curve)
    return _curve_out(curve)


@router.put("/curves/{curve_id}", response_model=CurveOut)
def update_curve(curve_id: int, payload: CurveSaveIn, session: SessionDep, user: CurrentUser):
    curve = session.get(PostrunCurve, curve_id)
    if curve is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Curva não encontrada")
    if curve.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou a curva (ou um admin) pode alterá-la")
    _save_into(curve, payload, _build(session, payload))
    curve.updated_at = datetime.now(timezone.utc)
    session.add(curve)
    session.commit()
    session.refresh(curve)
    return _curve_out(curve)


@router.get("/curves", response_model=list[CurveOut])
def list_curves(session: SessionDep, _user: CurrentUser, channel: str | None = None):
    query = select(PostrunCurve).order_by(PostrunCurve.updated_at.desc())
    if channel:
        query = query.where(PostrunCurve.channel == channel)
    return [_curve_out(c) for c in session.exec(query).all()]


@router.get("/curves/{curve_id}", response_model=CurveOut)
def get_curve(curve_id: int, session: SessionDep, _user: CurrentUser):
    curve = session.get(PostrunCurve, curve_id)
    if curve is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Curva não encontrada")
    return _curve_out(curve)


@router.delete("/curves/{curve_id}")
def delete_curve(curve_id: int, session: SessionDep, user: CurrentUser):
    curve = session.get(PostrunCurve, curve_id)
    if curve is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Curva não encontrada")
    if curve.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou a curva (ou um admin) pode apagá-la")
    from app.api.routes_postrun_study import guard_delete

    guard_delete(session, "curve", curve_id, f"A curva {curve.name}")
    session.delete(curve)
    session.commit()
    return {"ok": True}


# ------------------------------------------------- F2: brancos e limites

class LimitsIn(BaseModel):
    blank_tokens: list[str]
    # réplicas de uma amostra de baixa concentração (LoD de Armbruster & Pry)
    low_tokens: list[str] = []
    # massa de matriz (sílica) por cadinho, mg; vazio = média das massas dos brancos
    matrix_mass_mg: float | None = None
    # intervalo de integração dos brancos; vazio = a mediana do da curva
    start_idx: int | None = None
    end_idx: int | None = None
    baseline_mode: str = "linear"
    save: bool = True


class LimitRunOut(BaseModel):
    token: str
    filename: str = ""
    sample: str = ""
    mass_mg: float | None = None
    area_s: float | None = None
    apparent_mg: float | None = None
    error: str | None = None


class LimitOut(BaseModel):
    key: str
    label: str
    criterion: str
    mg: float | None
    ppm: float | None


class LimitsOut(BaseModel):
    curve_id: int
    start_idx: int
    end_idx: int
    baseline_mode: str
    matrix_mass_mg: float | None
    matrix_mass_source: str
    n_blanks: int
    blank_mean_mg: float
    blank_sd_mg: float
    n_low: int
    low_sd_mg: float | None
    limits: list[LimitOut]
    blanks: list[LimitRunOut]
    low: list[LimitRunOut]
    warnings: list[str]
    computed_at: datetime


def _median(values: list[int]) -> int:
    xs = sorted(values)
    return xs[len(xs) // 2]


def _apparent(session: SessionDep, curve: PostrunCurve, f: postrun_regression.Fit, token: str,
              window: tuple[int, int, str], cache: dict) -> LimitRunOut:
    out = LimitRunOut(token=token)
    try:
        info = _info(session, token, cache)
    except HTTPException as exc:
        out.error = str(exc.detail)
        return out
    s = info.summary
    out.filename, out.sample, out.mass_mg = s.filename, s.sample, s.mass_mg
    if s.cycle_key != curve.cycle_key:
        out.error = f"ciclo diferente do da curva ({s.cycle_label})"
        return out
    region = PostrunRegion(token=token, channel=curve.channel, label="", start_idx=window[0], end_idx=window[1],
                           baseline_mode=window[2], fixed_baseline=0.0, created_by_id=0)
    try:
        comp = _region_computation(session, region)
        out.area_s = comp.area * comp.seconds_per_point
        out.apparent_mg = postrun_regression.inverse(f, out.area_s).x
    except (postrun_calc.RegionError, postrun_regression.FitError) as exc:
        out.error = str(exc)
    return out


@router.post("/curves/{curve_id}/limits", response_model=LimitsOut)
def curve_limits(curve_id: int, payload: LimitsIn, session: SessionDep, user: CurrentUser):
    """F2: brancos de matriz → LoB/LoD/LoQ (Armbruster & Pry) e LD/LQ da curva,
    em mg e em ppm. Cada branco é integrado no intervalo da curva e convertido
    em massa aparente pela própria curva. Com `save`, guarda na curva."""
    curve = session.get(PostrunCurve, curve_id)
    if curve is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Curva não encontrada")
    if payload.save and curve.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou a curva (ou um admin) pode guardar os limites nela")
    if payload.baseline_mode not in ("linear", "fixed"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Linha de base inválida: {payload.baseline_mode}")
    overlap = set(payload.blank_tokens) & set(payload.low_tokens)
    if overlap:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uma corrida não pode ser branco e nível baixo ao mesmo tempo")
    fit_data = json.loads(curve.fit or "{}")
    if not fit_data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Curva sem ajuste")
    f = _fit_from_json(fit_data, curve.model, curve.weighting)
    pts = [p for p in json.loads(curve.points or "[]") if not p.get("excluded")]
    if payload.start_idx is not None and payload.end_idx is not None:
        start, end = sorted((payload.start_idx, payload.end_idx))
    elif pts:
        start, end = _median([p["start_idx"] for p in pts]), _median([p["end_idx"] for p in pts])
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Informe o intervalo de integração dos brancos")
    window = (start, end, payload.baseline_mode)
    cache: dict = {}
    blanks = [_apparent(session, curve, f, t, window, cache) for t in dict.fromkeys(payload.blank_tokens)]
    low = [_apparent(session, curve, f, t, window, cache) for t in dict.fromkeys(payload.low_tokens)]
    good_blanks = [b.apparent_mg for b in blanks if b.apparent_mg is not None]
    good_low = [b.apparent_mg for b in low if b.apparent_mg is not None]

    if payload.matrix_mass_mg is not None and payload.matrix_mass_mg > 0:
        matrix, matrix_src = payload.matrix_mass_mg, "informada"
    else:
        masses = [b.mass_mg for b in blanks if b.error is None and b.mass_mg]
        matrix = sum(masses) / len(masses) if masses else None
        matrix_src = "média das massas dos brancos" if matrix else "—"
    sigma_label = "σ dos resíduos no menor nível" if curve.model == "origin" else "σ do intercepto"
    try:
        res = postrun_limits.compute(
            good_blanks, low_mg=good_low, matrix_mass_mg=matrix,
            curve_lod_mg=fit_data.get("lod"), curve_loq_mg=fit_data.get("loq"), curve_sigma_label=sigma_label,
        )
    except postrun_limits.LimitsError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    warnings = list(res.warnings)
    if fit_data.get("lod") is None:
        warnings.append(
            "LD/LQ da curva indisponíveis: na reta pela origem, σ₀ vem das réplicas do menor nível de massa — "
            "a curva precisa de pelo menos 2 nesse nível."
            if curve.model == "origin" else "LD/LQ da curva indisponíveis (inclinação não positiva)."
        )
    skipped = [b for b in blanks + low if b.error]
    if skipped:
        warnings.append(f"{len(skipped)} corrida(s) fora do cálculo — veja o motivo na tabela.")
    out = LimitsOut(
        curve_id=curve.id, start_idx=start, end_idx=end, baseline_mode=payload.baseline_mode,
        matrix_mass_mg=res.matrix_mass_mg, matrix_mass_source=matrix_src, n_blanks=res.n_blanks,
        blank_mean_mg=res.blank_mean_mg, blank_sd_mg=res.blank_sd_mg, n_low=res.n_low, low_sd_mg=res.low_sd_mg,
        limits=[LimitOut(**vars(lim)) for lim in res.limits], blanks=blanks, low=low, warnings=warnings,
        computed_at=datetime.now(timezone.utc),
    )
    if payload.save:
        curve.limits = out.model_dump_json()
        session.add(curve)
        session.commit()
    return out


@router.post("/quantify", response_model=list[QuantifyItemOut])
def quantify(payload: QuantifyIn, session: SessionDep, _user: CurrentUser):
    """Massa pela curva, a partir da área de cada região (salva ou não).
    Com composição conhecida, também a massa esperada e a recuperação %."""
    curve = session.get(PostrunCurve, payload.curve_id)
    if curve is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Curva não encontrada")
    f = _fit_from_json(json.loads(curve.fit), curve.model, curve.weighting)
    cache: dict[str, _AnalysisInfo] = {}
    out: list[QuantifyItemOut] = []
    jobs: list[tuple[str, str, str, RegionIn | None]] = (
        [(g.token, g.channel, g.material.strip().upper(), None) for g in payload.gaussians]
        if curve.area_source == "gaussian"
        else [(r.token, r.channel, "", r) for r in payload.regions]
    )
    for token, channel, material, region in jobs:
        item = QuantifyItemOut(token=token, channel=channel, material=material)
        out.append(item)
        if channel != curve.channel:
            item.error = f"a curva é do canal {curve.channel}"
            continue
        try:
            info = _info(session, token, cache)
        except HTTPException as exc:
            item.error = str(exc.detail)
            continue
        s = info.summary
        item.sample_mass_mg = s.mass_mg or None
        if s.cycle_key != curve.cycle_key:
            item.error = f"ciclo diferente do da curva ({s.cycle_label})"
            continue
        try:
            if region is None:
                item.area_s, _u = saved_material_area(session, token, channel, material, curve.deconv_method or "gauss")
            else:
                comp = _region_computation(session, _draft(region))
                item.area_s = comp.area * comp.seconds_per_point
        except (postrun_calc.RegionError, HTTPException) as exc:
            item.error = exc.detail if isinstance(exc, HTTPException) else str(exc)
            continue
        try:
            inv = postrun_regression.inverse(f, item.area_s)
        except postrun_regression.FitError as exc:
            item.error = str(exc)
            continue
        item.mass_mg, item.u_mg, item.U95_mg = inv.x, inv.u, inv.U95
        item.outside_range, item.below_lod, item.below_loq = inv.outside_range, inv.below_lod, inv.below_loq
        if s.mass_mg and s.mass_mg > 0:
            component = curve.component or material
            if curve.x_kind == "sample_mass":
                item.expected_mg = s.mass_mg
            elif s.composition and component in s.composition:
                item.expected_mg = s.mass_mg * s.composition[component]
            if item.expected_mg:
                item.recovery_pct = 100.0 * inv.x / item.expected_mg
    return out
