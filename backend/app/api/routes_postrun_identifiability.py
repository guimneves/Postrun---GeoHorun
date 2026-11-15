"""Diagnóstico de identificabilidade (F9 do artigo).

Quando dois componentes têm picos muito sobrepostos (PEAD e PP, por exemplo),
o ajuste consegue o total, mas não sabe dividir a área entre eles: as áreas
saem fortemente correlacionadas (negativamente) e as massas de cada um ficam
instáveis, enquanto a SOMA continua boa.

- **Correlação das áreas** (da matriz de covariância do ajuste salvo), por
  material, em cada mistura: aviso com |ρ| > 0,9 e a recomendação de reportar
  a soma do par — com a recuperação da soma ao lado.
- **Bootstrap dos resíduos** (uma mistura): o sinal ajustado + resíduos
  reamostrados em blocos (os resíduos de um pirograma são autocorrelacionados,
  então blocos de pontos vizinhos, não pontos soltos), reajustado N vezes; daí
  o desvio e o intervalo de 95 % da massa de cada material e da soma do par, e
  a nuvem massa A × massa B (a "banana" de um par mal condicionado).
"""

from __future__ import annotations

import json
import math
from statistics import mean, stdev

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import _AnalysisInfo, _fit_from_json, _info
from app.api.routes_postrun_deconv import DeconvSpecIn, _compute, check_method, saved_row
from app.api.routes_postrun_report import ReportIn, _curve_for, build_report
from app.api.routes_postrun_study import _curve_overrides, _get, _ids
from app.modules import postrun_regression

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])

RHO_LIMIT = 0.9


class PairOut(BaseModel):
    a: str
    b: str
    rho: float
    ill_conditioned: bool
    recovery_a: float | None = None
    recovery_b: float | None = None
    recovery_sum: float | None = None


class RunIdOut(BaseModel):
    token: str
    filename: str
    composition_text: str
    materials: list[str]
    correlation: list[list[float]]  # material × material
    pairs: list[PairOut]
    error: str | None = None


class IdentOut(BaseModel):
    method: str
    runs: list[RunIdOut]
    recommendations: list[str]


def material_correlation(peaks: list[dict], corr: list[list[float]] | None) -> tuple[list[str], np.ndarray]:
    """Correlação entre as ÁREAS DE MATERIAL (soma dos picos de cada um), a
    partir da correlação e das incertezas das áreas dos picos."""
    mats = list(dict.fromkeys(p.get("material", "") for p in peaks))
    n = len(peaks)
    if not corr or len(corr) != n:
        return mats, np.eye(len(mats))
    u = np.array([float(p.get("u_area_s") or 0.0) for p in peaks])
    cov = np.asarray(corr, dtype=float) * np.outer(u, u)
    idx = {m: [i for i, p in enumerate(peaks) if p.get("material", "") == m] for m in mats}
    k = len(mats)
    mc = np.zeros((k, k))
    for i, a in enumerate(mats):
        for j, b in enumerate(mats):
            mc[i, j] = cov[np.ix_(idx[a], idx[b])].sum()
    d = np.sqrt(np.clip(np.diag(mc), 0, None))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = mc / np.outer(d, d)
    out[~np.isfinite(out)] = 0.0
    np.fill_diagonal(out, 1.0)
    return mats, out


@router.post("/{study_id}/identifiability", response_model=IdentOut)
def identifiability(study_id: int, session: SessionDep, _user: CurrentUser, method: str | None = None):
    s = _get(session, study_id)
    m = check_method(method or s.method)
    infos: dict[str, _AnalysisInfo] = {}
    mixes: list[str] = []
    for t in _ids(s.tokens):
        try:
            if len(_info(session, t, infos).summary.composition or {}) > 1 and saved_row(session, t, s.channel, m):
                mixes.append(t)
        except HTTPException:
            continue
    if not mixes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Nenhuma mistura do estudo tem deconvolução salva ({m})")
    rep, _ = build_report(session, ReportIn(tokens=mixes, channel=s.channel, method=m,
                                            curve_ids=_curve_overrides(session, s, m)), infos)
    by_run = {r.token: r for r in rep.runs}
    runs: list[RunIdOut] = []
    bad_pairs: dict[tuple[str, str], int] = {}
    for t in mixes:
        sm = infos[t].summary
        data = json.loads(saved_row(session, t, s.channel, m).result or "{}")
        mats, mc = material_correlation(data.get("peaks", []), data.get("area_correlation"))
        r = by_run.get(t)
        mat_out = {mm.material: mm for mm in (r.materials if r else [])}
        pairs = []
        for i in range(len(mats)):
            for j in range(i + 1, len(mats)):
                rho = float(mc[i, j])
                pa, pb = mat_out.get(mats[i]), mat_out.get(mats[j])
                rs = None
                if pa and pb and None not in (pa.found_mg, pb.found_mg) and pa.expected_mg and pb.expected_mg:
                    rs = 100.0 * (pa.found_mg + pb.found_mg) / (pa.expected_mg + pb.expected_mg)
                ill = abs(rho) > RHO_LIMIT
                if ill:
                    key = tuple(sorted((mats[i], mats[j])))
                    bad_pairs[key] = bad_pairs.get(key, 0) + 1
                pairs.append(PairOut(a=mats[i], b=mats[j], rho=rho, ill_conditioned=ill,
                                     recovery_a=pa.recovery_pct if pa else None, recovery_b=pb.recovery_pct if pb else None,
                                     recovery_sum=rs))
        runs.append(RunIdOut(token=t, filename=sm.filename, composition_text=sm.composition_text, materials=mats,
                             correlation=mc.round(4).tolist(), pairs=pairs))
    recs = [f"{a} e {b}: |ρ| > {RHO_LIMIT} em {n} de {len(mixes)} mistura(s) — reporte a soma {a} + {b} "
            "(as recuperações separadas não são confiáveis)" for (a, b), n in sorted(bad_pairs.items())]
    return IdentOut(method=m, runs=runs, recommendations=recs)


# ---------------------------------------------------------------- bootstrap

class BootIn(BaseModel):
    token: str
    method: str | None = None
    # até 200: com mais, o reajuste passa do tempo-limite do proxy do Core (30 s)
    n_boot: int = Field(100, ge=20, le=200)
    block: int = Field(10, ge=1, le=200)  # pontos por bloco de resíduos
    seed: int = 1


class BootMatOut(BaseModel):
    material: str
    expected_mg: float | None
    found_mean: float | None
    found_sd: float | None
    found_p2_5: float | None
    found_p97_5: float | None
    recovery_sd_pct: float | None


class BootPairOut(BaseModel):
    a: str
    b: str
    rho: float | None  # correlação das massas entre as reamostragens
    sum_sd: float | None
    sum_cv_pct: float | None
    a_cv_pct: float | None
    b_cv_pct: float | None


class BootOut(BaseModel):
    token: str
    filename: str
    n_ok: int
    n_failed: int
    materials: list[BootMatOut]
    pairs: list[BootPairOut]
    samples: dict[str, list[float]]  # material → massas encontradas em cada reamostragem


def _pct(xs: np.ndarray, q: float) -> float:
    return float(np.percentile(xs, q))


@router.post("/{study_id}/identifiability/bootstrap", response_model=BootOut)
def bootstrap(study_id: int, payload: BootIn, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    m = check_method(payload.method or s.method)
    if payload.token not in _ids(s.tokens):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A análise não é do estudo")
    row = saved_row(session, payload.token, s.channel, m)
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Sem deconvolução salva ({m}) nessa análise")
    infos: dict[str, _AnalysisInfo] = {}
    sm = _info(session, payload.token, infos).summary
    spec = DeconvSpecIn(
        token=row.token, channel=row.channel, start_idx=row.start_idx, end_idx=row.end_idx,
        baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline, shape=row.shape, mode=row.mode,
        n_peaks=row.n_peaks, reference_ids=json.loads(row.reference_ids or "[]"), tol_c=row.tol_c,
        tol_width_pct=row.tol_width_pct, names=json.loads(row.names or "[]"), guesses_c=json.loads(row.guesses_c or "[]"),
    )
    base = _compute(session, spec)
    y = np.asarray(base.curve.signal, dtype=float)
    fitted = np.asarray(base.curve.fitted, dtype=float)
    resid = y - fitted
    n = len(y)
    block = min(payload.block, n)
    rng = np.random.default_rng(payload.seed)

    overrides = _curve_overrides(session, s, m)
    cache: dict = {}
    curves = {}
    for p in base.peaks:
        if p.material not in curves:
            c = _curve_for(session, p.material, s.channel, sm.cycle_key, overrides, cache, m)
            curves[p.material] = _fit_from_json(json.loads(c.fit), c.model, c.weighting) if c else None
    samples: dict[str, list[float]] = {mat: [] for mat in curves}
    ok = failed = 0
    for _ in range(payload.n_boot):
        starts = rng.integers(0, n - block + 1, size=math.ceil(n / block))
        r_star = np.concatenate([resid[i:i + block] for i in starts])[:n]
        try:
            res = _compute(session, spec, y_override=fitted + r_star)
        except HTTPException:
            failed += 1
            continue
        areas: dict[str, float] = {}
        for p in res.peaks:
            areas[p.material] = areas.get(p.material, 0.0) + p.area_s
        row_vals = {}
        for mat, f in curves.items():
            if f is None or mat not in areas:
                break
            try:
                row_vals[mat] = postrun_regression.inverse(f, areas[mat]).x
            except postrun_regression.FitError:
                break
        else:
            ok += 1
            for mat, v in row_vals.items():
                samples[mat].append(v)
            continue
        failed += 1

    comp = sm.composition or {}
    real = sm.component_masses or {}
    mats_out = []
    for mat, vals in samples.items():
        exp = real.get(mat) or ((sm.mass_mg or 0) * comp.get(mat, 0) or None)
        arr = np.asarray(vals)
        mats_out.append(BootMatOut(
            material=mat, expected_mg=exp,
            found_mean=float(arr.mean()) if len(arr) else None, found_sd=float(arr.std(ddof=1)) if len(arr) > 1 else None,
            found_p2_5=_pct(arr, 2.5) if len(arr) else None, found_p97_5=_pct(arr, 97.5) if len(arr) else None,
            recovery_sd_pct=100.0 * float(arr.std(ddof=1)) / exp if exp and len(arr) > 1 else None,
        ))
    pairs = []
    names = list(samples)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = np.asarray(samples[names[i]]), np.asarray(samples[names[j]])
            if len(a) < 3:
                continue
            ssum = a + b
            cv = lambda x: 100.0 * float(x.std(ddof=1)) / float(x.mean()) if x.mean() else None  # noqa: E731
            pairs.append(BootPairOut(
                a=names[i], b=names[j],
                rho=float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else None,
                sum_sd=float(ssum.std(ddof=1)), sum_cv_pct=cv(ssum), a_cv_pct=cv(a), b_cv_pct=cv(b),
            ))
    return BootOut(token=payload.token, filename=sm.filename, n_ok=ok, n_failed=failed,
                   materials=mats_out, pairs=pairs, samples={k: [round(v, 6) for v in vs] for k, vs in samples.items()})
