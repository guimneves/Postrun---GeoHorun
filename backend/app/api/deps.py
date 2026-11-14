"""Quem está pedindo — mesma interface que o código do PostRun tinha no RE7S
(`CurrentUser`, `AdminUser`, `SessionDep`), agora a partir da identidade do
Core (cabeçalhos X-Horun-*, app/core/identity.py).

Cada pessoa ganha uma linha local em `User` (id do Core + nome) na primeira
vez, só para as colunas `*_by_id` continuarem chaves estrangeiras como no
RE7S. O papel NÃO fica guardado como decisão: é recalculado a cada pedido a
partir do cargo no Core (níveis 1..GEOHORUN_ADMIN_MAX_LEVEL = admin) — regra do
Horun: o papel vem do cargo, sem senha de módulo.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.config import settings
from app.core.identity import HorunIdentity, get_identity
from app.db.models import Role, User
from app.db.session import get_session

SessionDep = Annotated[Session, Depends(get_session)]


def _user_for(session: Session, identity: HorunIdentity) -> User:
    role = Role.ADMIN if identity.level <= settings.admin_max_level else Role.USER
    user = session.exec(select(User).where(User.core_user_id == identity.user_id)).first()
    if user is None:
        user = User(core_user_id=identity.user_id, username=identity.username, role=role)
        session.add(user)
        try:
            session.commit()
        except IntegrityError:  # dois primeiros pedidos ao mesmo tempo
            session.rollback()
            user = session.exec(select(User).where(User.core_user_id == identity.user_id)).one()
        session.refresh(user)
    if user.username != identity.username or user.role != role:
        user.username = identity.username
        user.role = role
        session.add(user)
        session.commit()
        session.refresh(user)
    return user


def get_current_user(session: SessionDep, identity: HorunIdentity = Depends(get_identity)) -> User:
    return _user_for(session, identity)


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> User:
    if user.role != Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Ação restrita à coordenação")
    return user


AdminUser = Annotated[User, Depends(require_admin)]
