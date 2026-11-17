"""Comparador de modelos (F6 do artigo): os MESMOS dados do estudo — puros e
misturas, mesma janela e mesmas referências — ajustados por vários modelos,
SEM gravar nada. Cada modelo ganha as próprias curvas (refeitas com os puros
no mesmo modelo) e a recuperação, o RMSEP e o BIC das misturas saem lado a
lado.

Modelos:
- `molde`: molde do puro com centro (± tol °C) e dilatação (± tol %) livres;
- `molde_c_fixo`, `molde_s_fixo`: ablação — centro fixo / sem dilatação;
- `cls`: molde rígido (centro e dilatação fixos) = mínimos quadrados clássicos;
- `gauss`, `bigauss`: gaussiana / bigaussiana guiadas pelas referências;
- `pmp008`: soma ponderada dos moldes rígidos quantificada pelo FATOR DE
  RESPOSTA MÉDIO dos puros (área/mg, reta pela origem) — leitura nossa do
  método de Pawar e Kim (2025), a conferir com o procedimento.

"Fixo" = limites de ±0,001 °C e ±0,0001 % (o otimizador precisa de limites
distintos), na prática fixo.
"""

from __future__ import annotations

import json
import math
from statistics import mean, stdev

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import _AnalysisInfo, _fit_out, _info
from app.api.routes_postrun_deconv import DeconvSpecIn, _compute, saved_row
from app.api.routes_postrun_report import ReportIn, build_report
from app.api.routes_postrun_study import _get, _ids
from sqlmodel import select

from app.db.models import PostrunCurve, PostrunDeconvolution, PostrunDeconvReference
from app.modules import postrun_regression

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])

FIXED_C = 1e-3  # °C
FIXED_W = 1e-4  # %

MODELS: dict[str, dict] = {
    "molde": {"label": "Molde (centro e dilatação livres)", "mode": "template"},
    "molde_c_fixo": {"label": "Molde, centro fixo", "mode": "template", "fix_c": True},
    "molde_s_fixo": {"label": "Molde, sem dilatação", "mode": "template", "fix_s": True},
    "cls": {"label": "Molde rígido (CLS)", "mode": "template", "fix_c": True, "fix_s": True},
    "gauss": {"label": "Gaussiana guiada", "mode": "guided", "shape": "gaussian"},
    "bigauss": {"label": "Bigaussiana guiada", "mode": "guided", "shape": "bigaussian"},
    "pmp008": {"label": "Soma ponderada (Pawar e Kim, 2025)", "mode": "template", "fix_c": True, "fix_s": True, "rf": True},
}


class CompareIn(BaseModel):
    models: list[str] = list(MODELS)


class Stat(BaseModel):
    mean: float | None = None
    sd: float | None = None
    n: int = 0


class ModelOut(BaseModel):
    key: str
    label: str
    n_mixtures: int
    n_failed: int
    # None nos modelos com parâmetro fixo: lá todo pico está "no limite" por construção
    n_at_bound: int | None
    recovery: dict[str, Stat]  # material -> recuperação %
    rmsep_mg: dict[str, float]  # material -> RMSEP (mg)
    rmse_recovery_pct: float | None  # RMSE de (recuperação − 100) em todos os componentes
    total_recovery: Stat
    bic_mean: float | None
    r2_mean: float | None
    curve_slopes: dict[str, float]  # material -> área por mg da curva do modelo
    errors: list[str] = []


class CompareOut(BaseModel):
    models: list[ModelOut]
    best: str | None
    n_pure: int
    n_mixtures: int
    warnings: list[str] = []


def _stat(xs: list[float]) -> Stat:
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    if not xs:
        return Stat()
    return Stat(mean=mean(xs), sd=stdev(xs) if len(xs) > 1 else None, n=len(xs))


def _base_row(session: SessionDep, token: str, channel: str) -> PostrunDeconvolution | None:
    """Janela salva da corrida: a do molde, senão a da gaussiana (de preferência
    uma que já use referências — a gaussiana LIVRE dos puros também serve: a
    referência vem do material, ver `_refs_for`)."""
    rows = [r for m in ("molde", "gauss") if (r := saved_row(session, token, channel, m)) is not None]
    with_refs = [r for r in rows if json.loads(r.reference_ids or "[]")]
    return (with_refs or rows or [None])[0]


def _refs_for(session: SessionDep, row: PostrunDeconvolution, materials: list[str], cycle_key: str,
              study_refs: list[PostrunDeconvReference]) -> list[int]:
    """Referências do ajuste: as que a deconvolução salva já usa; senão, a de
    cada material neste ciclo — a do estudo primeiro, depois a mais recente."""
    ids = json.loads(row.reference_ids or "[]")
    if ids:
        return ids
    out: list[int] = []
    for mat in materials:
        ref = next((r for r in study_refs if r.name == mat and r.cycle_key == cycle_key and r.channel == row.channel), None)
        if ref is None:
            ref = session.exec(
                select(PostrunDeconvReference).where(
                    PostrunDeconvReference.name == mat, PostrunDeconvReference.channel == row.channel,
                    PostrunDeconvReference.cycle_key == cycle_key,
                ).order_by(PostrunDeconvReference.created_at.desc())
            ).first()
        if ref is None:
            return []
        out.append(ref.id)
    return out


def _spec_for(row: PostrunDeconvolution, model: dict, ref_ids: list[int]) -> DeconvSpecIn:
    return DeconvSpecIn(
        token=row.token, channel=row.channel, start_idx=row.start_idx, end_idx=row.end_idx,
        baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline,
        shape=model.get("shape", "gaussian"), mode=model["mode"], n_peaks=row.n_peaks,
        reference_ids=ref_ids,
        tol_c=FIXED_C if model.get("fix_c") else row.tol_c,
        tol_width_pct=FIXED_W if model.get("fix_s") else row.tol_width_pct,
    )


def _memory_row(row: PostrunDeconvolution, spec: DeconvSpecIn, res, method: str) -> PostrunDeconvolution:
    return PostrunDeconvolution(
        token=row.token, channel=row.channel, method=method, start_idx=spec.start_idx, end_idx=spec.end_idx,
        baseline_mode=spec.baseline_mode, fixed_baseline=spec.fixed_baseline, shape=spec.shape, mode=spec.mode,
        n_peaks=spec.n_peaks, reference_ids=json.dumps(spec.reference_ids), tol_c=spec.tol_c,
        tol_width_pct=spec.tol_width_pct, names="[]", guesses_c="[]", created_by_id=row.created_by_id,
        result=json.dumps(res.model_dump(mode="json", exclude={"spec", "curve", "id", "updated_at", "method"})),
    )


@router.post("/{study_id}/compare-models", response_model=CompareOut)
def compare_models(study_id: int, payload: CompareIn, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    keys = [k for k in dict.fromkeys(payload.models) if k in MODELS]
    if not keys:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Escolha os modelos entre: {', '.join(MODELS)}")
    infos: dict[str, _AnalysisInfo] = {}
    pure: dict[str, tuple[str, PostrunDeconvolution]] = {}  # token -> (material, linha base)
    mixes: dict[str, PostrunDeconvolution] = {}
    ref_ids_of: dict[str, list[int]] = {}
    warnings: list[str] = []
    study_refs = [r for rid in _ids(s.reference_ids) if (r := session.get(PostrunDeconvReference, rid)) is not None]
    study_curves = [c for cid in _ids(s.curve_ids) if (c := session.get(PostrunCurve, cid)) is not None]
    # os puros (16/11/2026 — "tem dois moldes e duas curvas salvas"): os do
    # estudo E as corridas puras que formaram as referências e as curvas dele,
    # mesmo que não tenham sido guardadas no estudo
    tokens = list(_ids(s.tokens))
    extra = [t for r in study_refs for t in json.loads(r.tokens or "[]")]
    extra += [p.get("token") for c in study_curves for p in json.loads(c.points or "[]") if p.get("token")]
    tokens += [t for t in dict.fromkeys(extra) if t not in tokens]
    why: dict[str, int] = {"sem composição": 0, "sem proporção": 0, "sem deconvolução salva": 0, "sem referência": 0}
    for t in tokens:
        try:
            sm = _info(session, t, infos).summary
        except HTTPException as exc:
            warnings.append(f"{t}: {exc.detail}")
            continue
        comp = sm.composition or {}
        if not comp:
            why["sem proporção" if len(sm.components) > 1 else "sem composição"] += 1
            continue
        row = _base_row(session, t, s.channel)
        if row is None:
            why["sem deconvolução salva"] += 1
            continue
        refs = _refs_for(session, row, list(comp), sm.cycle_key, study_refs)
        if not refs:
            why["sem referência"] += 1
            continue
        ref_ids_of[t] = refs
        if len(comp) == 1:
            pure[t] = (next(iter(comp)), row)
        else:
            mixes[t] = row
    if not pure or not mixes:
        detail = [f"{n} {k}" for k, n in why.items() if n]
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Para comparar os modelos são precisos corridas puras (para as curvas) e misturas (para a recuperação), "
            "cada uma com a deconvolução salva e referência do material. "
            f"Encontrei {len(pure)} pura(s) e {len(mixes)} mistura(s) prontas"
            + (f" — ficaram de fora: {', '.join(detail)}" if detail else "")
            + (". Faltam as misturas: guarde no estudo as misturas já ajustadas (passo 2 da aba Deconvolução)."
               if not mixes else
               ". Faltam os puros: guarde no estudo as corridas puras (ou crie as referências e curvas pelos passos 1 e 3).")
        )
    saved_settings = {c.component: (c.model, c.weighting) for cid in _ids(s.curve_ids)
                      if (c := session.get(PostrunCurve, cid)) is not None and c.component}

    out: list[ModelOut] = []
    for key in keys:
        model = MODELS[key]
        method = "molde" if model["mode"] == "template" else "gauss"
        errors: list[str] = []
        rows: dict[str, PostrunDeconvolution] = {}
        failed = 0
        for t, row in [*((t, r) for t, (_, r) in pure.items()), *mixes.items()]:
            spec = _spec_for(row, model, ref_ids_of[t])
            try:
                rows[t] = _memory_row(row, spec, _compute(session, spec), method)
            except HTTPException as exc:
                failed += t in mixes
                if len(errors) < 5:
                    errors.append(f"{infos[t].summary.filename if t in infos else t}: {exc.detail}")

        # curvas do modelo: área do material (soma dos picos dele) × massa, nos puros
        pts: dict[tuple[str, str], tuple[list[float], list[float]]] = {}
        for t, (mat, _) in pure.items():
            if t not in rows:
                continue
            sm = infos[t].summary
            area = sum(p["area_s"] for p in json.loads(rows[t].result).get("peaks", []) if p.get("material") == mat)
            if sm.mass_mg and sm.mass_mg > 0 and area > 0:
                xs, ys = pts.setdefault((mat, sm.cycle_key), ([], []))
                xs.append(sm.mass_mg)
                ys.append(area)
        cache: dict = {}
        slopes: dict[str, float] = {}
        for i, ((mat, cycle), (xs, ys)) in enumerate(pts.items(), start=1):
            reg, weight = ("origin", "1/x2") if model.get("rf") else saved_settings.get(mat, ("linear", "1/x2"))
            try:
                f = postrun_regression.fit(xs, ys, reg, weight)
            except postrun_regression.FitError:
                try:
                    reg = "origin"
                    f = postrun_regression.fit(xs, ys, reg, weight)
                except postrun_regression.FitError as exc:
                    errors.append(f"curva de {mat}: {exc}")
                    continue
            curve = PostrunCurve(id=-i, name=f"{mat} — {model['label']} (em memória)", channel=s.channel, cycle_key=cycle,
                                 component=mat, area_source="gaussian", deconv_method=method, model=reg, weighting=weight,
                                 points="[]", fit=json.dumps(_fit_out(f).model_dump()), created_by_id=0)
            cache[(mat, cycle)] = curve
            slopes[mat] = f.slope_at_zero

        mix_rows = {t: r for t, r in rows.items() if t in mixes}
        recovery: dict[str, list[float]] = {}
        errs_mg: dict[str, list[float]] = {}
        totals, bics, r2s, at_bound = [], [], [], 0
        if mix_rows:
            rep, _ = build_report(session, ReportIn(tokens=list(mix_rows), channel=s.channel, method=method),
                                  infos, mix_rows, curve_cache=cache)
            for r in rep.runs:
                if r.total_recovery_pct is not None:
                    totals.append(r.total_recovery_pct)
                bics.append(r.bic)
                r2s.append(r.r2)
                for m in r.materials:
                    at_bound += any("limite" in fl for fl in m.flags)
                    if m.recovery_pct is not None:
                        recovery.setdefault(m.material, []).append(m.recovery_pct)
                    if m.found_mg is not None and m.expected_mg:
                        errs_mg.setdefault(m.material, []).append(m.found_mg - m.expected_mg)
        all_err = [v - 100.0 for vals in recovery.values() for v in vals]
        out.append(ModelOut(
            key=key, label=model["label"], n_mixtures=len(mix_rows), n_failed=failed,
            n_at_bound=None if model.get("fix_c") or model.get("fix_s") else at_bound,
            recovery={m: _stat(v) for m, v in recovery.items()},
            rmsep_mg={m: math.sqrt(mean(e * e for e in v)) for m, v in errs_mg.items() if v},
            rmse_recovery_pct=math.sqrt(mean(e * e for e in all_err)) if all_err else None,
            total_recovery=_stat(totals),
            bic_mean=mean(b for b in bics if math.isfinite(b)) if any(math.isfinite(b) for b in bics) else None,
            r2_mean=mean(r for r in r2s if math.isfinite(r)) if any(math.isfinite(r) for r in r2s) else None,
            curve_slopes=slopes, errors=errors,
        ))
    scored = [m for m in out if m.rmse_recovery_pct is not None]
    best = min(scored, key=lambda m: m.rmse_recovery_pct).key if scored else None  # type: ignore[arg-type,return-value]
    return CompareOut(models=out, best=best, n_pure=len(pure), n_mixtures=len(mixes), warnings=warnings)
