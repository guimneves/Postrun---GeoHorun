"""Validação independente de um estudo (F3 do artigo).

Cada análise do estudo pode ser marcada como **calibração** ou **validação**
(nunca as duas: é um papel só por corrida). As de validação são quantificadas
pelas curvas da calibração e comparadas com a massa adicionada (pesada):
viés, RMSEP, recuperação, regressão encontrada × adicionada e precisão
intermediária por ANOVA com o dia como fator (`app/modules/postrun_validation.py`).

Separação garantida: uma corrida de validação que seja ponto de uma das
curvas usadas na quantificação sai das métricas, com o motivo.

**Modo cego**: até "Revelar", a tela não mostra o nome do arquivo, a
composição, a massa adicionada nem a recuperação das corridas de validação —
só um código (V01, V02…) e a massa ENCONTRADA. Ao revelar, as massas
encontradas naquele momento ficam guardadas (prova de que a quantificação foi
feita antes de conhecer as respostas); mudança posterior aparece marcada. O
que o modo cego NÃO esconde: QUAIS materiais há em cada corrida — a
deconvolução guiada precisa disso para escolher as referências; só as
PROPORÇÕES (e com elas as massas esperadas) ficam escondidas.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import _AnalysisInfo
from app.api.routes_postrun_report import ReportIn, build_report
from app.api.routes_postrun_study import _check_open, _curve_overrides, _get, _ids
from app.db.models import PostrunCurve, PostrunStudy, Role
from app.modules import postrun_validation

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])

ROLES = ("calibracao", "validacao")


# ---------------------------------------------------------------- schemas

class ValidationConfigIn(BaseModel):
    # token -> "calibracao" | "validacao"; ausente = sem papel
    roles: dict[str, str]
    blind: bool = False


class ValidationConfigOut(BaseModel):
    roles: dict[str, str] = {}
    blind: bool = False
    revealed_at: datetime | None = None
    revealed_by: str | None = None


class ValMaterialOut(BaseModel):
    material: str
    found_mg: float | None = None
    U95_mg: float | None = None
    added_mg: float | None = None  # escondida no modo cego
    recovery_pct: float | None = None  # escondida no modo cego
    flags: list[str] = []


class ValRunOut(BaseModel):
    token: str | None  # None no modo cego (o caminho tem o nome com a composição)
    code: str  # V01, V02…
    label: str  # nome do arquivo, ou o código no modo cego
    day: str
    included: bool
    reason: str | None = None
    changed_since_reveal: bool = False
    materials: list[ValMaterialOut]


class AnovaOut(BaseModel):
    k_days: int
    n: int
    s_r: float | None
    s_between: float | None
    s_ip: float | None
    warnings: list[str]


class ValMetricsOut(BaseModel):
    material: str
    n: int
    n_days: int
    bias_mg: float
    bias_pct: float
    rmsep_mg: float
    recovery_mean: float
    recovery_sd: float | None
    slope: float | None
    intercept: float | None
    r2: float | None
    mean_rel_U95_pct: float | None
    anova: AnovaOut


class ValPointOut(BaseModel):
    material: str
    added_mg: float
    found_mg: float
    U95_mg: float | None


class ValidationOut(BaseModel):
    config: ValidationConfigOut
    method: str
    n_calibration: int
    n_validation: int
    hidden: bool  # modo cego ainda não revelado: respostas escondidas
    runs: list[ValRunOut]
    metrics: list[ValMetricsOut] = []
    points: list[ValPointOut] = []
    conflicts: list[str] = []
    warnings: list[str] = []


# ------------------------------------------------------------------ estado

def _config(s: PostrunStudy) -> dict:
    return json.loads(s.validation) if s.validation else {}


def _config_out(cfg: dict) -> ValidationConfigOut:
    return ValidationConfigOut(
        roles=cfg.get("roles", {}), blind=bool(cfg.get("blind")),
        revealed_at=cfg.get("revealed_at"), revealed_by=cfg.get("revealed_by"),
    )


def _can_manage(s: PostrunStudy, user) -> None:
    if s.created_by_id != user.id and user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só quem criou o estudo (ou um admin) muda a validação")


@router.get("/{study_id}/validation/config", response_model=ValidationConfigOut)
def get_config(study_id: int, session: SessionDep, _user: CurrentUser):
    return _config_out(_config(_get(session, study_id)))


@router.put("/{study_id}/validation/config", response_model=ValidationConfigOut)
def put_config(study_id: int, payload: ValidationConfigIn, session: SessionDep, user: CurrentUser):
    s = _get(session, study_id)
    _check_open(s)
    _can_manage(s, user)
    tokens = set(_ids(s.tokens))
    bad = [t for t in payload.roles if t not in tokens]
    if bad:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{len(bad)} análise(s) fora do estudo")
    wrong = sorted({r for r in payload.roles.values() if r not in ROLES})
    if wrong:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Papel inválido: {', '.join(wrong)}")
    cfg = _config(s)
    if cfg.get("revealed_at"):
        old_val = {t for t, r in cfg.get("roles", {}).items() if r == "validacao"}
        new_val = {t for t, r in payload.roles.items() if r == "validacao"}
        if old_val != new_val or payload.blind != bool(cfg.get("blind")):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "As respostas já foram reveladas: o conjunto de validação e o modo cego ficam travados "
                "(senão a validação deixaria de ser cega). Crie outro estudo para uma nova validação.",
            )
    cfg["roles"] = dict(payload.roles)
    cfg["blind"] = payload.blind
    s.validation = json.dumps(cfg)
    s.updated_at = datetime.now(timezone.utc)
    session.add(s)
    session.commit()
    return _config_out(cfg)


# ------------------------------------------------------------------ cálculo

def _compute(session: SessionDep, s: PostrunStudy, cfg: dict, method: str) -> tuple[ValidationOut, dict]:
    roles: dict[str, str] = cfg.get("roles", {})
    val_tokens = sorted(t for t, r in roles.items() if r == "validacao")
    n_cal = sum(1 for r in roles.values() if r == "calibracao")
    hidden = bool(cfg.get("blind")) and not cfg.get("revealed_at")
    out = ValidationOut(config=_config_out(cfg), method=method, n_calibration=n_cal,
                        n_validation=len(val_tokens), hidden=hidden, runs=[])
    if not val_tokens:
        out.warnings.append("Nenhuma corrida marcada como validação.")
        return out, {}
    infos: dict[str, _AnalysisInfo] = {}
    rep, _ = build_report(session, ReportIn(
        tokens=val_tokens, channel=s.channel, method=method, curve_ids=_curve_overrides(session, s, method),
    ), infos)

    # separação: corrida de validação usada como ponto de uma curva da quantificação
    in_curve: dict[str, str] = {}
    for c in rep.curves:
        curve = session.get(PostrunCurve, c.id)
        for p in json.loads(curve.points or "[]") if curve else []:
            if not p.get("excluded") and p.get("token") in roles:
                in_curve.setdefault(p["token"], c.name)
    for t in val_tokens:
        if t in in_curve:
            out.conflicts.append(f"{'uma corrida de validação' if hidden else t} é ponto da curva {in_curve[t]} — fica fora das métricas")
    cal_outside = [t for t, r in roles.items() if r == "calibracao" and t not in in_curve]
    if cal_outside and not hidden:
        out.warnings.append(f"{len(cal_outside)} corrida(s) de calibração não estão em nenhuma curva usada.")

    snapshot: dict = cfg.get("snapshot", {})
    pairs: list[postrun_validation.Pair] = []
    runs_by_token = {r.token: r for r in rep.runs}
    found_now: dict[str, dict[str, float | None]] = {}
    for i, t in enumerate(val_tokens, start=1):
        code = f"V{i:02d}"
        run = runs_by_token.get(t)
        info = infos.get(t)
        day = info.summary.date.date().isoformat() if info and info.summary.date else "sem data"
        skipped = next((sk.reason for sk in rep.skipped if sk.token == t), None)
        reason = skipped or (f"ponto da curva {in_curve[t]}" if t in in_curve else None)
        mats: list[ValMaterialOut] = []
        for m in run.materials if run else []:
            vm = ValMaterialOut(material=m.material, found_mg=m.found_mg, U95_mg=m.U95_mg, flags=list(m.flags))
            if not hidden:
                vm.added_mg, vm.recovery_pct = m.expected_mg, m.recovery_pct
            else:
                vm.flags = [f for f in vm.flags if "composição" not in f and "massa real" not in f]
            mats.append(vm)
            if reason is None and m.found_mg is not None and m.expected_mg:
                pairs.append(postrun_validation.Pair(t, m.material, day, m.expected_mg, m.found_mg, m.U95_mg))
        found_now[t] = {m.material: m.found_mg for m in mats}
        changed = bool(snapshot) and any(
            (snapshot.get(t, {}).get(k) is None) != (v is None)
            or (v is not None and abs(snapshot[t][k] - v) > 1e-9 * max(1.0, abs(v)))
            for k, v in found_now[t].items()
        )
        out.runs.append(ValRunOut(
            token=None if hidden else t, code=code, label=code if hidden else (info.summary.filename if info else t),
            day=day, included=reason is None and run is not None, reason=reason or (None if run else "sem resultado"),
            changed_since_reveal=changed, materials=mats,
        ))
    if snapshot and any(r.changed_since_reveal for r in out.runs):
        out.warnings.append("Massas encontradas mudaram depois da revelação (deconvolução ou curva refeitas) — marcado por corrida.")
    if not hidden:
        for mm in postrun_validation.metrics(pairs):
            out.metrics.append(ValMetricsOut(**{**vars(mm), "anova": AnovaOut(**{k: v for k, v in vars(mm.anova).items() if k in AnovaOut.model_fields})}))
        out.points = [ValPointOut(material=p.material, added_mg=p.added_mg, found_mg=p.found_mg, U95_mg=p.U95_mg) for p in pairs]
    return out, found_now


@router.post("/{study_id}/validation", response_model=ValidationOut)
def validation_report(study_id: int, session: SessionDep, _user: CurrentUser, method: str | None = None):
    from app.api.routes_postrun_deconv import check_method

    s = _get(session, study_id)
    out, _ = _compute(session, s, _config(s), check_method(method or s.method))
    return out


@router.post("/{study_id}/validation/reveal", response_model=ValidationOut)
def reveal(study_id: int, session: SessionDep, user: CurrentUser, method: str | None = None):
    """Revela as respostas do modo cego e guarda as massas encontradas naquele
    momento. Sem volta: depois disso o conjunto de validação fica travado."""
    from app.api.routes_postrun_deconv import check_method

    s = _get(session, study_id)
    _can_manage(s, user)
    cfg = _config(s)
    if not cfg.get("blind"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "O estudo não está no modo cego")
    if cfg.get("revealed_at"):
        raise HTTPException(status.HTTP_409_CONFLICT, "As respostas já foram reveladas")
    m = check_method(method or s.method)
    _, found = _compute(session, s, cfg, m)
    if not found:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nada quantificado ainda: quantifique antes de revelar")
    cfg.update(snapshot=found, revealed_at=datetime.now(timezone.utc).isoformat(), revealed_by=user.username,
               revealed_method=m)
    s.validation = json.dumps(cfg)
    session.add(s)
    session.commit()
    out, _ = _compute(session, s, cfg, m)
    return out
