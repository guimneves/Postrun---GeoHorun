"""Estudos do PostRun (pedido do usuário, 22/10/2026).

Um estudo junta, num lugar só, tudo o que foi feito para quantificar uma
série de misturas: as análises (puros e misturas), as referências e moldes,
as curvas de calibração e as calibrações STD. As deconvoluções vêm das
análises (uma salva por análise + canal + método).

- Nas abas Deconvolução e Curvas, "selecionar estudo" abre tudo de uma vez,
  como um job.
- Ao final, o estudo é finalizado: o relatório dos dois métodos fica
  congelado (`snapshot`) e as referências/curvas dele saem das listas gerais
  da tela (continuam aqui).
- A exportação "absoluta" (`/export.xlsx`) leva todos os dados, cálculos e
  pontos — para os professores verem e para importar no módulo Resultados
  (aba `Horun_Resultados`, formato `horun-postrun-estudo` versão 1).
"""

from __future__ import annotations

import io
import json
import math
import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun import AnalysisSummaryOut, _calibration_out
from app.api.routes_postrun_curves import _AnalysisInfo, _info
from app.api.routes_postrun_deconv import (
    METHODS as METHODS_SAVED,
    DeconvSpecIn,
    ReferenceOut,
    _compute,
    _from_row,
    _ref_out,
    check_method,
    reference_detail,
    saved_row,
)
from app.api.routes_postrun_report import ReportIn, ReportOut, Stat, build_report
from app.api.routes_postrun_report import _stat as _stat_of
from app.db.models import (
    PostrunCalibration,
    PostrunCurve,
    PostrunDeconvolution,
    PostrunDeconvReference,
    PostrunStudy,
    Role,
    utcnow,
)
from app.modules import postrun_timebase

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])

EXPORT_FORMAT = "horun-postrun-estudo"
EXPORT_VERSION = 1


# ---------------------------------------------------------------- schemas

class StudyIn(BaseModel):
    name: str
    description: str = ""
    method: str = "molde"
    channel: str = "pyro:FID"


class StudyUpdateIn(BaseModel):
    name: str | None = None
    description: str | None = None
    method: str | None = None
    status: str | None = None  # "aberto" | "finalizado"


class StudyItemsIn(BaseModel):
    tokens: list[str] = []
    reference_ids: list[int] = []
    curve_ids: list[int] = []
    calibration_ids: list[int] = []


class StudyItemsChangeIn(BaseModel):
    add: StudyItemsIn = StudyItemsIn()
    remove: StudyItemsIn = StudyItemsIn()


class StudyCollectIn(BaseModel):
    tokens: list[str]


class HeadlineMaterial(BaseModel):
    material: str
    fraction: float | None = None
    recovery_mean: float | None = None
    recovery_sd: float | None = None
    n: int = 0


class HeadlineGroup(BaseModel):
    key: str
    n_runs: int
    # total = Σ massas encontradas ÷ massa pesada; n = réplicas válidas (F1)
    total_mean: float | None = None
    total_sd: float | None = None
    total_n: int = 0
    # poliolefinas somadas (PEAD + PP…), quando há duas ou mais
    polyolefins: list[str] = []
    polyolefins_mean: float | None = None
    polyolefins_sd: float | None = None
    polyolefins_n: int = 0
    materials: list[HeadlineMaterial] = []


class StudyOut(BaseModel):
    id: int
    name: str
    description: str
    status: str
    method: str
    channel: str
    tokens: list[str]
    reference_ids: list[int]
    curve_ids: list[int]
    calibration_ids: list[int]
    headline: dict[str, list[HeadlineGroup]] = {}  # método → grupos
    created_by_id: int
    created_at: datetime
    updated_at: datetime
    finalized_at: datetime | None = None


class StudyCurveOut(BaseModel):
    id: int
    name: str
    component: str
    method: str
    area_source: str
    model: str
    equation: str = ""
    r2: float | None = None
    n_points: int = 0
    cycle_label: str = ""


class StudyCalibrationOut(BaseModel):
    id: int
    name: str
    channel: str
    mode: str
    r2: float | None = None
    validated_at: datetime


class StudyAnalysisOut(BaseModel):
    token: str
    ok: bool = True
    error: str | None = None
    summary: AnalysisSummaryOut | None = None
    saved_methods: list[str] = []  # deconvoluções salvas no canal do estudo


class StudyDetailOut(StudyOut):
    analyses: list[StudyAnalysisOut] = []
    references: list[ReferenceOut] = []
    curves: list[StudyCurveOut] = []
    calibrations: list[StudyCalibrationOut] = []


class StudyReportOut(BaseModel):
    report: ReportOut
    frozen: bool = False  # True = relatório congelado na finalização


# ------------------------------------------------------------------ utils

def _ids(text: str) -> list:
    return json.loads(text or "[]")


def _out(s: PostrunStudy) -> StudyOut:
    head = json.loads(s.headline) if s.headline else {}
    return StudyOut(
        id=s.id, name=s.name, description=s.description, status=s.status, method=s.method, channel=s.channel,
        tokens=_ids(s.tokens), reference_ids=_ids(s.reference_ids), curve_ids=_ids(s.curve_ids),
        calibration_ids=_ids(s.calibration_ids),
        headline={k: [HeadlineGroup(**g) for g in v] for k, v in head.items()},
        created_by_id=s.created_by_id, created_at=s.created_at, updated_at=s.updated_at, finalized_at=s.finalized_at,
    )


def _get(session: SessionDep, study_id: int) -> PostrunStudy:
    s = session.get(PostrunStudy, study_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Estudo não encontrado")
    return s


def _merge(current: str, add: list, remove: list | None = None) -> str:
    items = list(dict.fromkeys([*_ids(current), *add]))
    if remove:
        drop = set(remove)
        items = [i for i in items if i not in drop]
    return json.dumps(items)


def studies_using(session, kind: str, item_id: int) -> list[str]:
    """Nomes dos estudos que guardam esta referência/curva/calibração — para
    não apagá-la por baixo do estudo. `kind`: reference | curve | calibration."""
    field = {"reference": "reference_ids", "curve": "curve_ids", "calibration": "calibration_ids"}[kind]
    return [s.name for s in session.exec(select(PostrunStudy)).all() if item_id in _ids(getattr(s, field))]


def guard_delete(session, kind: str, item_id: int, label: str) -> None:
    names = studies_using(session, kind, item_id)
    if names:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{label} está no estudo {', '.join(names)} — tire-a do estudo (aba Estudos) antes de apagar",
        )


def _curve_out(c: PostrunCurve) -> StudyCurveOut:
    fit = json.loads(c.fit) if c.fit else {}
    return StudyCurveOut(
        id=c.id, name=c.name, component=c.component, method=c.deconv_method or "gauss", area_source=c.area_source,
        model=c.model, equation=fit.get("equation", ""), r2=fit.get("r2"), n_points=len(json.loads(c.points or "[]")),
        cycle_label=c.cycle_label,
    )


def _curve_overrides(session: SessionDep, s: PostrunStudy, method: str) -> dict[str, int]:
    """Material → curva do estudo para o método (a mais recente, se houver mais de uma)."""
    out: dict[str, tuple[datetime, int]] = {}
    for cid in _ids(s.curve_ids):
        c = session.get(PostrunCurve, cid)
        if c is None or c.area_source != "gaussian" or (c.deconv_method or "gauss") != method or c.channel != s.channel:
            continue
        if c.component not in out or c.updated_at > out[c.component][0]:
            out[c.component] = (c.updated_at, c.id)  # type: ignore[assignment]
    return {k: v[1] for k, v in out.items()}


def _report(session: SessionDep, s: PostrunStudy, method: str,
            infos: dict[str, _AnalysisInfo] | None = None) -> tuple[ReportOut, dict]:
    return build_report(session, ReportIn(
        tokens=_ids(s.tokens), channel=s.channel, method=method, curve_ids=_curve_overrides(session, s, method),
    ), infos)


def _headline(report: ReportOut) -> list[dict]:
    out = []
    for g in report.groups:
        out.append(HeadlineGroup(
            key=g.key, n_runs=g.n_runs, total_mean=g.total_recovery_pct.mean, total_sd=g.total_recovery_pct.sd,
            total_n=g.total_recovery_pct.n, polyolefins=g.polyolefins,
            polyolefins_mean=g.polyolefins_recovery_pct.mean, polyolefins_sd=g.polyolefins_recovery_pct.sd,
            polyolefins_n=g.polyolefins_recovery_pct.n,
            materials=[HeadlineMaterial(material=m.material, fraction=m.fraction, recovery_mean=m.recovery_pct.mean,
                                        recovery_sd=m.recovery_pct.sd, n=m.recovery_pct.n) for m in g.materials],
        ).model_dump())
    return out


def _frozen(s: PostrunStudy, method: str) -> ReportOut | None:
    if s.status != "finalizado" or not s.snapshot:
        return None
    data = json.loads(s.snapshot).get(method)
    return ReportOut(**data) if data else None


# ------------------------------------------------------------------ rotas

@router.get("", response_model=list[StudyOut])
def list_studies(session: SessionDep, _user: CurrentUser):
    rows = session.exec(select(PostrunStudy).order_by(PostrunStudy.updated_at.desc())).all()
    return [_out(s) for s in rows]


@router.post("", response_model=StudyOut)
def create_study(payload: StudyIn, session: SessionDep, user: CurrentUser):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dê um nome ao estudo")
    if session.exec(select(PostrunStudy).where(PostrunStudy.name == name)).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"Já existe um estudo chamado {name}")
    s = PostrunStudy(name=name, description=payload.description.strip(), method=check_method(payload.method),
                     channel=payload.channel, created_by_id=user.id)
    session.add(s)
    session.commit()
    session.refresh(s)
    return _out(s)


@router.get("/{study_id}", response_model=StudyDetailOut)
def get_study(study_id: int, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    infos: dict[str, _AnalysisInfo] = {}
    analyses: list[StudyAnalysisOut] = []
    tokens = _ids(s.tokens)
    saved: dict[str, set[str]] = {}
    if tokens:
        for row in session.exec(select(PostrunDeconvolution).where(
            PostrunDeconvolution.token.in_(tokens), PostrunDeconvolution.channel == s.channel  # type: ignore[union-attr]
        )).all():
            saved.setdefault(row.token, set()).add(row.method or "gauss")
    for t in tokens:
        try:
            info = _info(session, t, infos)
            analyses.append(StudyAnalysisOut(token=t, summary=info.summary, saved_methods=sorted(saved.get(t, set()))))
        except HTTPException as exc:
            analyses.append(StudyAnalysisOut(token=t, ok=False, error=str(exc.detail)))
    refs = [r for r in (session.get(PostrunDeconvReference, i) for i in _ids(s.reference_ids)) if r is not None]
    curves = [c for c in (session.get(PostrunCurve, i) for i in _ids(s.curve_ids)) if c is not None]
    cals = [c for c in (session.get(PostrunCalibration, i) for i in _ids(s.calibration_ids)) if c is not None]
    return StudyDetailOut(
        **_out(s).model_dump(), analyses=analyses, references=[_ref_out(r) for r in refs],
        curves=[_curve_out(c) for c in curves],
        calibrations=[StudyCalibrationOut(id=c.id, name=c.name, channel=c.channel, mode=c.mode, r2=c.r2,
                                          validated_at=c.validated_at) for c in cals],
    )


@router.put("/{study_id}", response_model=StudyOut)
def update_study(study_id: int, payload: StudyUpdateIn, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dê um nome ao estudo")
        other = session.exec(select(PostrunStudy).where(PostrunStudy.name == name)).first()
        if other is not None and other.id != s.id:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Já existe um estudo chamado {name}")
        s.name = name
    if payload.description is not None:
        s.description = payload.description.strip()
    if payload.method is not None:
        s.method = check_method(payload.method)
    if payload.status is not None:
        if payload.status not in ("aberto", "finalizado"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Situação inválida: {payload.status}")
        if payload.status == "finalizado" and s.status != "finalizado":
            # congela o relatório dos dois métodos (o que der para calcular)
            snap, head = {}, {}
            for method in METHODS_SAVED:
                rep, _ = _report(session, s, method)
                if rep.runs:
                    snap[method] = rep.model_dump(mode="json")
                    head[method] = _headline(rep)
            s.snapshot = json.dumps(snap)
            s.headline = json.dumps(head)
            s.finalized_at = utcnow()
        elif payload.status == "aberto":
            s.finalized_at = None
        s.status = payload.status
    s.updated_at = utcnow()
    session.add(s)
    session.commit()
    session.refresh(s)
    return _out(s)


@router.delete("/{study_id}")
def delete_study(study_id: int, session: SessionDep, user: CurrentUser):
    """Apaga só o estudo (o "envelope"): análises, referências, curvas e
    deconvoluções continuam onde estão."""
    s = _get(session, study_id)
    if s.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou o estudo (ou um admin) pode apagá-lo")
    session.delete(s)
    session.commit()
    return {"ok": True}


def _check_open(s: PostrunStudy) -> None:
    if s.status == "finalizado":
        raise HTTPException(status.HTTP_409_CONFLICT, "Estudo finalizado — reabra para mudar o que ele guarda")


@router.post("/{study_id}/items", response_model=StudyOut)
def change_items(study_id: int, payload: StudyItemsChangeIn, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    _check_open(s)
    a, r = payload.add, payload.remove
    s.tokens = _merge(s.tokens, a.tokens, r.tokens)
    s.reference_ids = _merge(s.reference_ids, a.reference_ids, r.reference_ids)
    s.curve_ids = _merge(s.curve_ids, a.curve_ids, r.curve_ids)
    s.calibration_ids = _merge(s.calibration_ids, a.calibration_ids, r.calibration_ids)
    s.updated_at = utcnow()
    session.add(s)
    session.commit()
    session.refresh(s)
    return _out(s)


@router.post("/{study_id}/collect", response_model=StudyOut)
def collect(study_id: int, payload: StudyCollectIn, session: SessionDep, _user: CurrentUser):
    """"Guardar o workspace no estudo": as análises abertas e, junto, as
    referências/moldes que as deconvoluções delas usam (e as dos puros que
    estão nelas) e as curvas que usam pontos delas ou que o relatório usaria."""
    s = _get(session, study_id)
    _check_open(s)
    s.tokens = _merge(s.tokens, list(payload.tokens))
    tokens = set(_ids(s.tokens))
    if not tokens:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Abra as análises do estudo antes de guardar")

    refs: list[int] = []
    for row in session.exec(select(PostrunDeconvolution).where(
        PostrunDeconvolution.token.in_(list(tokens)), PostrunDeconvolution.channel == s.channel  # type: ignore[union-attr]
    )).all():
        refs.extend(json.loads(row.reference_ids or "[]"))
    for ref in session.exec(select(PostrunDeconvReference).where(PostrunDeconvReference.channel == s.channel)).all():
        if tokens & set(json.loads(ref.tokens or "[]")):
            refs.append(ref.id)
    s.reference_ids = _merge(s.reference_ids, [i for i in refs if session.get(PostrunDeconvReference, i) is not None])

    curves: list[int] = []
    for c in session.exec(select(PostrunCurve).where(PostrunCurve.channel == s.channel)).all():
        if tokens & {p.get("token") for p in json.loads(c.points or "[]")}:
            curves.append(c.id)
    s.curve_ids = _merge(s.curve_ids, curves)
    for method in METHODS_SAVED:
        rep, _ = _report(session, s, method)
        curves.extend(c.id for c in rep.curves)
    s.curve_ids = _merge(s.curve_ids, curves)
    s.updated_at = utcnow()
    session.add(s)
    session.commit()
    session.refresh(s)
    return _out(s)


@router.post("/{study_id}/report", response_model=StudyReportOut)
def study_report(study_id: int, session: SessionDep, _user: CurrentUser, method: str | None = None):
    s = _get(session, study_id)
    m = check_method(method or s.method)
    frozen = _frozen(s, m)
    if frozen is not None:
        return StudyReportOut(report=frozen, frozen=True)
    rep, _ = _report(session, s, m)
    head = json.loads(s.headline) if s.headline else {}
    head[m] = _headline(rep)
    s.headline = json.dumps(head)
    session.add(s)
    session.commit()
    return StudyReportOut(report=rep)


# ------------------------------------------------------------------ Excel absoluto

def _safe_name(name: str) -> str:
    return re.sub(r"[^\w\-]+", "_", name).strip("_") or "estudo"


def _stem(filename: str) -> str:
    return re.sub(r"\.B00$", "", filename, flags=re.IGNORECASE)


def build_export(session: SessionDep, s: PostrunStudy) -> bytes:
    from openpyxl import Workbook
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook(write_only=True)
    bold = Font(bold=True)
    fill = PatternFill("solid", fgColor="DDE6F3")

    def sheet(title: str, header: list[str], rows, widths: dict[int, int] | None = None):
        ws = wb.create_sheet(title)
        for i, h in enumerate(header, start=1):
            ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(i, max(10, min(40, len(h) + 2)))
        ws.freeze_panes = "A2"
        cells = []
        for h in header:
            c = WriteOnlyCell(ws, value=h)
            c.font = bold
            c.fill = fill
            c.alignment = Alignment(wrap_text=True, vertical="top")
            cells.append(c)
        ws.append(cells)
        for r in rows:
            ws.append([("" if v is None else v) for v in r])

    pct = (lambda v: None if v is None else 100.0 * v)
    tokens = _ids(s.tokens)
    infos: dict[str, _AnalysisInfo] = {}
    summaries: dict[str, AnalysisSummaryOut] = {}
    failed: list[list] = []
    for t in tokens:
        try:
            summaries[t] = _info(session, t, infos).summary
        except HTTPException as exc:
            failed.append([t, str(exc.detail)])

    reports: dict[str, ReportOut] = {}
    deconvs: dict[str, dict[str, PostrunDeconvolution]] = {}
    for method in METHODS_SAVED:
        frozen = _frozen(s, method)
        rep, rows = _report(session, s, method, infos)
        if frozen is not None:
            rep = frozen
        if rep.runs:
            reports[method] = rep
            deconvs[method] = rows
    main = s.method if s.method in reports else next(iter(reports), s.method)

    # Sobre — chave/valor (o importador do Resultados confere `formato`)
    about = [
        ["formato", EXPORT_FORMAT], ["versao", EXPORT_VERSION], ["estudo", s.name], ["descricao", s.description],
        ["metodo", main], ["metodos_no_arquivo", ", ".join(reports)], ["canal", s.channel], ["status", s.status],
        ["criado_em", s.created_at.isoformat()],
        ["finalizado_em", s.finalized_at.isoformat() if s.finalized_at else ""],
        ["gerado_em", datetime.now(timezone.utc).isoformat()],
        ["analises", len(tokens)], ["referencias", len(_ids(s.reference_ids))], ["curvas", len(_ids(s.curve_ids))],
        ["calibracoes", len(_ids(s.calibration_ids))],
        ["leia", "Aba Horun_Resultados = formato longo para importar no módulo Resultados; as demais são para consulta."],
    ]
    sheet("Sobre", ["Chave", "Valor"], about, {1: 22, 2: 90})

    # Recuperação — médias por composição, por método
    rows = []
    for method, rep in reports.items():
        for g in rep.groups:
            for m in g.materials:
                rows.append([
                    method, g.key, g.n_runs, m.material, pct(m.fraction), m.recovery_pct.mean, m.recovery_pct.sd,
                    m.recovery_pct.n, m.expected_mg.mean, m.found_mg.mean, m.found_mg.sd, m.delta_mu_c.mean,
                    m.delta_mu_c.sd, m.delta_width_pct.mean, m.delta_width_pct.sd, g.total_recovery_pct.mean,
                    g.total_recovery_pct.sd, g.total_recovery_pct.n, " + ".join(g.polyolefins),
                    g.polyolefins_recovery_pct.mean, g.polyolefins_recovery_pct.sd,
                    g.polyolefins_recovery_pct.n if g.polyolefins else None, g.r2_min, g.cycle_label,
                ])
    sheet("Recuperação (médias)", [
        "Método", "Composição", "Réplicas", "Componente", "Fração nominal (%)", "Recuperação média (%)",
        "dp recuperação (%)", "n", "Massa esperada média (mg)", "Massa encontrada média (mg)", "dp massa (mg)",
        "ΔTmax médio (°C)", "dp ΔTmax (°C)", "Δlargura média (%)", "dp Δlargura (%)",
        "Recuperação total média (%) — Σ encontrada ÷ massa pesada", "dp recuperação total (%)", "n total",
        "Poliolefinas somadas", "Recuperação poliolefinas média (%)", "dp recuperação poliolefinas (%)",
        "n poliolefinas", "R² mínimo", "Ciclo",
    ], rows, {2: 30, 16: 30, 24: 40})

    # Horun_Resultados — formato longo (contrato com o módulo Resultados)
    def res_rows():
        for method, rep in reports.items():
            for r in rep.runs:
                sm = summaries.get(r.token)
                date = sm.date.date().isoformat() if sm and sm.date else ""
                # Amostra = o grupo das réplicas (composição nominal); Réplica = o arquivo
                base = [s.name, method, r.group, _stem(r.filename), r.composition_text]
                for m in r.materials:
                    fr = [pct(m.fraction), pct(m.real_fraction), r.mass_mg, date]
                    for name, val, unit, u in (
                        ("Massa encontrada", m.found_mg, "mg", m.U95_mg), ("Massa esperada", m.expected_mg, "mg", None),
                        ("Recuperação", m.recovery_pct, "%",
                         100.0 * m.U95_mg / m.expected_mg if m.U95_mg is not None and m.expected_mg else None),
                        ("ΔTmax", m.delta_mu_c, "°C", None), ("Δlargura", m.delta_width_pct, "%", None),
                    ):
                        yield [*base, m.material, name, val, unit, u, *fr]
                run_fr = [None, None, r.mass_mg, date]
                yield [*base, "", "Recuperação total", r.total_recovery_pct, "%", None, *run_fr]
                if r.polyolefins_recovery_pct is not None:
                    yield [*base, "", "Recuperação poliolefinas", r.polyolefins_recovery_pct, "%", None, *run_fr]
                yield [*base, "", "Massa encontrada total", r.total_found_mg, "mg", None, *run_fr]
                yield [*base, "", "R²", r.r2, "", None, *run_fr]
    sheet("Horun_Resultados", [
        "Estudo", "Método", "Amostra", "Réplica", "Composição", "Componente", "Parâmetro", "Valor", "Unidade", "U95",
        "Fração nominal (%)", "Fração real (%)", "Massa da amostra (mg)", "Data",
    ], res_rows(), {3: 24, 4: 34, 5: 24, 7: 22})

    # Réplicas — cada corrida e componente, por método
    rows = []
    for method, rep in reports.items():
        for r in rep.runs:
            for m in r.materials:
                rows.append([
                    method, r.group, r.sample, _stem(r.filename), r.mass_mg, r.mass_source, m.material,
                    pct(m.fraction), pct(m.real_fraction), m.expected_source, m.expected_mg, m.found_mg, m.U95_mg,
                    m.recovery_pct, r.total_recovery_pct, m.tpk_c, m.delta_mu_c, m.delta_width_pct, m.area_s,
                    m.u_area_s, m.n_peaks, r.r2, r.bic, r.shape, r.mode, "; ".join(m.flags + r.warnings),
                ])
    sheet("Réplicas", [
        "Método", "Composição", "Amostra", "Réplica", "Massa (mg)", "Massa de", "Componente", "Fração nominal (%)",
        "Fração real (%)", "Esperada de", "Massa esperada (mg)", "Massa encontrada (mg)", "U95 (mg)", "Recuperação (%)",
        "Recuperação total (%)", "Tpico (°C)", "ΔTmax (°C)", "Δlargura (%)", "Área (sinal·s)", "u área (sinal·s)",
        "Picos", "R²", "BIC", "Forma", "Modo", "Avisos",
    ], rows, {2: 30, 4: 34, 26: 60})

    # Análises
    rows = []
    for t in tokens:
        sm = summaries.get(t)
        if sm is None:
            continue
        rows.append([
            _stem(sm.filename), sm.sample, sm.job, sm.date.isoformat() if sm.date else "", sm.cycle_label, sm.mass_mg,
            sm.mass_source, sm.quantity_mg, sm.composition_text,
            "; ".join(f"{k} {v:g}" for k, v in (sm.component_masses or {}).items()),
            ", ".join(sorted(m for m in METHODS_SAVED if t in deconvs.get(m, {}))), t,
        ])
    sheet("Análises", [
        "Réplica", "Amostra", "Job", "Data", "Ciclo", "Massa usada (mg)", "Massa de", "Massa no .B00 (mg)",
        "Composição", "Massas reais (mg)", "Deconvoluções salvas", "Caminho",
    ], rows + [[t, "", "", "", "", None, "", None, "", "", "", f"não lida: {e}"] for t, e in failed], {1: 34, 5: 40, 12: 60})

    # Curvas de calibração e os pontos
    curves = [c for c in (session.get(PostrunCurve, i) for i in _ids(s.curve_ids)) if c is not None]
    rows, pts = [], []
    for c in curves:
        fit = json.loads(c.fit) if c.fit else {}
        coef = fit.get("coef") or []
        rows.append([
            c.id, c.name, c.component or "(amostra)", c.deconv_method or "gauss", c.area_source, c.x_kind, c.model,
            c.weighting, fit.get("equation", ""), *(coef + [None, None, None])[:3], fit.get("r2"), fit.get("s"),
            fit.get("s_y"), fit.get("n"), fit.get("dof"), fit.get("lod"), fit.get("loq"), fit.get("x_min"),
            fit.get("x_max"), fit.get("rf_mean"), fit.get("rf_cv_pct"), "; ".join(fit.get("warnings") or []),
            c.cycle_label, c.notes,
        ])
        for p in json.loads(c.points or "[]"):
            pts.append([
                c.id, c.name, _stem(p.get("filename", "")), p.get("sample"), p.get("gaussian") or p.get("label"),
                p.get("x"), p.get("area_s"), p.get("u_area_s"), p.get("area_per_mg"), p.get("residual"),
                "sim" if p.get("excluded") else "", p.get("mass_mg"), pct(p.get("fraction")), p.get("peak_temp"),
                p.get("start_idx"), p.get("end_idx"), p.get("baseline_mode"), p.get("error"),
            ])
    sheet("Curvas de calibração", [
        "Id", "Curva", "Componente", "Método", "Área de", "Eixo X", "Modelo", "Ponderação", "Equação", "b0", "b1", "b2",
        "R²", "s", "s_y", "n", "gl", "LD (mg)", "LQ (mg)", "Faixa mín. (mg)", "Faixa máx. (mg)", "FR médio",
        "CV FR (%)", "Avisos", "Ciclo", "Notas",
    ], rows, {2: 30, 9: 40, 24: 50, 25: 40})
    sheet("Pontos das curvas", [
        "Id da curva", "Curva", "Réplica", "Amostra", "Pico / região", "Massa X (mg)", "Área (sinal·s)", "u área",
        "Área / mg", "Resíduo", "Excluído", "Massa da amostra (mg)", "Fração (%)", "Tpico (°C)", "Início (idx)",
        "Fim (idx)", "Linha de base", "Erro",
    ], pts, {2: 30, 3: 34})

    # Referências, moldes e as corridas puras de cada molde
    refs = [r for r in (session.get(PostrunDeconvReference, i) for i in _ids(s.reference_ids)) if r is not None]
    rows, mold_rows, run_rows = [], [], []
    for ref in refs:
        for i, p in enumerate(json.loads(ref.peaks or "[]"), start=1):
            rows.append([ref.id, ref.name, i, p.get("mu_c"), p.get("sd_mu_c"), p.get("sigma_l_s"), p.get("sigma_r_s"),
                         p.get("sd_sigma_pct"), ref.n_runs, ref.shape, "sim" if ref.template else "", ref.cycle_label,
                         ref.notes])
        if not ref.template:
            continue
        try:
            det = reference_detail(ref.id, session, None)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 — sem o detalhe, a aba sai sem este molde
            continue
        for k, tau in enumerate(det.tau):
            mold_rows.append([ref.id, ref.name, tau, det.mold[k] if k < len(det.mold) else None,
                              det.sd[k] if k < len(det.sd) else None])
        for r in det.runs:
            run_rows.append([ref.id, ref.name, _stem(r.filename), r.sample, r.mass_mg, "sim" if r.ok else r.error,
                             r.max_c, r.area_s, r.fwhm_s, r.stretch, None if r.stretch is None else 100 * (r.stretch - 1),
                             r.rms_pct])
    sheet("Referências", ["Id", "Material", "Pico", "Tpico (°C)", "dp Tpico (°C)", "σ esq. (s)", "σ dir. (s)",
                          "dp largura (%)", "Corridas", "Forma", "Molde", "Ciclo", "Notas"], rows, {12: 40})
    sheet("Moldes (pontos)", ["Id", "Material", "τ (s, relativo ao máximo)", "Molde (área 1)", "dp entre corridas"],
          mold_rows)
    sheet("Puros dos moldes", ["Id", "Material", "Réplica", "Amostra", "Massa (mg)", "Ok", "Tmax (°C)",
                               "Área (sinal·s)", "Largura ½ altura (s)", "Dilatação (×)", "Dilatação (%)",
                               "Forma ≠ molde (RMS %)"], run_rows, {3: 34})

    # Dilatação natural
    rows = [[method, mat, st.mean, st.sd, st.n] for method, rep in reports.items() for mat, st in rep.natural_width.items()]
    sheet("Dilatação natural", ["Método", "Material", "Média (%)", "dp (%)", "Corridas puras"], rows)

    # Deconvoluções: parâmetros de cada pico e as curvas ponto a ponto
    peak_rows = []
    mats = sorted({m.material for rep in reports.values() for r in rep.runs for m in r.materials})

    def curve_rows():
        for method, by_token in deconvs.items():
            for token, row in by_token.items():
                try:
                    d = _from_row(session, row)
                except Exception:  # noqa: BLE001
                    continue
                name = _stem(summaries[token].filename) if token in summaries else token
                for p in d.peaks:
                    peak_rows.append([
                        name, method, row.mode, row.shape, p.name, p.material, p.mu_c, p.ref_mu_c, p.delta_mu_c,
                        p.delta_width_pct, p.stretch, p.fwhm_c, p.pure_fwhm_c, p.area_s, p.u_area_s, p.pct_of_total,
                        "sim" if p.at_bound else "", d.r2, d.rmse, d.bic, row.tol_c, row.tol_width_pct, row.start_idx,
                        row.end_idx, row.baseline_mode, "; ".join(d.warnings),
                    ])
                c = d.curve
                if c is None:
                    continue
                comp_of = {p.material: k for k, p in enumerate(d.peaks)}
                temps = c.temps or [None] * len(c.idx)
                for k, idx in enumerate(c.idx):
                    comps = [c.components[comp_of[m]][k] if m in comp_of and comp_of[m] < len(c.components) else None
                             for m in mats]
                    pures = [c.pure_components[comp_of[m]][k]
                             if m in comp_of and comp_of[m] < len(c.pure_components) and c.pure_components[comp_of[m]]
                             else None for m in mats]
                    yield [name, method, idx, temps[k], c.signal[k], c.fitted[k], *comps, *pures]

    curve_header = ["Réplica", "Método", "idx", "T (°C)", "Sinal − linha de base", "Ajuste (soma)",
                    *[f"Componente {m}" for m in mats], *[f"Molde do puro {m}" for m in mats]]
    sheet("Deconvoluções (pontos)", curve_header, curve_rows(), {1: 34})
    sheet("Deconvoluções (picos)", [
        "Réplica", "Método", "Modo", "Forma", "Pico", "Material", "Tpico (°C)", "Tpico ref. (°C)", "ΔTmax (°C)",
        "Δlargura (%)", "Dilatação (×)", "Largura ½ alt. (°C)", "Largura ½ alt. puro (°C)", "Área (sinal·s)",
        "u área", "% do total", "No limite", "R²", "RMSE", "BIC", "Tol. centro (± °C)", "Tol. largura (± %)",
        "Início (idx)", "Fim (idx)", "Linha de base", "Avisos",
    ], peak_rows, {1: 34, 26: 60})

    # Sinais FID brutos (pirólise) de cada análise
    def signal_rows():
        for t in tokens:
            info = infos.get(t)
            if info is None or info.analysis.pyro is None:
                continue
            cv = info.analysis.pyro
            fid = cv.channels.get("FID")
            if not fid:
                continue
            spp = postrun_timebase.time_base(cv, info.analysis.header.cycle_pyro).seconds_per_point
            name = _stem(info.summary.filename)
            for k, idx in enumerate(cv.idx):
                yield [name, idx, idx * spp, cv.temp[k] if k < len(cv.temp) else None, fid[k]]
    sheet("Sinais FID (pirólise)", ["Réplica", "idx", "t (s)", "T (°C)", "FID (bruto)"], signal_rows(), {1: 34})

    # Calibrações STD
    cals = [c for c in (session.get(PostrunCalibration, i) for i in _ids(s.calibration_ids)) if c is not None]
    rows, cal_pts = [], []
    for c in cals:
        out = _calibration_out(c, None, session)
        rows.append([c.id, c.name, c.channel, c.mode, c.k0, c.k1, c.r2, c.validated_at.isoformat(), c.notes])
        for p in out.source_points:
            cal_pts.append([c.id, c.name, p.standard_name, p.token, p.area, p.known_mg, p.mass_mg])
    sheet("Calibrações STD", ["Id", "Nome", "Canal", "Modo", "k0", "k1", "R²", "Validada em", "Notas"], rows, {2: 30})
    sheet("Calibrações STD (pontos)", ["Id", "Calibração", "Padrão", "Análise", "Área", "Massa conhecida (mg)",
                                       "Massa da amostra (mg)"], cal_pts, {2: 30, 4: 60})

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@router.get("/{study_id}/export.xlsx")
def export_study(study_id: int, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    content = build_export(session, s)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="estudo_{_safe_name(s.name)}_{stamp}.xlsx"'},
    )


# ------------------------------------------------------------------ tolerância ótima

class SensitivityIn(BaseModel):
    # tolerâncias de largura (± %) a testar
    tolerances: list[float] = [10, 15, 20, 25, 30, 40, 50, 60, 80]


class SensPointOut(BaseModel):
    tol_width_pct: float
    rmse: float | None = None  # √média (recuperação − 100)², todos os componentes das misturas
    rmse_by_material: dict[str, float] = {}
    rmse_total: float | None = None  # da recuperação total de cada mistura
    n: int = 0  # componentes com recuperação
    n_at_bound: int = 0  # componentes no limite da tolerância
    n_failed: int = 0  # misturas que não ajustaram
    mean_r2: float | None = None
    # composição → material → recuperação média
    recovery_by_group: dict[str, dict[str, float]] = {}
    # Δlargura ajustada (%) por material, só dos picos que NÃO bateram no limite
    width_by_material: dict[str, Stat] = {}


class LocoOut(BaseModel):
    group: str
    chosen_tol: float | None = None  # a ótima sem esta composição
    rmse_at_group: float | None = None  # o erro desta composição com ela


class SensitivityOut(BaseModel):
    points: list[SensPointOut]
    best_tol: float | None = None
    best_rmse: float | None = None
    loco: list[LocoOut] = []
    rmse_loco: float | None = None
    saved_tol: list[float] = []  # tolerâncias das deconvoluções salvas das misturas
    natural_width: dict[str, Stat] = {}
    n_mixtures: int = 0
    errors: list[str] = []


def _rmse(errs: list[float]) -> float | None:
    return math.sqrt(sum(e * e for e in errs) / len(errs)) if errs else None


@router.post("/{study_id}/sensitivity", response_model=SensitivityOut)
def sensitivity(study_id: int, payload: SensitivityIn, session: SessionDep, _user: CurrentUser):
    """Tolerância de largura ótima do sistema (pedido do usuário, 23/10/2026):
    reajusta as MISTURAS do estudo (modo molde) em cada tolerância, SEM gravar,
    e mede o quanto a recuperação de cada componente erra em relação às massas
    conhecidas (RMSE de recuperação − 100). As curvas e os puros ficam fixos.
    Validação "deixa uma composição de fora": escolhe a tolerância sem ela e
    mede o erro nela — se a escolha muda muito, a tolerância é instável."""
    s = _get(session, study_id)
    tols = sorted({float(t) for t in payload.tolerances if 0 < t <= 300})
    if not tols:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Informe as tolerâncias (± %) a testar")
    infos: dict[str, _AnalysisInfo] = {}
    rows: dict[str, PostrunDeconvolution] = {}
    errors: list[str] = []
    for t in _ids(s.tokens):
        row = saved_row(session, t, s.channel, "molde")
        if row is None or row.mode != "template":
            continue
        try:
            comp = _info(session, t, infos).summary.composition or {}
        except HTTPException as exc:
            errors.append(f"{t}: {exc.detail}")
            continue
        if len(comp) > 1:
            rows[t] = row
    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nenhuma mistura do estudo tem deconvolução por molde salva")
    curve_ids = _curve_overrides(session, s, "molde")

    per_tol: dict[float, list[tuple[str, str, float]]] = {}
    points: list[SensPointOut] = []
    natural: dict[str, Stat] = {}
    for tol in tols:
        override: dict[str, PostrunDeconvolution] = {}
        failed = 0
        for t, row in rows.items():
            spec = DeconvSpecIn(
                token=row.token, channel=row.channel, start_idx=row.start_idx, end_idx=row.end_idx,
                baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline, shape=row.shape, mode=row.mode,
                n_peaks=row.n_peaks, reference_ids=json.loads(row.reference_ids or "[]"), tol_c=row.tol_c,
                tol_width_pct=tol, names=json.loads(row.names or "[]"), guesses_c=json.loads(row.guesses_c or "[]"),
            )
            try:
                res = _compute(session, spec)
            except HTTPException as exc:
                failed += 1
                if tol == tols[0]:
                    errors.append(f"{t}: {exc.detail}")
                continue
            # linha só em memória (nunca vai para a sessão), com o resultado no formato salvo
            override[t] = PostrunDeconvolution(
                token=row.token, channel=row.channel, method="molde", start_idx=row.start_idx, end_idx=row.end_idx,
                baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline, shape=row.shape, mode=row.mode,
                n_peaks=row.n_peaks, reference_ids=row.reference_ids, tol_c=row.tol_c, tol_width_pct=tol,
                names=row.names, guesses_c=row.guesses_c, created_by_id=row.created_by_id,
                result=json.dumps(res.model_dump(mode="json", exclude={"spec", "curve", "id", "updated_at", "method"})),
            )
        rep, _ = build_report(session, ReportIn(tokens=list(override), channel=s.channel, method="molde",
                                                curve_ids=curve_ids), infos, override)
        natural = natural or rep.natural_width
        errs: list[tuple[str, str, float]] = []
        totals: list[float] = []
        bound = 0
        widths: dict[str, list[float]] = {}
        for r in rep.runs:
            if r.total_recovery_pct is not None:
                totals.append(r.total_recovery_pct - 100.0)
            for m in r.materials:
                at_bound = any("limite" in f for f in m.flags)
                bound += int(at_bound)
                if m.recovery_pct is not None:
                    errs.append((r.group, m.material, m.recovery_pct - 100.0))
                if m.delta_width_pct is not None and not at_bound:
                    widths.setdefault(m.material, []).append(m.delta_width_pct)
        per_tol[tol] = errs
        by_group: dict[str, dict[str, list[float]]] = {}
        for g, mat, e in errs:
            by_group.setdefault(g, {}).setdefault(mat, []).append(100.0 + e)
        mats = sorted({mat for _, mat, _ in errs})
        r2s = [r.r2 for r in rep.runs if r.r2 == r.r2]
        by_mat = {mat: _rmse([e for _, m_, e in errs if m_ == mat]) for mat in mats}
        points.append(SensPointOut(
            tol_width_pct=tol, rmse=_rmse([e for *_, e in errs]),
            rmse_by_material={k: v for k, v in by_mat.items() if v is not None},
            rmse_total=_rmse(totals), n=len(errs), n_at_bound=bound, n_failed=failed,
            mean_r2=sum(r2s) / len(r2s) if r2s else None,
            recovery_by_group={g: {mat: sum(v) / len(v) for mat, v in d.items()} for g, d in by_group.items()},
            width_by_material={mat: _stat_of(v) for mat, v in widths.items()},
        ))

    # empate (platô: acima de certa tolerância nenhum pico bate mais no limite e o
    # ajuste não muda) — fica a MENOR tolerância que já atinge o mínimo (± 1 %)
    scored = [p for p in points if p.rmse is not None]
    best = None
    if scored:
        low = min(p.rmse or 0.0 for p in scored)
        best = next(p for p in scored if (p.rmse or 0.0) <= low * 1.01 + 1e-9)

    # deixa uma composição de fora
    groups = sorted({g for errs in per_tol.values() for g, *_ in errs})
    loco: list[LocoOut] = []
    loco_errs: list[float] = []
    if len(groups) > 1:
        for g in groups:
            cands = []
            for tol, errs in per_tol.items():
                rest = _rmse([e for g_, _, e in errs if g_ != g])
                if rest is not None:
                    cands.append((rest, tol))
            if not cands:
                continue
            low = min(c[0] for c in cands)
            chosen = min(tol for rest, tol in cands if rest <= low * 1.01 + 1e-9)
            mine = [e for g_, _, e in per_tol[chosen] if g_ == g]
            loco.append(LocoOut(group=g, chosen_tol=chosen, rmse_at_group=_rmse(mine)))
            loco_errs.extend(mine)
    return SensitivityOut(
        points=points, best_tol=best.tol_width_pct if best else None, best_rmse=best.rmse if best else None,
        loco=loco, rmse_loco=_rmse(loco_errs), saved_tol=sorted({r.tol_width_pct for r in rows.values()}),
        natural_width=natural, n_mixtures=len(rows), errors=errors,
    )
