"""Painel de interação na co-pirólise (F7 do artigo).

Para cada mistura do estudo:
- **previsão sem interação**: a soma dos moldes RÍGIDOS dos puros (centro da
  referência, sem dilatação), cada um com a área que a curva do material dá
  para a massa esperada dele na mistura;
- **curva de diferença** = medido − previsão — análoga ao ΔM do PMP-008: o que
  a co-pirólise mudou (deslocamento, alargamento, sinal a mais ou a menos);
- ΔM (%) = (∫medido − ∫previsto) ÷ ∫previsto e o maior desvio local.

Junto: ΔTmax e Δlargura de cada componente × a fração dele (das
deconvoluções salvas) e o alerta dos parâmetros que bateram no limite da
tolerância (ex.: +40 % de largura no PEAD com PS) — sinal de que a interação
é maior que a folga dada ao ajuste.
"""

from __future__ import annotations

import json

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun import _read_analysis
from app.api.routes_postrun_curves import _AnalysisInfo, _fit_from_json, _info
from app.api.routes_postrun_deconv import DeconvSpecIn, _references, _template_of, _window, check_method, saved_row
from app.api.routes_postrun_report import _curve_for
from app.api.routes_postrun_study import _curve_overrides, _get, _ids
from app.modules import postrun_b00

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])

MAX_POINTS = 400


class ComponentOut(BaseModel):
    material: str
    fraction: float | None
    expected_mg: float | None
    predicted_area_s: float | None
    error: str | None = None


class RunInteractionOut(BaseModel):
    token: str
    filename: str
    composition_text: str
    delta_m_pct: float | None = None  # (∫medido − ∫previsto) ÷ ∫previsto
    max_dev_pct: float | None = None  # maior |medido − previsto| ÷ máximo previsto
    t_s: list[float] = []
    temp_c: list[float] = []
    measured: list[float] = []
    predicted: list[float] = []
    difference: list[float] = []
    components: list[list[float]] = []
    component_info: list[ComponentOut] = []
    error: str | None = None


class TrendPointOut(BaseModel):
    material: str
    fraction: float
    delta_mu_c: float | None
    delta_width_pct: float | None
    at_bound: bool
    token: str


class BoundAlertOut(BaseModel):
    token: str
    filename: str
    material: str
    delta_mu_c: float | None
    delta_width_pct: float | None
    tol_c: float
    tol_width_pct: float


class InteractionOut(BaseModel):
    method: str
    runs: list[RunInteractionOut]
    trends: list[TrendPointOut]
    alerts: list[BoundAlertOut]
    warnings: list[str] = []


def _thin(n: int) -> np.ndarray:
    if n <= MAX_POINTS:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, MAX_POINTS).round().astype(int))


@router.post("/{study_id}/interaction", response_model=InteractionOut)
def interaction(study_id: int, session: SessionDep, _user: CurrentUser, method: str | None = None):
    s = _get(session, study_id)
    m = check_method(method or s.method)
    infos: dict[str, _AnalysisInfo] = {}
    overrides = _curve_overrides(session, s, m)
    cache: dict = {}
    runs: list[RunInteractionOut] = []
    trends: list[TrendPointOut] = []
    alerts: list[BoundAlertOut] = []
    warnings: list[str] = []
    for t in _ids(s.tokens):
        try:
            sm = _info(session, t, infos).summary
        except HTTPException as exc:
            warnings.append(f"{t}: {exc.detail}")
            continue
        comp = sm.composition or {}
        if len(comp) < 2:
            continue
        row = saved_row(session, t, s.channel, m)
        if row is None:
            continue
        data = json.loads(row.result or "{}")
        for p in data.get("peaks", []):
            mat = p.get("material", "")
            frac = comp.get(mat)
            if frac is not None:
                trends.append(TrendPointOut(material=mat, fraction=frac, delta_mu_c=p.get("delta_mu_c"),
                                            delta_width_pct=p.get("delta_width_pct"), at_bound=bool(p.get("at_bound")), token=t))
            if p.get("at_bound"):
                alerts.append(BoundAlertOut(token=t, filename=sm.filename, material=mat, delta_mu_c=p.get("delta_mu_c"),
                                            delta_width_pct=p.get("delta_width_pct"), tol_c=row.tol_c, tol_width_pct=row.tol_width_pct))
        runs.append(_run(session, s.channel, m, t, sm, row, comp, overrides, cache))
    if not runs:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Nenhuma mistura do estudo tem deconvolução salva ({m})")
    return InteractionOut(method=m, runs=runs, trends=trends, alerts=alerts, warnings=warnings)


def _run(session, channel, method, token, sm, row, comp, overrides, cache) -> RunInteractionOut:
    out = RunInteractionOut(token=token, filename=sm.filename, composition_text=sm.composition_text)
    spec = DeconvSpecIn(token=token, channel=channel, start_idx=row.start_idx, end_idx=row.end_idx,
                        baseline_mode=row.baseline_mode, fixed_baseline=row.fixed_baseline)
    try:
        analysis = _read_analysis(session, token)
        _xs, y, t, temps, _tb = _window(analysis, spec)
        refs = _references(session, json.loads(row.reference_ids or "[]"), channel, analysis.header.cycle_key)
    except (HTTPException, postrun_b00.B00ParseError) as exc:
        out.error = str(getattr(exc, "detail", exc))
        return out
    by_mat = {r.name.strip().upper(): r for r in refs}
    real = sm.component_masses or None
    pred = np.zeros_like(t)
    comps: list[np.ndarray] = []
    for mat, frac in sorted(comp.items(), key=lambda kv: -kv[1]):
        info = ComponentOut(material=mat, fraction=frac, expected_mg=None, predicted_area_s=None)
        info.expected_mg = real.get(mat) if real and real.get(mat) else (sm.mass_mg * frac if sm.mass_mg else None)
        ref = by_mat.get(mat)
        curve = _curve_for(session, mat, channel, sm.cycle_key, overrides, cache, method)
        if ref is None:
            info.error = "sem referência (molde) do material"
        elif curve is None:
            info.error = "sem curva do material"
        elif not info.expected_mg:
            info.error = "sem massa esperada"
        else:
            try:
                tpl, data = _template_of(ref)
            except HTTPException as exc:
                info.error = str(exc.detail)
            else:
                f = _fit_from_json(json.loads(curve.fit), curve.model, curve.weighting)
                info.predicted_area_s = float(f.predict(info.expected_mg))
                c = info.predicted_area_s * tpl.eval(t, float(data["center_s"]), 1.0)
                pred = pred + c
                comps.append(c)
        out.component_info.append(info)
    if any(ci.error for ci in out.component_info):
        out.error = "; ".join(f"{ci.material}: {ci.error}" for ci in out.component_info if ci.error)
    diff = y - pred
    area_pred = float(np.trapezoid(pred, t))
    if area_pred > 0 and not out.error:
        out.delta_m_pct = 100.0 * (float(np.trapezoid(y, t)) - area_pred) / area_pred
        out.max_dev_pct = 100.0 * float(np.max(np.abs(diff))) / float(np.max(pred))
    k = _thin(len(t))
    out.t_s = t[k].tolist()
    out.temp_c = np.asarray(temps)[k].tolist()
    out.measured = y[k].tolist()
    out.predicted = pred[k].tolist()
    out.difference = diff[k].tolist()
    out.components = [c[k].tolist() for c in comps]
    return out
