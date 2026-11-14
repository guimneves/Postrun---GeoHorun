"""PostRun, pedidos do usuário de 16/10/2026:

- os resultados só são gravados no botão "Salvar" (`/regions/preview` calcula
  sem gravar; `/regions/save` grava/atualiza/apaga de uma vez);
- "Verificar novamente": leitura dos `.B00` do job em segundo plano
  (`/scan`), com a lista saindo do cache enquanto a leitura anda.
"""

import pytest

from app.modules import agent_bridge, postrun_scan
from tests.b00_factory import JOB_STD, T1, T2

JOB = JOB_STD


@pytest.fixture(autouse=True)
def _jobs_dir(jobs):
    # cópia: editar a massa grava Quant= no .B00
    return jobs


def _region(token=T1, start=100, end=400, **extra):
    return {"token": token, "channel": "pyro:FID", "label": "S2", "start_idx": start, "end_idx": end, **extra}


# ------------------------------------------------------------------ salvar


def test_preview_computes_area_without_saving(user_client):
    r = user_client.post("/api/postrun/regions/preview", json={"regions": [_region(), _region(T2)]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [p["token"] for p in body] == [T1, T2]
    assert all(p["area"] is not None and p["area_error"] is None for p in body)
    assert user_client.get("/api/postrun/regions", params={"tokens": [T1, T2]}).json() == []


def test_save_upserts_one_region_per_analysis_and_channel(user_client):
    r = user_client.put("/api/postrun/regions/save", json={"upserts": [_region(), _region(T2)]})
    assert r.status_code == 200, r.text
    first = {x["token"]: x for x in r.json()}
    assert set(first) == {T1, T2}

    # "Aplicar a todas" + Salvar de novo: atualiza, não duplica
    r = user_client.put(
        "/api/postrun/regions/save",
        json={"upserts": [_region(start=150, end=350), _region(T2, start=150, end=350)]},
    )
    assert r.status_code == 200, r.text
    listed = user_client.get("/api/postrun/regions", params={"tokens": [T1, T2]}).json()
    assert len(listed) == 2
    assert {(x["start_idx"], x["end_idx"]) for x in listed} == {(150, 350)}
    assert {x["id"] for x in listed} == {x["id"] for x in first.values()}


def test_save_deletes_marked_regions_in_the_same_click(user_client):
    saved = user_client.put("/api/postrun/regions/save", json={"upserts": [_region(), _region(T2)]}).json()
    gone = next(x["id"] for x in saved if x["token"] == T2)
    r = user_client.put("/api/postrun/regions/save", json={"upserts": [_region(start=120)], "delete_ids": [gone]})
    assert r.status_code == 200, r.text
    listed = user_client.get("/api/postrun/regions", params={"tokens": [T1, T2]}).json()
    assert [(x["token"], x["start_idx"]) for x in listed] == [(T1, 120)]


def test_save_rejects_bad_token_and_baseline(user_client):
    assert user_client.put("/api/postrun/regions/save", json={"upserts": [_region("../x.B00")]}).status_code in (400, 404)
    r = user_client.put("/api/postrun/regions/save", json={"upserts": [_region(baseline_mode="torta")]})
    assert r.status_code == 400
    assert user_client.get("/api/postrun/regions").json() == []


# ------------------------------------------------------- segundo plano


def test_scan_local_mode_finishes_at_once(user_client):
    r = user_client.post("/api/postrun/scan", json={"job": JOB})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "done" and body["total"] == body["read"] == 2
    assert user_client.get("/api/postrun/scan", params={"job": "Outro"}).json()["state"] == "idle"
    assert user_client.post("/api/postrun/scan", json={"job": "a/b"}).status_code == 400


def _agent_mode(monkeypatch, *, read_text):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "agent_mode", True)
    monkeypatch.setattr(agent_bridge, "list_files", lambda *_a, **_k: [T1, T2, "Outro/x.B00"])
    monkeypatch.setattr(agent_bridge, "read_text", read_text)


def test_scan_reads_in_background_and_list_comes_from_cache(user_client, jobs, monkeypatch):
    calls: list[str] = []

    def read_text(_session, _root, token, **_k):
        calls.append(token)
        return (jobs / token).read_text(encoding="latin-1")

    _agent_mode(monkeypatch, read_text=read_text)
    assert user_client.post("/api/postrun/scan", json={"job": JOB}).json()["state"] in ("running", "done")
    state = postrun_scan.wait(JOB)
    assert state is not None and state.state == "done", state and state.error
    body = user_client.get("/api/postrun/scan", params={"job": JOB}).json()
    assert (body["total"], body["read"], body["failed"]) == (2, 2, 0)

    listed = user_client.get("/api/postrun/analyses", params={"job": JOB}).json()
    assert {a["token"] for a in listed} == {T1, T2}
    assert sorted(calls) == [T1, T2]  # a lista não foi ao agente de novo

    # "Verificar novamente": lista outra vez, mas não relê o que já está no cache
    user_client.post("/api/postrun/scan", json={"job": JOB})
    postrun_scan.wait(JOB)
    assert len(calls) == 2


def test_scan_retries_failures_once_and_counts_the_rest(user_client, jobs, monkeypatch):
    attempts: dict[str, int] = {}

    def read_text(_session, _root, token, **_k):
        attempts[token] = attempts.get(token, 0) + 1
        if token == T2:
            raise agent_bridge.AgentTaskError("arquivo em uso")
        if attempts[token] == 1:
            raise agent_bridge.AgentTaskError("falha passageira")
        return (jobs / token).read_text(encoding="latin-1")

    _agent_mode(monkeypatch, read_text=read_text)
    user_client.post("/api/postrun/scan", json={"job": JOB})
    state = postrun_scan.wait(JOB)
    assert state.state == "done"
    assert (state.read, state.failed) == (1, 1)
    assert attempts == {T1: 2, T2: 2}
    listed = user_client.get("/api/postrun/analyses", params={"job": JOB}).json()
    assert [a["token"] for a in listed] == [T1]


def test_scan_stops_when_the_agent_stops_answering(user_client, monkeypatch):
    def read_text(*_a, **_k):
        raise agent_bridge.AgentTimeoutError("sem resposta")

    _agent_mode(monkeypatch, read_text=read_text)
    monkeypatch.setattr(agent_bridge, "list_files", lambda *_a, **_k: [f"{JOB}/BULK ROCK/{i}.B00" for i in range(6)])
    user_client.post("/api/postrun/scan", json={"job": JOB})
    state = postrun_scan.wait(JOB)
    assert state.state == "error" and "Verificar novamente" in (state.error or "")
    assert state.failed == 6


def test_rename_invalidates_saved_lists(user_client, jobs, monkeypatch):
    _agent_mode(monkeypatch, read_text=lambda _s, _r, token, **_k: (jobs / token).read_text(encoding="latin-1"))
    user_client.post("/api/postrun/scan", json={"job": JOB})
    postrun_scan.wait(JOB)
    assert postrun_scan.get(JOB) is not None
    postrun_scan.invalidate_all()
    assert postrun_scan.get(JOB) is None


def test_meta_partial_update_keeps_other_field(user_client):
    """Editar só a massa (navegador de análises) não apaga a composição."""
    tok = T1
    r = user_client.put("/api/postrun/analyses/meta", json=[{"token": tok, "mass_mg": 10.0, "composition_text": "PS 50, PP 50"}])
    assert r.status_code == 200, r.text
    r = user_client.put("/api/postrun/analyses/meta", json=[{"token": tok, "mass_mg": 12.5}])
    a = r.json()[0]
    assert a["mass_mg"] == 12.5 and a["composition_source"] == "manual"
    r = user_client.put("/api/postrun/analyses/meta", json=[{"token": tok, "mass_mg": None}])
    a = r.json()[0]
    assert a["mass_source"] != "manual" and a["composition_source"] == "manual"
