"""Rastreabilidade por corrida (F4 do artigo): metadados, exclusão com motivo
e o registro de exclusões. Ver `app/modules/run_records.py`."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.db.models import PostrunExclusionLog, PostrunRunRecord
from app.modules import run_records

router = APIRouter(prefix="/postrun/runs", tags=["postrun"])


class RunRecordOut(BaseModel):
    token: str
    excluded: bool = False
    exclusion_reason: str = ""
    exclusion_reason_label: str = ""
    exclusion_comment: str = ""
    excluded_by: str = ""
    excluded_at: datetime | None = None
    matrix_mass_mg: float | None = None
    polymer_lot: str = ""
    granulometry: str = ""
    operator: str = ""
    run_date: str = ""
    notes: str = ""
    updated_by: str = ""
    updated_at: datetime | None = None


class RunMetaIn(BaseModel):
    token: str
    matrix_mass_mg: float | None = None
    polymer_lot: str = ""
    granulometry: str = ""
    operator: str = ""
    run_date: str = ""
    notes: str = ""


class ExcludeIn(BaseModel):
    tokens: list[str]
    reason: str
    comment: str


class RestoreIn(BaseModel):
    tokens: list[str]
    comment: str = ""


class LogOut(BaseModel):
    token: str
    action: str
    reason: str
    reason_label: str
    comment: str
    user: str
    at: datetime


def _out(token: str, r: PostrunRunRecord | None) -> RunRecordOut:
    if r is None:
        return RunRecordOut(token=token)
    return RunRecordOut(**r.model_dump(), exclusion_reason_label=run_records.reason_label(r.exclusion_reason) if r.excluded else "")


def _record(session: SessionDep, token: str) -> PostrunRunRecord:
    return session.get(PostrunRunRecord, token) or PostrunRunRecord(token=token)


@router.get("/reasons")
def reasons(_user: CurrentUser) -> dict[str, str]:
    return run_records.REASONS


@router.post("/records", response_model=list[RunRecordOut])
def get_records(tokens: list[str], session: SessionDep, _user: CurrentUser):
    """Registros das corridas pedidas (POST para caber muitos caminhos)."""
    return [_out(t, session.get(PostrunRunRecord, t)) for t in dict.fromkeys(tokens)]


@router.put("/records", response_model=list[RunRecordOut])
def put_records(items: list[RunMetaIn], session: SessionDep, user: CurrentUser):
    now = datetime.now(timezone.utc)
    out = []
    for it in items:
        if it.matrix_mass_mg is not None and it.matrix_mass_mg < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{it.token}: massa de matriz negativa")
        if it.run_date and not _is_date(it.run_date):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{it.token}: data deve ser AAAA-MM-DD")
        r = _record(session, it.token)
        r.matrix_mass_mg = it.matrix_mass_mg
        r.polymer_lot, r.granulometry = it.polymer_lot.strip(), it.granulometry.strip()
        r.operator, r.run_date, r.notes = it.operator.strip(), it.run_date.strip(), it.notes.strip()
        r.updated_by, r.updated_at = user.username, now
        session.add(r)
        out.append(r)
    session.commit()
    return [_out(r.token, r) for r in out]


def _is_date(text: str) -> bool:
    try:
        datetime.strptime(text, "%Y-%m-%d")
        return True
    except ValueError:
        return False


@router.post("/exclude", response_model=list[RunRecordOut])
def exclude(payload: ExcludeIn, session: SessionDep, user: CurrentUser):
    if payload.reason not in run_records.REASONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Motivo inválido — use um de: {', '.join(run_records.REASONS)}")
    if not payload.comment.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Excluir uma corrida exige um comentário")
    if not payload.tokens:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nenhuma corrida escolhida")
    now = datetime.now(timezone.utc)
    out = []
    for t in dict.fromkeys(payload.tokens):
        r = _record(session, t)
        r.excluded, r.exclusion_reason, r.exclusion_comment = True, payload.reason, payload.comment.strip()
        r.excluded_by, r.excluded_at = user.username, now
        r.updated_by, r.updated_at = user.username, now
        session.add(r)
        session.add(PostrunExclusionLog(token=t, action="excluida", reason=payload.reason,
                                        comment=payload.comment.strip(), user=user.username, at=now))
        out.append(r)
    session.commit()
    return [_out(r.token, r) for r in out]


@router.post("/restore", response_model=list[RunRecordOut])
def restore(payload: RestoreIn, session: SessionDep, user: CurrentUser):
    now = datetime.now(timezone.utc)
    out = []
    for t in dict.fromkeys(payload.tokens):
        r = session.get(PostrunRunRecord, t)
        if r is None or not r.excluded:
            continue
        session.add(PostrunExclusionLog(token=t, action="restaurada", reason=r.exclusion_reason,
                                        comment=payload.comment.strip(), user=user.username, at=now))
        r.excluded, r.exclusion_reason, r.exclusion_comment, r.excluded_by, r.excluded_at = False, "", "", "", None
        r.updated_by, r.updated_at = user.username, now
        session.add(r)
        out.append(r)
    session.commit()
    return [_out(r.token, r) for r in out]


@router.post("/exclusions/log", response_model=list[LogOut])
def exclusion_log(tokens: list[str], session: SessionDep, _user: CurrentUser, limit: int = Query(500, le=5000)):
    rows = session.exec(
        select(PostrunExclusionLog).where(PostrunExclusionLog.token.in_(list(tokens)))  # type: ignore[union-attr]
        .order_by(PostrunExclusionLog.at.desc()).limit(limit)
    ).all()
    return [LogOut(token=r.token, action=r.action, reason=r.reason, reason_label=run_records.reason_label(r.reason),
                   comment=r.comment, user=r.user, at=r.at) for r in rows]
