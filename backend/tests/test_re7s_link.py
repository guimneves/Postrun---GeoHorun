"""Conversa com o RE7S (app/modules/re7s_link.py): fundo sem RE7S
(desenvolvimento), fundo HTTP (produção, rotas internas) e a fila de saída
das réplicas de renomeação."""

from __future__ import annotations

import io
import json
import time
import urllib.error

import pytest
from sqlmodel import Session, select

from app.modules import re7s_link
from app.modules.re7s_link import HttpBackend, RenameReplica, StandaloneBackend
from tests.b00_factory import T1


@pytest.fixture()
def standalone(monkeypatch):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "re7s_url", "")
    monkeypatch.setattr(config_module.settings, "re7s_token", "")
    re7s_link.set_backend(None)


# ------------------------------------------------------------------ sem RE7S


def test_standalone_defaults(standalone):
    assert isinstance(re7s_link.backend(), StandaloneBackend) and not re7s_link.configured()
    assert re7s_link.analysis_name_info("2026-07-17_X_1") == {"in_carousel": None, "taken": False, "history": None}
    assert re7s_link.waiting_on_carousel("x") is None and re7s_link.name_taken_in_queue("x") is False
    assert re7s_link.history_entry_by_name("x") is None and re7s_link.history_entry_by_id(1) is None
    assert re7s_link.library_sample(1) is None and re7s_link.standard(1) is None
    assert re7s_link.library_groups() == [] and re7s_link.library_samples() == [] and re7s_link.standards() == []
    with pytest.raises(re7s_link.Re7sUnavailable, match="não configurado"):
        re7s_link.backend().post("/renames", {})


def test_http_backend_only_with_url_and_token(monkeypatch):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "re7s_url", "http://re7s-backend:8000/")
    monkeypatch.setattr(config_module.settings, "re7s_token", "")
    re7s_link.set_backend(None)
    assert isinstance(re7s_link.backend(), StandaloneBackend)  # sem token: não liga
    monkeypatch.setattr(config_module.settings, "re7s_token", "segredo")
    re7s_link.set_backend(None)
    b = re7s_link.backend()
    assert isinstance(b, HttpBackend) and re7s_link.configured()
    assert b.base == "http://re7s-backend:8000/internal/geohorun"


def test_rename_works_without_re7s_and_keeps_the_replica_queued(standalone, admin_client, jobs, db_engine):
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": T1, "extra": "rep"})
    assert r.status_code == 200, r.text
    with Session(db_engine) as s:
        (item,) = s.exec(select(RenameReplica)).all()
        assert item.state == "pendente" and item.attempts == 1 and "não configurado" in item.last_error
        assert re7s_link.retry_replicas(s) == {"tried": 1, "sent": 0}


# ------------------------------------------------------------------ HTTP


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def http(monkeypatch):
    """HttpBackend com `urlopen` trocado: `answer(request)` devolve o objeto
    JSON ou levanta o erro de rede/HTTP."""
    seen: list = []
    state = {"answer": lambda req: None}

    def fake_urlopen(req, timeout=None):
        seen.append((req, timeout))
        return _Resp(json.dumps(state["answer"](req)).encode("utf-8"))

    monkeypatch.setattr(re7s_link.urllib.request, "urlopen", fake_urlopen)
    backend = HttpBackend("http://re7s:8000", "segredo", timeout=3.0)
    re7s_link.set_backend(backend)
    return state, seen


def _http_error(code: int, body: bytes = b"erro"):
    return urllib.error.HTTPError("http://re7s", code, "x", {}, io.BytesIO(body))


def test_http_backend_requests(http):
    state, seen = http
    state["answer"] = lambda req: {"in_carousel": 5, "taken": True, "history": {"id": 9, "extra": "rep"}}
    assert re7s_link.waiting_on_carousel("2026-07-17_A B_1").crucible == 5
    req, timeout = seen[-1]
    assert req.full_url == "http://re7s:8000/internal/geohorun/analysis-name/2026-07-17_A%20B_1"
    assert req.get_method() == "GET" and req.get_header("Authorization") == "Bearer segredo" and timeout == 3.0

    state["answer"] = lambda req: [{"id": 1, "code": "X", "name": "X"}]
    assert re7s_link.library_samples(group_id=4) == [{"id": 1, "code": "X", "name": "X"}]
    assert seen[-1][0].full_url.endswith("/library/samples?group_id=4")

    state["answer"] = lambda req: {"ok": True}
    re7s_link.backend().post("/renames", {"id": 1})
    req = seen[-1][0]
    assert req.get_method() == "POST" and json.loads(req.data) == {"id": 1}
    assert req.get_header("Content-type") == "application/json"


def test_http_backend_errors(http):
    state, _seen = http

    def not_found(req):
        raise _http_error(404)

    state["answer"] = not_found
    assert re7s_link.library_sample(3) is None  # 404 = não existe, não é erro

    def server_error(req):
        raise _http_error(500, b"banco caiu")

    state["answer"] = server_error
    with pytest.raises(re7s_link.Re7sUnavailable, match="500: banco caiu"):
        re7s_link.standards()

    def offline(req):
        raise urllib.error.URLError("connection refused")

    state["answer"] = offline
    with pytest.raises(re7s_link.Re7sUnavailable, match="inacessível"):
        re7s_link.analysis_name_info("x")


def test_http_backend_error_is_502_in_the_rename_routes(http, admin_client, jobs, re7s):
    state, _seen = http

    def offline(req):
        raise urllib.error.URLError("connection refused")

    state["answer"] = offline
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": T1, "extra": "rep"})
    assert r.status_code == 502 and "RE7S inacessível" in r.json()["detail"]
    assert (jobs / T1).exists()  # nunca um "liberado" silencioso
    assert admin_client.get("/api/postrun/analyses/rename-info", params={"token": T1}).status_code == 502
    batch = admin_client.post("/api/postrun/analyses/move-batch", json={"tokens": [T1], "job": "Outro"}).json()
    assert batch["items"][0]["status"] == "failed" and "RE7S" in batch["items"][0]["error"]
    assert admin_client.post("/api/postrun/analyses/change-sample",
                             json={"tokens": [T1], "library_sample_id": 1}).status_code == 502


# ------------------------------------------------------------------ fila de saída


def test_replica_waits_while_re7s_is_down_and_retry_sends_it(admin_client, jobs, db_engine, re7s):
    re7s.posts_down = True  # o RE7S responde às consultas, mas não recebe a réplica
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": T1, "extra": "rep"})
    assert r.status_code == 200, r.text  # a renomeação não depende da réplica
    assert re7s.renames == []
    with Session(db_engine) as s:
        (item,) = s.exec(select(RenameReplica)).all()
        assert item.state == "pendente" and item.attempts == 1 and "503" in item.last_error
        assert re7s_link.retry_replicas(s) == {"tried": 1, "sent": 0}

        re7s.posts_down = False
        assert re7s_link.retry_replicas(s) == {"tried": 1, "sent": 1}
        s.refresh(item)
        assert item.state == "enviado" and item.sent_at is not None and item.last_error == "" and item.attempts == 3
        assert re7s_link.retry_replicas(s) == {"tried": 0, "sent": 0}
    (sent,) = re7s.renames
    assert sent["old_token"] == T1 and sent["new_analysis_name"] == "2026-07-17_STDA_rep_1" and sent["status"] == "done"


def test_replica_worker_of_the_app_resends(monkeypatch, admin_client, jobs, db_engine, re7s):
    from app import main
    from app.core import config as config_module

    re7s.posts_down = True
    assert admin_client.post("/api/postrun/analyses/rename", json={"token": T1, "extra": "rep"}).status_code == 200
    re7s.posts_down = False
    monkeypatch.setattr(config_module.settings, "outbox_retry_seconds", 0.05)
    stop = main._start_replica_worker()
    try:
        deadline = time.monotonic() + 5
        while not re7s.renames and time.monotonic() < deadline:
            time.sleep(0.05)
    finally:
        stop.set()
    assert len(re7s.renames) == 1
