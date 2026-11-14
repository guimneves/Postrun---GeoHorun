"""Quem está usando (/me) e o que a tela precisa do RE7S repassado pelo
GeoHorun (biblioteca de amostras, para trocar a amostra de uma análise)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import CurrentUser
from app.core.identity import HorunIdentity, get_identity
from app.modules import re7s_link

router = APIRouter(tags=["sessão"])


@router.get("/me")
def me(user: CurrentUser, identity: HorunIdentity = Depends(get_identity)):
    return {"username": user.username, "role": user.role.value, "level": identity.level}


def _re7s(fn, *args):
    try:
        return fn(*args)
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.get("/postrun/library/groups")
def library_groups(_user: CurrentUser):
    return _re7s(re7s_link.library_groups)


@router.get("/postrun/library/samples")
def library_samples(_user: CurrentUser):
    return _re7s(re7s_link.library_samples)
