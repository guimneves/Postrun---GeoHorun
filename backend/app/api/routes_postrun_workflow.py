"""Aba Deconvolução do PostRun (pedido do usuário, 17/10/2026: criar
molde, referência, deconvolução e ver a recuperação estava espalhado por
várias abas e confuso). Aqui o processo inteiro vira 4 passos, cada um um
botão, sobre as análises abertas — usando a região (janela) salva de cada
uma na aba Análises e a composição dela:

1. **Puros → referência e molde** (`/references`): cada corrida de material
   puro é ajustada com 1 pico livre (gaussiana assimétrica) com o nome do
   material, salva, e a referência do material no ciclo é criada — ou
   refeita, se já existir (mesma referência).
2. **Ajustar** (`/fit`), com o método escolhido — "gauss" (gaussianas
   guiadas pelas referências) ou "molde" (o molde de cada material puro):
   puros e misturas, tudo salvo. Os dois métodos ficam salvos lado a lado.
3. **Curvas** (`/curves`): para cada material, a curva massa do componente
   × área, só com os puros, no mesmo método (criada ou atualizada).
4. **Recuperação**: o relatório (`/postrun/report/recovery`) com o método.

`/status` diz, por análise, o que já tem (região, composição, deconvolução
de cada método) e quais referências e curvas existem — a tela mostra o
passo a passo com ✓.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import (
    CurvePointIn,
    CurveSaveIn,
    _AnalysisInfo,
    _build,
    _info,
    _save_into,
)
from app.api.routes_postrun import RegionIn
from app.api.routes_postrun_deconv import (
    DeconvSpecIn,
    _compute,
    _ref_out,
    _reference_parts,
    check_method,
    persist,
    saved_row,
    ReferenceOut,
)
from app.db.models import PostrunCurve, PostrunDeconvReference, PostrunRegion

router = APIRouter(prefix="/postrun/workflow", tags=["postrun"])

METHOD_LABEL = {"gauss": "gaussiana", "molde": "molde"}


# ---------------------------------------------------------------- schemas

class SavedFitOut(BaseModel):
    mode: str
    r2: float
    warnings: list[str]
    materials: dict[str, float]  # material -> área (sinal·s)


class RunStatusOut(BaseModel):
    token: str
    filename: str
    sample: str
    composition: dict[str, float] | None
    composition_text: str
    # componentes também sem a proporção, estado e explicação (16/11/2026)
    components: list[str] = []
    composition_status: str = "desconhecida"
    composition_note: str = ""
    mass_mg: float
    cycle_key: str
    cycle_label: str
    # "pure" | "mixture" | "no_ratio" (mistura sem proporção: ajusta e dá a
    # massa encontrada, sem recuperação) | "unknown"
    kind: str
    material: str | None = None  # quando puro
    has_region: bool
    error: str | None = None
    saved: dict[str, SavedFitOut] = {}  # método -> ajuste salvo


class CurveBrief(BaseModel):
    id: int
    name: str
    component: str
    method: str
    cycle_key: str
    cycle_label: str
    r2: float | None
    n_points: int
    equation: str
    updated_at: datetime


class StatusOut(BaseModel):
    runs: list[RunStatusOut]
    references: list[ReferenceOut]
    curves: list[CurveBrief]


class WorkflowIn(BaseModel):
    tokens: list[str]
    channel: str = "pyro:FID"


class FitIn(WorkflowIn):
    method: str = "gauss"
    tol_c: float = 20.0
    tol_width_pct: float = 30.0


class CurvesIn(WorkflowIn):
    method: str = "gauss"
    model: str = "linear"
    weighting: str = "1/x2"


class StepItemOut(BaseModel):
    token: str
    ok: bool
    error: str | None = None
    r2: float | None = None
    warnings: list[str] = []


class ReferenceStepOut(BaseModel):
    material: str
    cycle_label: str
    ok: bool
    error: str | None = None
    reference: ReferenceOut | None = None
    updated: bool = False  # já existia e foi refeita
    n_excluded: int = 0  # corridas abertas deixadas de fora (tiradas pelo usuário antes)


class ReferencesOut(BaseModel):
    items: list[StepItemOut]
    references: list[ReferenceStepOut]


class CurveStepOut(BaseModel):
    material: str
    cycle_label: str
    ok: bool
    error: str | None = None
    curve: CurveBrief | None = None
    updated: bool = False


# ------------------------------------------------------------------ apoio

def _region(session: SessionDep, token: str, channel: str) -> PostrunRegion | None:
    return session.exec(
        select(PostrunRegion).where(PostrunRegion.token == token, PostrunRegion.channel == channel)
        .order_by(PostrunRegion.id.desc())
    ).first()


def _kind(summary) -> tuple[str, str | None]:
    comp = summary.composition
    if comp:
        if len(comp) == 1:
            return "pure", next(iter(comp))
        return "mixture", None
    if len(summary.components) > 1:
        return "no_ratio", None
    return "unknown", None


def _spec(region: PostrunRegion, **extra) -> DeconvSpecIn:
    return DeconvSpecIn(
        token=region.token, channel=region.channel, start_idx=region.start_idx, end_idx=region.end_idx,
        baseline_mode=region.baseline_mode, fixed_baseline=region.fixed_baseline, **extra,
    )


def _ref_for(session: SessionDep, material: str, channel: str, cycle_key: str) -> PostrunDeconvReference | None:
    return session.exec(
        select(PostrunDeconvReference).where(
            PostrunDeconvReference.name == material, PostrunDeconvReference.channel == channel,
            PostrunDeconvReference.cycle_key == cycle_key,
        ).order_by(PostrunDeconvReference.created_at.desc())
    ).first()


def _curve_brief(c: PostrunCurve) -> CurveBrief:
    fit = json.loads(c.fit or "{}")
    pts = json.loads(c.points or "[]")
    return CurveBrief(
        id=c.id, name=c.name, component=c.component, method=c.deconv_method or "gauss", cycle_key=c.cycle_key,
        cycle_label=c.cycle_label, r2=fit.get("r2"), equation=fit.get("equation", ""),
        n_points=sum(1 for p in pts if not p.get("excluded") and p.get("error") is None), updated_at=c.updated_at,
    )


def _auto_name(material: str, method: str) -> str:
    return f"{material} · {METHOD_LABEL[method]} (automática)"


def _gather(session: SessionDep, tokens: list[str], channel: str):
    """(token, info, região, tipo, material) de cada análise — ou o erro."""
    cache: dict[str, _AnalysisInfo] = {}
    out = []
    for token in dict.fromkeys(tokens):
        try:
            info = _info(session, token, cache)
        except HTTPException as exc:
            out.append((token, None, None, "unknown", None, str(exc.detail)))
            continue
        kind, material = _kind(info.summary)
        out.append((token, info, _region(session, token, channel), kind, material, None))
    return out


# ------------------------------------------------------------------ rotas

@router.get("/status", response_model=StatusOut)
def workflow_status(session: SessionDep, _user: CurrentUser, tokens: list[str] = Query(default=[]),
                    channel: str = "pyro:FID"):
    return _status(session, tokens, channel)


@router.post("/status", response_model=StatusOut)
def workflow_status_post(payload: WorkflowIn, session: SessionDep, _user: CurrentUser):
    """O mesmo, com a lista no corpo: com dezenas de análises abertas, os
    caminhos na URL passavam do que o caminho até o módulo aceita."""
    return _status(session, payload.tokens, payload.channel)


_log = logging.getLogger(__name__)


def _unknown(token: str, error: str) -> RunStatusOut:
    return RunStatusOut(token=token, filename=token.rsplit("/", 1)[-1], sample="", composition=None, composition_text="",
                        composition_note=error,
                        mass_mg=0, cycle_key="", cycle_label="", kind="unknown", has_region=False, error=error)


def _status(session: SessionDep, tokens: list[str], channel: str) -> StatusOut:
    runs = []
    for token in dict.fromkeys(tokens):
        # uma análise com problema vira uma linha com o erro — nunca derruba
        # o status das outras (a aba ficava mostrando a lista antiga)
        try:
            [(token, info, region, kind, material, error)] = _gather(session, [token], channel)
            if info is None:
                runs.append(_unknown(token, error or "não foi possível ler a análise"))
                continue
            s = info.summary
            saved = {}
            for method in ("gauss", "molde"):
                row = saved_row(session, token, channel, method)
                if row is None:
                    continue
                data = json.loads(row.result or "{}")
                mats: dict[str, float] = {}
                for p in data.get("peaks", []):
                    key = p.get("material") or p.get("name", "?")
                    mats[key] = mats.get(key, 0.0) + float(p.get("area_s", 0.0))
                saved[method] = SavedFitOut(mode=row.mode, r2=float(data.get("r2", 0.0)),
                                            warnings=data.get("warnings", []), materials=mats)
            runs.append(RunStatusOut(
                token=token, filename=s.filename, sample=s.sample, composition=s.composition,
                composition_text=s.composition_text, components=s.components,
                composition_status=s.composition_status, composition_note=s.composition_note, mass_mg=s.mass_mg, cycle_key=s.cycle_key, cycle_label=s.cycle_label,
                kind=kind, material=material, has_region=region is not None, saved=saved,
            ))
        except Exception as exc:  # noqa: BLE001 — registra e segue com as outras
            _log.exception("status do PostRun falhou para %s", token)
            runs.append(_unknown(token, f"erro ao ler: {exc}"))
    refs = session.exec(
        select(PostrunDeconvReference).where(PostrunDeconvReference.channel == channel).order_by(PostrunDeconvReference.name)
    ).all()
    curves = session.exec(
        select(PostrunCurve).where(PostrunCurve.channel == channel, PostrunCurve.area_source == "gaussian")
        .order_by(PostrunCurve.updated_at.desc())
    ).all()
    return StatusOut(runs=runs, references=[_ref_out(r) for r in refs], curves=[_curve_brief(c) for c in curves])


@router.post("/references", response_model=ReferencesOut)
def build_references(payload: WorkflowIn, session: SessionDep, user: CurrentUser):
    """Passo 1: puros → 1 pico livre salvo → referência (com molde) de cada
    material no ciclo, criada ou refeita."""
    items: list[StepItemOut] = []
    groups: dict[tuple[str, str], list[str]] = {}
    labels: dict[str, str] = {}
    for token, info, region, kind, material, error in _gather(session, payload.tokens, payload.channel):
        if kind != "pure":
            continue  # misturas não entram nas referências
        if region is None:
            items.append(StepItemOut(token=token, ok=False, error="sem região salva — defina a janela na aba Análises"))
            continue
        spec = _spec(region, shape="bigaussian", mode="free", n_peaks=1, names=[material])
        try:
            res = _compute(session, spec)
        except HTTPException as exc:
            items.append(StepItemOut(token=token, ok=False, error=str(exc.detail)))
            continue
        persist(session, spec, res, user.id)
        items.append(StepItemOut(token=token, ok=True, r2=res.r2, warnings=res.warnings))
        groups.setdefault((material, info.summary.cycle_key), []).append(token)
        labels[info.summary.cycle_key] = info.summary.cycle_label
    session.commit()

    refs_out: list[ReferenceStepOut] = []
    for (material, cycle_key), tokens in groups.items():
        out = ReferenceStepOut(material=material, cycle_label=labels[cycle_key], ok=False)
        refs_out.append(out)
        ref = _ref_for(session, material, payload.channel, cycle_key)
        # as corridas que o usuário tirou da referência continuam fora
        excluded = set(json.loads(ref.excluded or "[]")) if ref is not None else set()
        out.n_excluded = sum(1 for t in tokens if t in excluded)
        tokens = [t for t in tokens if t not in excluded]
        if not tokens:
            out.error = "todas as corridas abertas deste material foram tiradas da referência"
            continue
        try:
            parts = _reference_parts(session, tokens, payload.channel)
        except HTTPException as exc:
            out.error = str(exc.detail)
            continue
        if ref is None:
            ref = PostrunDeconvReference(name=material, channel=payload.channel, created_by_id=user.id, **parts)
        else:
            out.updated = True
            for k, v in parts.items():
                setattr(ref, k, v)
        session.add(ref)
        session.commit()
        session.refresh(ref)
        out.ok = True
        out.reference = _ref_out(ref)
    return ReferencesOut(items=items, references=refs_out)


@router.post("/fit", response_model=list[StepItemOut])
def fit_all(payload: FitIn, session: SessionDep, user: CurrentUser):
    """Passo 2: ajusta e salva puros e misturas no método escolhido. Puros:
    1 pico livre (gauss) ou o próprio molde (molde). Misturas: as
    referências de TODOS os componentes, deste ciclo."""
    method = check_method(payload.method)
    out: list[StepItemOut] = []
    for token, info, region, kind, material, error in _gather(session, payload.tokens, payload.channel):
        item = StepItemOut(token=token, ok=False)
        out.append(item)
        if info is None:
            item.error = error
            continue
        if region is None:
            item.error = "sem região salva — defina a janela na aba Análises"
            continue
        if kind == "unknown":
            item.error = ("composição não identificada — clique na composição da corrida e informe "
                          "(ex.: PS · PP 50, PS 50 · PP, PS)")
            continue
        comp = info.summary.components
        cycle = info.summary.cycle_key
        refs = {m: _ref_for(session, m, payload.channel, cycle) for m in comp}
        if kind == "pure" and method == "gauss":
            spec = _spec(region, shape="bigaussian", mode="free", n_peaks=1, names=[material])
        else:
            missing = [m for m, r in refs.items() if r is None or (method == "molde" and not r.template)]
            if missing:
                item.error = (f"sem referência {'com molde ' if method == 'molde' else ''}de {', '.join(missing)} "
                              f"neste ciclo — faça o passo 1 com as corridas puras")
                continue
            ids = [r.id for r in refs.values()]
            shapes = {r.shape for r in refs.values()}
            spec = _spec(
                region, mode="template" if method == "molde" else "guided", reference_ids=ids,
                shape=shapes.pop() if len(shapes) == 1 else "bigaussian",
                tol_c=payload.tol_c, tol_width_pct=payload.tol_width_pct,
            )
        try:
            res = _compute(session, spec)
        except HTTPException as exc:
            item.error = str(exc.detail)
            continue
        persist(session, spec, res, user.id)
        item.ok, item.r2, item.warnings = True, res.r2, res.warnings
    session.commit()
    return out


@router.post("/curves", response_model=list[CurveStepOut])
def build_curves(payload: CurvesIn, session: SessionDep, user: CurrentUser):
    """Passo 3: uma curva por material (massa do componente × área do pico),
    só com as corridas puras dele, no método escolhido — criada ou
    atualizada (a "automática" daquele material, método e ciclo)."""
    method = check_method(payload.method)
    groups: dict[tuple[str, str], list[str]] = {}
    labels: dict[str, str] = {}
    regions: dict[str, PostrunRegion] = {}
    for token, info, region, kind, material, error in _gather(session, payload.tokens, payload.channel):
        if kind != "pure" or region is None or saved_row(session, token, payload.channel, method) is None:
            continue
        groups.setdefault((material, info.summary.cycle_key), []).append(token)
        labels[info.summary.cycle_key] = info.summary.cycle_label
        regions[token] = region
    out: list[CurveStepOut] = []
    for (material, cycle_key), tokens in groups.items():
        item = CurveStepOut(material=material, cycle_label=labels[cycle_key], ok=False)
        out.append(item)
        spec = CurveSaveIn(
            name=_auto_name(material, method), channel=payload.channel, area_source="gaussian", deconv_method=method,
            x_kind="component_mass", component=material, model=payload.model, weighting=payload.weighting,
            notes="criada pela aba Deconvolução com as corridas puras",
            points=[CurvePointIn(
                region=RegionIn(token=t, channel=payload.channel, label=material, start_idx=regions[t].start_idx,
                                end_idx=regions[t].end_idx, baseline_mode=regions[t].baseline_mode,
                                fixed_baseline=regions[t].fixed_baseline),
                gaussian=material,
            ) for t in tokens],
        )
        try:
            preview = _build(session, spec)
            curve = session.exec(
                select(PostrunCurve).where(
                    PostrunCurve.name == spec.name, PostrunCurve.channel == payload.channel,
                    PostrunCurve.cycle_key == cycle_key, PostrunCurve.deconv_method == method,
                )
            ).first()
            item.updated = curve is not None
            if curve is None:
                curve = PostrunCurve(name=spec.name, channel=payload.channel, cycle_key=cycle_key, points="[]", fit="{}",
                                     created_by_id=user.id)
            _save_into(curve, spec, preview)
        except HTTPException as exc:
            item.error = str(exc.detail)
            continue
        curve.updated_at = datetime.now(timezone.utc)
        session.add(curve)
        session.commit()
        session.refresh(curve)
        item.ok, item.curve = True, _curve_brief(curve)
    if not out:
        raise HTTPException(400, f"Nenhuma corrida pura com deconvolução por {METHOD_LABEL[method]} salva — faça o passo 2")
    return out
