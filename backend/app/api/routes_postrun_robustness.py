"""Robustez dos moldes (F8 do artigo), dentro de um estudo, para um material:

- **Deixa-uma-corrida-de-fora** (leave-one-run-out): o molde do material é
  refeito sem cada corrida pura, os puros e as misturas são reajustados com
  ele (curva do material refeita, sem gravar) e as misturas requantificadas.
  O desvio entre essas quantificações é a incerteza que vem do molde.
- **Incerteza combinada**: por mistura, u² = u_ajuste² + u_molde², com
  u_ajuste = U95 da curva ÷ 2 e u_molde = desvio da massa encontrada entre
  os moldes deixa-um-de-fora; U95 combinada = 2·u.
- **Comparação com outro molde** (outro lote, grade ou granulometria do mesmo
  material): correlação e distância L2 das formas (área 1, alinhadas pelo
  centro), diferença de posição, e a recuperação das misturas com ele no
  lugar do molde do estudo.

Nada é gravado.
"""

from __future__ import annotations

import json
import math
from statistics import mean, stdev

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_compare import _memory_row
from app.api.routes_postrun_curves import _AnalysisInfo, _fit_out, _info
from app.api.routes_postrun_deconv import DeconvSpecIn, _build_reference_template, _compute, saved_row
from app.api.routes_postrun_report import ReportIn, build_report
from app.api.routes_postrun_study import _curve_overrides, _get, _ids
from app.db.models import PostrunCurve, PostrunDeconvolution, PostrunDeconvReference
from app.modules import postrun_regression

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])


class RobustIn(BaseModel):
    material: str
    alt_reference_id: int | None = None


class LoroOut(BaseModel):
    left_out: str
    filename: str
    recovery_mean: float | None
    error: str | None = None


class CombinedOut(BaseModel):
    token: str
    filename: str
    found_mg: float | None
    u_fit_mg: float | None
    u_template_mg: float | None
    U95_combined_mg: float | None
    template_share_pct: float | None  # parte da variância que vem do molde


class TemplateCompareOut(BaseModel):
    reference_id: int
    name: str
    correlation: float | None
    l2: float | None
    l2_rel_pct: float | None
    max_c_diff: float | None
    recovery_mean: float | None
    delta_recovery: float | None  # pontos percentuais em relação ao molde do estudo


class RobustOut(BaseModel):
    material: str
    reference_id: int
    reference_name: str
    n_template_runs: int
    n_pures: int
    n_mixtures: int
    baseline_recovery: float | None
    loro: list[LoroOut]
    template_sd_recovery: float | None
    combined: list[CombinedOut]
    compare: TemplateCompareOut | None = None
    warnings: list[str] = []


def _template_json(session: SessionDep, tokens: list[str], channel: str) -> str:
    rows = [r for t in tokens if (r := saved_row(session, t, channel, "gauss")) is not None]
    if len(rows) < len(tokens):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "corridas puras do molde sem a deconvolução livre salva")
    return _build_reference_template(session, rows, [json.loads(r.result or "{}") for r in rows])


def _with_template(ref: PostrunDeconvReference, template: str) -> PostrunDeconvReference:
    return PostrunDeconvReference(**{**ref.model_dump(), "template": template})


class _Ctx:
    def __init__(self, session, study, material: str):
        self.session = session
        self.s = study
        self.mat = material
        self.infos: dict[str, _AnalysisInfo] = {}
        self.pures: dict[str, PostrunDeconvolution] = {}
        self.mixes: dict[str, PostrunDeconvolution] = {}
        self.ref: PostrunDeconvReference | None = None
        refs_count: dict[int, int] = {}
        for t in _ids(study.tokens):
            try:
                comp = _info(session, t, self.infos).summary.composition or {}
            except HTTPException:
                continue
            if material not in comp:
                continue
            row = saved_row(session, t, study.channel, "molde")
            if row is None or row.mode != "template":
                continue
            (self.pures if len(comp) == 1 else self.mixes)[t] = row
            for rid in json.loads(row.reference_ids or "[]"):
                r = session.get(PostrunDeconvReference, rid)
                if r is not None and r.name.strip().upper() == material:
                    refs_count[rid] = refs_count.get(rid, 0) + 1
        if refs_count:
            self.ref = session.get(PostrunDeconvReference, max(refs_count, key=refs_count.get))
        saved = [c for cid in _ids(study.curve_ids) if (c := session.get(PostrunCurve, cid)) is not None
                 and c.component == material and (c.deconv_method or "gauss") == "molde"]
        self.curve_setting = (saved[0].model, saved[0].weighting) if saved else ("origin", "1/x2")
        self.overrides = _curve_overrides(session, study, "molde")

    def quantify(self, ref_mem: PostrunDeconvReference) -> tuple[dict[str, tuple[float | None, float | None]], float | None]:
        """{mistura: (massa encontrada do material, U95)} e a recuperação média do material."""
        over = {ref_mem.id: ref_mem}
        rows: dict[str, PostrunDeconvolution] = {}
        for t, row in [*self.pures.items(), *self.mixes.items()]:
            spec = DeconvSpecIn(
                token=row.token, channel=row.channel, start_idx=row.start_idx, end_idx=row.end_idx,
                baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline, shape=row.shape, mode=row.mode,
                n_peaks=row.n_peaks, reference_ids=json.loads(row.reference_ids or "[]"), tol_c=row.tol_c,
                tol_width_pct=row.tol_width_pct,
            )
            try:
                rows[t] = _memory_row(row, spec, _compute(self.session, spec, over), "molde")
            except HTTPException:
                continue
        xs, ys, cycle = [], [], None
        for t in self.pures:
            if t not in rows:
                continue
            sm = self.infos[t].summary
            area = sum(p["area_s"] for p in json.loads(rows[t].result).get("peaks", []) if p.get("material") == self.mat)
            if sm.mass_mg and area > 0:
                xs.append(sm.mass_mg)
                ys.append(area)
                cycle = sm.cycle_key
        if len(xs) < 2 or cycle is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"puros de {self.mat} insuficientes para a curva")
        reg, weight = self.curve_setting
        f = postrun_regression.fit(xs, ys, reg, weight)
        curve = PostrunCurve(id=-1, name=f"{self.mat} (em memória)", channel=self.s.channel, cycle_key=cycle,
                             component=self.mat, area_source="gaussian", deconv_method="molde", model=reg,
                             weighting=weight, points="[]", fit=json.dumps(_fit_out(f).model_dump()), created_by_id=0)
        mix_rows = {t: r for t, r in rows.items() if t in self.mixes}
        rep, _ = build_report(self.session, ReportIn(tokens=list(mix_rows), channel=self.s.channel, method="molde",
                                                     curve_ids=self.overrides),
                              self.infos, mix_rows, curve_cache={(self.mat, cycle): curve})
        found: dict[str, tuple[float | None, float | None]] = {}
        recs = []
        for r in rep.runs:
            m = next((m for m in r.materials if m.material == self.mat), None)
            if m is None:
                continue
            found[r.token] = (m.found_mg, m.U95_mg)
            if m.recovery_pct is not None:
                recs.append(m.recovery_pct)
        return found, (mean(recs) if recs else None)


def _shape_compare(a: dict, b: dict) -> tuple[float | None, float | None, float | None]:
    ta, fa = np.asarray(a["tau"]), np.asarray(a["density"])
    tb, fb = np.asarray(b["tau"]), np.asarray(b["density"])
    lo, hi = max(ta[0], tb[0]), min(ta[-1], tb[-1])
    if hi - lo < 10:
        return None, None, None
    grid = np.arange(lo, hi, 1.0)
    ga = np.interp(grid, ta, fa)
    gb = np.interp(grid, tb, fb)
    corr = float(np.corrcoef(ga, gb)[0, 1]) if ga.std() > 0 and gb.std() > 0 else None
    l2 = float(math.sqrt(np.trapezoid((ga - gb) ** 2, grid)))
    norm = float(math.sqrt(np.trapezoid(ga ** 2, grid)))
    return corr, l2, (100.0 * l2 / norm if norm else None)


@router.post("/{study_id}/template-robustness", response_model=RobustOut)
def template_robustness(study_id: int, payload: RobustIn, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    mat = payload.material.strip().upper()
    ctx = _Ctx(session, s, mat)
    if ctx.ref is None or not ctx.mixes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"O estudo precisa de misturas com {mat} ajustadas por molde (referência de {mat})")
    ref = ctx.ref
    tokens = json.loads(ref.tokens or "[]")
    warnings: list[str] = []
    if len(tokens) < 3:
        warnings.append(f"O molde de {mat} tem {len(tokens)} corrida(s): deixa-uma-de-fora precisa de 3 ou mais.")
    base_found, base_rec = ctx.quantify(ref)

    loro: list[LoroOut] = []
    found_by_mix: dict[str, list[float]] = {}
    if len(tokens) >= 3:
        for k in tokens:
            fname = ctx.infos[k].summary.filename if k in ctx.infos else k.rsplit("/", 1)[-1]
            try:
                tpl = _template_json(session, [t for t in tokens if t != k], s.channel)
                if not tpl:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "molde não pôde ser refeito")
                found, rec = ctx.quantify(_with_template(ref, tpl))
            except HTTPException as exc:
                loro.append(LoroOut(left_out=k, filename=fname, recovery_mean=None, error=str(exc.detail)))
                continue
            loro.append(LoroOut(left_out=k, filename=fname, recovery_mean=rec))
            for t, (m, _u) in found.items():
                if m is not None:
                    found_by_mix.setdefault(t, []).append(m)
    loro_recs = [x.recovery_mean for x in loro if x.recovery_mean is not None]

    combined: list[CombinedOut] = []
    for t, (m, U95) in base_found.items():
        u_fit = U95 / 2.0 if U95 is not None else None
        vals = found_by_mix.get(t, [])
        u_tpl = stdev(vals) if len(vals) > 1 else None
        u_c = math.sqrt((u_fit or 0) ** 2 + (u_tpl or 0) ** 2) if (u_fit is not None or u_tpl is not None) else None
        combined.append(CombinedOut(
            token=t, filename=ctx.infos[t].summary.filename, found_mg=m, u_fit_mg=u_fit, u_template_mg=u_tpl,
            U95_combined_mg=2 * u_c if u_c is not None else None,
            template_share_pct=100.0 * u_tpl ** 2 / u_c ** 2 if u_tpl is not None and u_c else None,
        ))

    compare = None
    if payload.alt_reference_id is not None:
        alt = session.get(PostrunDeconvReference, payload.alt_reference_id)
        if alt is None or not alt.template:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "O outro molde não existe ou não tem molde")
        if alt.cycle_key != ref.cycle_key:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "O outro molde é de outro ciclo")
        a, b = json.loads(ref.template), json.loads(alt.template)
        corr, l2, l2_rel = _shape_compare(a, b)
        try:
            _f, rec_alt = ctx.quantify(_with_template(ref, alt.template))
        except HTTPException as exc:
            rec_alt = None
            warnings.append(f"Recuperação com o outro molde: {exc.detail}")
        compare = TemplateCompareOut(
            reference_id=alt.id, name=alt.name, correlation=corr, l2=l2, l2_rel_pct=l2_rel,
            max_c_diff=(b.get("max_c") - a.get("max_c")) if b.get("max_c") is not None and a.get("max_c") is not None else None,
            recovery_mean=rec_alt,
            delta_recovery=(rec_alt - base_rec) if rec_alt is not None and base_rec is not None else None,
        )
        if alt.name.strip().upper() != mat:
            warnings.append(f"O outro molde é de {alt.name}, não de {mat}.")

    return RobustOut(
        material=mat, reference_id=ref.id, reference_name=ref.name, n_template_runs=len(tokens),
        n_pures=len(ctx.pures), n_mixtures=len(ctx.mixes), baseline_recovery=base_rec, loro=loro,
        template_sd_recovery=stdev(loro_recs) if len(loro_recs) > 1 else None,
        combined=combined, compare=compare, warnings=warnings,
    )
