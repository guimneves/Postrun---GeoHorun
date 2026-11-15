"""Relatório de recuperação e interferência do PostRun (Fase 4, pedido do
usuário de 16/10/2026): para cada mistura (réplicas = análises com a mesma
composição e o mesmo ciclo), a média ± desvio da recuperação %, do ΔTmax
e da Δlargura de cada componente, e a recuperação total.

Parte das deconvoluções SALVAS das análises escolhidas: cada material
(soma dos picos dele) é quantificado pela curva de gaussiana do material
(a mais recente do mesmo canal e ciclo, ou a escolhida na tela). O mesmo
cálculo alimenta a tela (`/report/recovery`) e o Excel
(`/report/recovery.xlsx`).
"""

from __future__ import annotations

import io
import json
import math
from datetime import datetime, timezone
from statistics import mean, stdev

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import _AnalysisInfo, _fit_from_json, _info
from app.api.routes_postrun_deconv import check_method, saved_row
from app.db.models import PostrunCurve, PostrunDeconvolution, PostrunDeconvReference
from app.modules import postrun_deconv, postrun_regression

router = APIRouter(prefix="/postrun/report", tags=["postrun"])


# ---------------------------------------------------------------- schemas

class ReportIn(BaseModel):
    tokens: list[str]
    channel: str = "pyro:FID"
    # material -> id da curva (vazio = a de gaussiana mais recente do material)
    curve_ids: dict[str, int] = {}
    # de qual deconvolução salva vêm as áreas: "gauss" ou "molde" — e as
    # curvas usadas são as do mesmo método (17/10/2026)
    method: str = "gauss"


class RunMaterialOut(BaseModel):
    material: str
    fraction: float | None = None
    n_peaks: int
    area_s: float
    u_area_s: float
    tpk_c: float | None = None
    delta_mu_c: float | None = None
    delta_width_pct: float | None = None
    found_mg: float | None = None
    U95_mg: float | None = None
    expected_mg: float | None = None
    recovery_pct: float | None = None
    # fração real (massas pesadas) e de onde veio a esperada
    real_fraction: float | None = None
    expected_source: str = "fração nominal × massa"  # ou "massa real pesada"
    flags: list[str] = []


class RunOut(BaseModel):
    token: str
    filename: str
    sample: str
    group: str
    composition_text: str
    mass_mg: float
    mass_source: str
    shape: str
    mode: str
    r2: float
    bic: float
    warnings: list[str]
    total_found_mg: float | None = None
    # recuperação total = Σ massas encontradas ÷ massa pesada da corrida (ou Σ
    # massas reais dos componentes, quando informadas) — F1 do artigo
    total_recovery_pct: float | None = None
    # poliolefinas somadas (PEAD + PP…), quando a mistura tem duas ou mais: a
    # divisão da área entre elas é a parte incerta, a soma não (F1)
    polyolefins_found_mg: float | None = None
    polyolefins_recovery_pct: float | None = None
    # massas reais pesadas (mg) por componente, se informadas
    component_masses: dict[str, float] | None = None
    materials: list[RunMaterialOut]


class Stat(BaseModel):
    mean: float | None = None
    sd: float | None = None
    n: int = 0


class GroupMaterialOut(BaseModel):
    material: str
    fraction: float | None
    expected_mg: Stat
    found_mg: Stat
    recovery_pct: Stat
    delta_mu_c: Stat
    delta_width_pct: Stat


class GroupOut(BaseModel):
    key: str
    composition: dict[str, float]
    cycle_label: str
    n_runs: int
    total_recovery_pct: Stat
    # materiais somados em `polyolefins_recovery_pct` (vazio = não se aplica)
    polyolefins: list[str] = []
    polyolefins_recovery_pct: Stat = Stat()
    r2_min: float
    n_runs_with_warnings: int
    materials: list[GroupMaterialOut]


class CurveUsedOut(BaseModel):
    material: str
    id: int
    name: str
    equation: str
    r2: float
    lod: float | None
    loq: float | None
    x_min: float
    x_max: float
    cycle_label: str


class SkippedOut(BaseModel):
    token: str
    reason: str


class ReportOut(BaseModel):
    channel: str
    method: str = "gauss"
    groups: list[GroupOut]
    runs: list[RunOut]
    curves: list[CurveUsedOut]
    missing_curves: list[str]
    skipped: list[SkippedOut]
    # dilatação natural dos puros (largura de cada corrida ÷ molde − 1, %), por
    # material: a faixa que a variação entre corridas puras já explica
    natural_width: dict[str, Stat] = {}


# ------------------------------------------------------------------ cálculo

def _stat(values: list[float | None]) -> Stat:
    xs = [v for v in values if v is not None and math.isfinite(v)]
    if not xs:
        return Stat()
    return Stat(mean=mean(xs), sd=stdev(xs) if len(xs) > 1 else None, n=len(xs))


def _group_key(composition: dict[str, float] | None, cycle_key: str) -> str:
    if not composition:
        return "composição desconhecida"
    parts = sorted(composition.items(), key=lambda kv: (-kv[1], kv[0]))
    return " · ".join(f"{name} {100 * frac:.4g} %" for name, frac in parts)


def _curve_for(session: SessionDep, material: str, channel: str, cycle_key: str,
               overrides: dict[str, int], cache: dict, method: str = "gauss") -> PostrunCurve | None:
    key = (material, cycle_key)
    if key in cache:
        return cache[key]
    curve = None
    if material in overrides:
        c = session.get(PostrunCurve, overrides[material])
        curve = c if c is not None and c.cycle_key == cycle_key and c.channel == channel \
            and (c.deconv_method or "gauss") == method else None
    if curve is None and material not in overrides:
        curve = session.exec(
            select(PostrunCurve)
            .where(PostrunCurve.area_source == "gaussian", PostrunCurve.component == material,
                   PostrunCurve.channel == channel, PostrunCurve.cycle_key == cycle_key,
                   PostrunCurve.deconv_method == method)
            .order_by(PostrunCurve.updated_at.desc())
        ).first()
    cache[key] = curve
    return curve


# Poliolefinas (F1): PE de todas as densidades e PP — picos muito sobrepostos
# na pirólise, então a soma delas é reportada junto das recuperações separadas.
POLYOLEFINS = frozenset({"PE", "PEAD", "PEBD", "PELBD", "HDPE", "LDPE", "LLDPE", "PP"})


def is_polyolefin(material: str) -> bool:
    return material.strip().upper() in POLYOLEFINS


def polyolefin_sum(materials: list[RunMaterialOut]) -> tuple[list[str], float | None, float | None]:
    """(materiais somados, massa encontrada, recuperação %) das poliolefinas de
    uma corrida — só quando há duas ou mais e todas foram quantificadas e têm
    massa esperada; senão a soma não diria o que parece dizer."""
    polys = [m for m in materials if is_polyolefin(m.material)]
    names = [m.material for m in polys]
    if len(polys) < 2:
        return [], None, None
    if any(m.found_mg is None or not m.expected_mg for m in polys):
        return names, None, None
    found = sum(m.found_mg for m in polys)  # type: ignore[misc]
    expected = sum(m.expected_mg for m in polys)  # type: ignore[misc]
    return names, found, 100.0 * found / expected


def build_report(session: SessionDep, payload: ReportIn,
                 infos: dict[str, _AnalysisInfo] | None = None,
                 rows_override: dict[str, PostrunDeconvolution] | None = None) -> tuple[ReportOut, dict]:
    # `rows_override`: deconvoluções reajustadas na hora, NÃO gravadas (sensibilidade
    # à tolerância do estudo) — no lugar das salvas dessas análises
    # `infos`: cache das análises já lidas (o Excel do estudo chama várias vezes)
    infos = {} if infos is None else infos
    curve_cache: dict = {}
    runs: list[RunOut] = []
    skipped: list[SkippedOut] = []
    missing: set[str] = set()
    used_curves: dict[int, tuple[str, PostrunCurve]] = {}
    deconv_rows: dict[str, PostrunDeconvolution] = {}
    group_cycle: dict[str, str] = {}
    method = check_method(payload.method)

    for token in dict.fromkeys(payload.tokens):
        row = (rows_override or {}).get(token) or saved_row(session, token, payload.channel, method)
        if row is None:
            skipped.append(SkippedOut(
                token=token, reason=f"sem deconvolução {'por molde' if method == 'molde' else 'por gaussiana'} salva"
            ))
            continue
        try:
            info = _info(session, token, infos)
        except HTTPException as exc:
            skipped.append(SkippedOut(token=token, reason=str(exc.detail)))
            continue
        deconv_rows[token] = row
        s = info.summary
        data = json.loads(row.result or "{}")
        peaks = data.get("peaks", [])
        by_mat: dict[str, list[dict]] = {}
        idx_of: dict[str, list[int]] = {}
        for i, p in enumerate(peaks):
            key = p.get("material") or p.get("name", "?")
            by_mat.setdefault(key, []).append(p)
            idx_of.setdefault(key, []).append(i)
        materials: list[RunMaterialOut] = []
        for mat, ps in by_mat.items():
            main = max(ps, key=lambda p: p["area_s"])
            m = RunMaterialOut(
                material=mat, n_peaks=len(ps), area_s=sum(p["area_s"] for p in ps),
                u_area_s=postrun_deconv.material_area_u([p["u_area_s"] for p in ps], idx_of[mat], data.get("area_correlation")),
                tpk_c=main.get("mu_c"),
                delta_mu_c=main.get("delta_mu_c"), delta_width_pct=main.get("delta_width_pct"),
            )
            if any(p.get("at_bound") for p in ps):
                m.flags.append("pico no limite da tolerância")
            if s.composition is not None:
                m.fraction = s.composition.get(mat)
                if m.fraction is None:
                    m.flags.append("material fora da composição")
            real = s.component_masses or None
            if real:
                total_real = sum(real.values())
                m.real_fraction = real.get(mat, 0.0) / total_real if total_real else None
                if mat not in real:
                    m.flags.append("sem massa real informada")
            curve = _curve_for(session, mat, payload.channel, s.cycle_key, payload.curve_ids, curve_cache, method)
            if curve is None:
                missing.add(mat)
            else:
                used_curves[curve.id] = (mat, curve)
                f = _fit_from_json(json.loads(curve.fit), curve.model, curve.weighting)
                try:
                    inv = postrun_regression.inverse(f, m.area_s)
                    m.found_mg, m.U95_mg = inv.x, inv.U95
                    if inv.outside_range:
                        m.flags.append("fora da faixa da curva")
                    if inv.below_lod:
                        m.flags.append("abaixo do LD")
                    elif inv.below_loq:
                        m.flags.append("abaixo do LQ")
                except postrun_regression.FitError as exc:
                    m.flags.append(str(exc))
            if real and real.get(mat):
                # massa real pesada de cada polímero (24/10/2026): "50-50" nominal
                # não é exatamente 50-50
                m.expected_mg = real[mat]
                m.expected_source = "massa real pesada"
            elif s.mass_mg and s.mass_mg > 0 and m.fraction:
                m.expected_mg = s.mass_mg * m.fraction
            if m.expected_mg and m.found_mg is not None:
                m.recovery_pct = 100.0 * m.found_mg / m.expected_mg
            materials.append(m)
        materials.sort(key=lambda m: -(m.fraction or 0))
        group = _group_key(s.composition, s.cycle_key)
        group_cycle.setdefault(group, s.cycle_label)
        total_found = sum(m.found_mg for m in materials if m.found_mg is not None)
        all_quant = all(m.found_mg is not None for m in materials)
        real = s.component_masses or None
        total_expected = sum(real.values()) if real else s.mass_mg
        if real and s.mass_mg and abs(sum(real.values()) - s.mass_mg) > 0.03 * s.mass_mg:
            for m in materials:
                m.flags.append(f"soma das massas reais ({sum(real.values()):.3f} mg) ≠ massa da corrida ({s.mass_mg:.3f} mg)")
                break
        _poly_names, poly_found, poly_rec = polyolefin_sum(materials)
        runs.append(RunOut(
            polyolefins_found_mg=poly_found, polyolefins_recovery_pct=poly_rec,
            token=token, filename=s.filename, sample=s.sample, group=group, composition_text=s.composition_text,
            mass_mg=s.mass_mg, mass_source=s.mass_source, shape=row.shape, mode=row.mode,
            r2=data.get("r2", float("nan")), bic=data.get("bic", float("nan")), warnings=data.get("warnings", []),
            total_found_mg=total_found if all_quant else None,
            total_recovery_pct=100.0 * total_found / total_expected if all_quant and total_expected else None,
            component_masses=real, materials=materials,
        ))

    groups: list[GroupOut] = []
    for key in dict.fromkeys(r.group for r in runs):
        mine = [r for r in runs if r.group == key]
        comp = next((infos[r.token].summary.composition for r in mine if infos[r.token].summary.composition), None) or {}
        mats = list(dict.fromkeys([*comp.keys(), *(m.material for r in mine for m in r.materials)]))
        gm: list[GroupMaterialOut] = []
        for mat in mats:
            rows = [m for r in mine for m in r.materials if m.material == mat]
            gm.append(GroupMaterialOut(
                material=mat, fraction=comp.get(mat),
                expected_mg=_stat([m.expected_mg for m in rows]), found_mg=_stat([m.found_mg for m in rows]),
                recovery_pct=_stat([m.recovery_pct for m in rows]), delta_mu_c=_stat([m.delta_mu_c for m in rows]),
                delta_width_pct=_stat([m.delta_width_pct for m in rows]),
            ))
        polys = [m for m in mats if is_polyolefin(m)]
        groups.append(GroupOut(
            key=key, composition=comp, cycle_label=group_cycle.get(key, ""), n_runs=len(mine),
            total_recovery_pct=_stat([r.total_recovery_pct for r in mine]),
            polyolefins=polys if len(polys) >= 2 else [],
            polyolefins_recovery_pct=_stat([r.polyolefins_recovery_pct for r in mine]) if len(polys) >= 2 else Stat(),
            r2_min=min(r.r2 for r in mine), n_runs_with_warnings=sum(1 for r in mine if r.warnings), materials=gm,
        ))
    # misturas primeiro (mais componentes), depois os puros
    groups.sort(key=lambda g: (-len(g.composition), g.key))

    curves = []
    for cid, (mat, c) in used_curves.items():
        fit = json.loads(c.fit)
        curves.append(CurveUsedOut(
            material=mat, id=cid, name=c.name, equation=fit.get("equation", ""), r2=fit.get("r2", float("nan")),
            lod=fit.get("lod"), loq=fit.get("loq"), x_min=fit.get("x_min", 0), x_max=fit.get("x_max", 0),
            cycle_label=c.cycle_label,
        ))
    report = ReportOut(channel=payload.channel, method=method, groups=groups, runs=runs, curves=sorted(curves, key=lambda c: c.material),
                       missing_curves=sorted(missing), skipped=skipped,
                       natural_width=_natural_width(session, payload.channel, runs, infos))
    return report, deconv_rows


def _natural_width(session: SessionDep, channel: str, runs: list[RunOut], infos: dict[str, _AnalysisInfo]) -> dict[str, Stat]:
    """Dilatação natural de cada material: largura das corridas puras da
    referência ÷ largura do molde − 1 (%). Mesma conta da aba Referências."""
    from app.api.routes_postrun_deconv import reference_detail

    out: dict[str, Stat] = {}
    cycles = {infos[r.token].summary.cycle_key for r in runs if r.token in infos}
    mats = {m.material for r in runs for m in r.materials}
    for mat in sorted(mats):
        ref = session.exec(
            select(PostrunDeconvReference).where(PostrunDeconvReference.name == mat, PostrunDeconvReference.channel == channel,
                                                 PostrunDeconvReference.cycle_key.in_(cycles))  # type: ignore[union-attr]
            .order_by(PostrunDeconvReference.created_at.desc())
        ).first()
        if ref is None:
            continue
        try:
            det = reference_detail(ref.id, session, None)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 — sem a faixa, o gráfico sai sem ela
            continue
        out[mat] = _stat([100.0 * (r.stretch - 1.0) for r in det.runs if r.ok and r.stretch])
    return out


# ------------------------------------------------------------------ Excel

def _xlsx(session: SessionDep, report: ReportOut, deconvs: dict[str, PostrunDeconvolution]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    bold = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="DDE6F3")

    def sheet(ws, header: list[str], rows: list[list], widths: dict[int, int] | None = None):
        ws.append(header)
        for c in ws[1]:
            c.font = bold
            c.fill = head_fill
            c.alignment = Alignment(wrap_text=True, vertical="top")
        for r in rows:
            ws.append([("" if v is None else v) for v in r])
        ws.freeze_panes = "A2"
        for i, h in enumerate(header, start=1):
            ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(i, max(10, min(40, len(h) + 2)))

    ws = wb.active
    ws.title = "Resumo"
    rows = []
    for g in report.groups:
        for m in g.materials:
            rows.append([
                g.key, g.n_runs, m.material, None if m.fraction is None else 100 * m.fraction,
                m.expected_mg.mean, m.found_mg.mean, m.found_mg.sd, m.recovery_pct.mean, m.recovery_pct.sd, m.recovery_pct.n,
                m.delta_mu_c.mean, m.delta_mu_c.sd, m.delta_width_pct.mean, m.delta_width_pct.sd,
                g.total_recovery_pct.mean, g.total_recovery_pct.sd, g.total_recovery_pct.n,
                " + ".join(g.polyolefins), g.polyolefins_recovery_pct.mean, g.polyolefins_recovery_pct.sd,
                g.polyolefins_recovery_pct.n if g.polyolefins else None,
                g.r2_min, g.n_runs_with_warnings, g.cycle_label,
            ])
    sheet(ws, ["Mistura", "Réplicas", "Componente", "Fração (%)", "Massa esperada média (mg)", "Massa encontrada média (mg)",
               "dp massa (mg)", "Recuperação média (%)", "dp recuperação (%)", "n", "ΔTmax médio (°C)", "dp ΔTmax (°C)",
               "Δlargura média (%)", "dp Δlargura (%)",
               "Recuperação total média (%) — Σ encontrada ÷ massa pesada", "dp recuperação total (%)", "n total",
               "Poliolefinas somadas", "Recuperação poliolefinas média (%)", "dp recuperação poliolefinas (%)",
               "n poliolefinas", "R² mínimo", "Réplicas com aviso", "Ciclo"], rows, {1: 34, 15: 30, 24: 50})

    ws = wb.create_sheet("Corridas")
    rows = []
    for r in report.runs:
        for m in r.materials:
            rows.append([
                r.group, r.sample, r.filename, r.mass_mg, r.mass_source, m.material,
                None if m.fraction is None else 100 * m.fraction, m.n_peaks, m.tpk_c, m.delta_mu_c, m.delta_width_pct,
                m.area_s, m.u_area_s, m.found_mg, m.U95_mg, m.expected_mg, m.recovery_pct,
                r.total_recovery_pct, r.polyolefins_recovery_pct, r.r2, r.shape, r.mode,
                "; ".join(m.flags + r.warnings), r.token,
            ])
    sheet(ws, ["Mistura", "Amostra", "Arquivo", "Massa (mg)", "Massa de", "Componente", "Fração (%)", "Picos",
               "Tpico (°C)", "ΔTmax (°C)", "Δlargura (%)", "Área (sinal·s)", "u área", "Massa encontrada (mg)",
               "U95 (mg)", "Massa esperada (mg)", "Recuperação (%)", "Recuperação total (%)",
               "Recuperação poliolefinas (%)", "R²", "Forma", "Modo",
               "Avisos", "Caminho"], rows, {1: 34, 3: 36, 23: 60, 24: 60})

    ws = wb.create_sheet("Curvas")
    sheet(ws, ["Componente", "Curva", "Equação (A em sinal·s, m em mg)", "R²", "LD (mg)", "LQ (mg)", "Faixa mín. (mg)",
               "Faixa máx. (mg)", "Ciclo"],
          [[c.material, c.name, c.equation, c.r2, c.lod, c.loq, c.x_min, c.x_max, c.cycle_label] for c in report.curves],
          {2: 30, 3: 44, 9: 50})

    ref_ids = sorted({rid for d in deconvs.values() for rid in json.loads(d.reference_ids or "[]")})
    rows = []
    for rid in ref_ids:
        ref = session.get(PostrunDeconvReference, rid)
        if ref is None:
            continue
        for i, p in enumerate(json.loads(ref.peaks or "[]"), start=1):
            rows.append([ref.name, i, p.get("mu_c"), p.get("sd_mu_c"), p.get("sigma_l_s"), p.get("sigma_r_s"),
                         p.get("sd_sigma_pct"), ref.n_runs, ref.shape, ref.cycle_label])
    sheet(ws := wb.create_sheet("Referências"), ["Material", "Pico", "Tpico (°C)", "dp Tpico (°C)", "σ esq. (s)", "σ dir. (s)",
                                                 "dp largura (%)", "Corridas", "Forma", "Ciclo"], rows, {10: 50})

    rows = []
    for r in report.runs:
        d = deconvs.get(r.token)
        rows.append([r.filename, r.shape, r.mode, d.tol_c if d else None, d.tol_width_pct if d else None,
                     d.start_idx if d else None, d.end_idx if d else None, d.baseline_mode if d else None,
                     r.r2, r.bic, "; ".join(r.warnings)])
    sheet(wb.create_sheet("Deconvoluções"), ["Arquivo", "Forma", "Modo", "Tol. centro (± °C)", "Tol. largura (± %)",
                                              "Início (idx)", "Fim (idx)", "Baseline", "R²", "BIC", "Avisos"], rows,
          {1: 36, 11: 70})

    if report.skipped or report.missing_curves:
        notes = [[s.token, s.reason] for s in report.skipped] + [[m, "sem curva de gaussiana"] for m in report.missing_curves]
        sheet(wb.create_sheet("Fora do relatório"), ["Análise / componente", "Motivo"], notes, {1: 60, 2: 40})

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ------------------------------------------------------------------ rotas

@router.post("/recovery", response_model=ReportOut)
def recovery_report(payload: ReportIn, session: SessionDep, _user: CurrentUser):
    report, _ = build_report(session, payload)
    return report


@router.post("/recovery.xlsx")
def recovery_report_xlsx(payload: ReportIn, session: SessionDep, _user: CurrentUser):
    report, deconvs = build_report(session, payload)
    content = _xlsx(session, report, deconvs)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="postrun_recuperacao_{stamp}.xlsx"'},
    )
