"""Quem pede (app/api/deps.py): identidade do Core → linha local `User`;
papel recalculado a cada pedido pelo nível do Core (1..admin_max_level =
admin), nome atualizado quando muda no Core."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api.deps import _user_for
from app.core.identity import HorunIdentity
from app.db.models import PostrunRegion, Role, User
from tests.b00_factory import T1
from tests.conftest import headers


@pytest.mark.parametrize(("level", "role"), [(1, Role.ADMIN), (2, Role.ADMIN), (3, Role.USER), (4, Role.USER),
                                             (5, Role.USER)])
def test_level_maps_to_role(db_engine, level, role):
    with Session(db_engine) as s:
        user = _user_for(s, HorunIdentity(user_id=f"u{level}", username="x", role="user", level=level))
        assert user.role == role and user.core_user_id == f"u{level}"


def test_admin_max_level_is_configurable(db_engine, monkeypatch):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "admin_max_level", 3)
    with Session(db_engine) as s:
        assert _user_for(s, HorunIdentity("a", "a", "user", level=3)).role == Role.ADMIN
        assert _user_for(s, HorunIdentity("b", "b", "user", level=4)).role == Role.USER


def test_username_and_role_follow_the_core(db_engine):
    from app.main import app

    client = TestClient(app)
    assert client.get("/api/postrun/regions", headers=headers(3, "ana", "42")).status_code == 200
    assert client.get("/api/postrun/regions", headers=headers(2, "Ana Souza", "42")).status_code == 200
    with Session(db_engine) as s:
        (user,) = s.exec(select(User).where(User.core_user_id == "42")).all()  # a mesma linha
        assert user.username == "Ana Souza" and user.role == Role.ADMIN
    client.get("/api/postrun/regions", headers=headers(4, "Ana Souza", "42"))
    with Session(db_engine) as s:
        assert s.exec(select(User).where(User.core_user_id == "42")).one().role == Role.USER  # rebaixada


def test_admin_routes_follow_the_level(db_engine, jobs):
    from app.main import app

    client = TestClient(app)
    body = {"token": T1, "extra": "rep", "dry_run": True}
    assert client.post("/api/postrun/analyses/rename", json=body, headers=headers(3, "ana", "1")).status_code == 403
    assert client.post("/api/postrun/analyses/rename", json=body, headers=headers(2, "ana", "1")).status_code == 200


def test_missing_identity_is_401_and_bad_level_is_the_lowest(db_engine):
    from app.main import app

    client = TestClient(app)
    assert client.get("/api/postrun/regions").status_code == 401
    assert client.get("/api/postrun/regions", headers={"X-Horun-User-Id": "9"}).status_code == 401
    bad = {**headers(2, "x", "9"), "X-Horun-Level": "chefe"}
    assert client.get("/api/postrun/regions", headers=bad).status_code == 200
    with Session(db_engine) as s:
        assert s.exec(select(User).where(User.core_user_id == "9")).one().role == Role.USER


def test_rows_point_to_the_local_user(user_client, second_user_client, jobs, db_engine):
    for client in (user_client, second_user_client):
        r = client.post("/api/postrun/regions", json={
            "token": T1, "channel": "pyro:FID", "label": "x", "start_idx": 10, "end_idx": 20,
        })
        assert r.status_code == 200, r.text
    with Session(db_engine) as s:
        users = {u.core_user_id: u.id for u in s.exec(select(User)).all()}
        authors = [r.created_by_id for r in s.exec(select(PostrunRegion).order_by(PostrunRegion.id)).all()]
    assert authors == [users["2"], users["3"]] and users["2"] != users["3"]
