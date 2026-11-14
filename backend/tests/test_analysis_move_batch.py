"""Mover várias análises do PostRun para outro job de uma vez (pedido do
usuário, 2026-10-14: "Postrun mover em lote"). Cada análise passa pelas
mesmas regras do mover individual (`/api/postrun/analyses/rename`); falhas
são por análise, nunca derrubam o lote. Roda sobre uma CÓPIA dos .B00
sintéticos (tests/b00_factory.py)."""

from __future__ import annotations

import shutil

import pytest
from sqlmodel import Session, select

from app.db.models import AnalysisRename, PostrunRegion
from app.modules import agent_bridge
from tests.b00_factory import JOB_STD, T1, T2, T3


@pytest.fixture()
def jobs(jobs):
    (jobs / (T1 + "~")).write_bytes(b"versao anterior do GeoWorks")
    return jobs


def _move(client, tokens, job="Destino", **extra):
    return client.post("/api/postrun/analyses/move-batch", json={"tokens": tokens, "job": job, **extra})


def test_moves_all_selected_to_the_destination_job(admin_client, jobs, re7s):
    r = _move(admin_client, [T1, T2, T3])
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["done"], body["failed"], body["skipped"]) == (3, 0, 0)
    assert [i["new_token"] for i in body["items"]] == [
        "Destino/BULK ROCK/2026-07-17_STDA_1.B00",
        "Destino/BULK ROCK/2026-07-17_STDA_2.B00",
        "Destino/BULK ROCK/RE7_MIXX_0_11052026.B00",
    ]
    for item in body["items"]:
        assert (jobs / item["new_token"]).is_file()
        assert not (jobs / item["token"]).exists()
    assert (jobs / "Destino/BULK ROCK/2026-07-17_STDA_1.B00~").is_file()  # o .B00~ anda junto
    assert [x["new_job"] for x in re7s.renames] == ["Destino"] * 3  # uma réplica por análise


def test_dry_run_moves_nothing(admin_client, jobs):
    body = _move(admin_client, [T1, T2], dry_run=True).json()
    assert [i["status"] for i in body["items"]] == ["planned", "planned"]
    assert (jobs / T1).exists() and (jobs / T2).exists()


def test_partial_failure_is_reported_per_analysis(admin_client, jobs, db_engine):
    # destino já ocupado no disco para T2 — só ela falha, as outras andam
    dest = jobs / "Destino/BULK ROCK"
    dest.mkdir(parents=True)
    (dest / "2026-07-17_STDA_2.B00").write_bytes(b"outro")
    body = _move(admin_client, [T1, T2, T3]).json()
    status = {i["token"]: i for i in body["items"]}
    assert status[T1]["status"] == "done" and status[T3]["status"] == "done"
    assert status[T2]["status"] == "failed" and "Nada foi alterado" in status[T2]["error"]
    assert (body["done"], body["failed"]) == (2, 1)
    assert (jobs / T2).exists()  # a que falhou ficou onde estava
    with Session(db_engine) as s:
        assert {r.old_token for r in s.exec(select(AnalysisRename)).all()} == {T1, T3}


def test_analysis_still_in_the_carousel_fails_alone(admin_client, jobs, re7s):
    re7s.carousel["2026-07-17_STDA_1"] = 3
    body = _move(admin_client, [T1, T2]).json()
    assert body["items"][0]["status"] == "failed" and "carrossel" in body["items"][0]["error"]
    assert body["items"][1]["status"] == "done"


def test_already_in_the_job_is_skipped(admin_client, jobs):
    body = _move(admin_client, [T1, T3], job=JOB_STD).json()
    assert body["items"][0]["status"] == "skipped" and "Já está" in body["items"][0]["error"]
    assert body["items"][1]["status"] == "done"


def test_two_analyses_with_the_same_destination_in_one_batch(admin_client, jobs):
    other = jobs / "Outro/BULK ROCK"
    other.mkdir(parents=True)
    shutil.copy(jobs / T1, other / "2026-07-17_STDA_1.B00")
    body = _move(admin_client, [T1, "Outro/BULK ROCK/2026-07-17_STDA_1.B00"], dry_run=True).json()
    assert body["items"][0]["status"] == "planned"
    assert body["items"][1]["status"] == "failed" and "mesmo lugar" in body["items"][1]["error"]


def test_postrun_regions_follow_each_moved_file(admin_client, jobs, db_engine):
    for token in (T1, T2):
        r = admin_client.post("/api/postrun/regions", json={
            "token": token, "channel": "pyro:FID", "label": "S2", "start_idx": 10, "end_idx": 20,
        })
        assert r.status_code == 200, r.text
    assert _move(admin_client, [T1, T2]).json()["done"] == 2
    with Session(db_engine) as s:
        assert {r.token for r in s.exec(select(PostrunRegion)).all()} == {
            "Destino/BULK ROCK/2026-07-17_STDA_1.B00",
            "Destino/BULK ROCK/2026-07-17_STDA_2.B00",
        }


def test_agent_timeout_stops_the_batch(admin_client, jobs, monkeypatch):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "agent_mode", True)
    calls = []

    def timeout(*_a, **_k):
        calls.append(1)
        raise agent_bridge.AgentTimeoutError("sem resposta")

    monkeypatch.setattr(agent_bridge, "move_files", timeout)
    body = _move(admin_client, [T1, T2, T3]).json()
    assert len(calls) == 1  # não fica esperando o prazo de novo para cada uma
    assert [i["status"] for i in body["items"]] == ["failed", "skipped", "skipped"]
    assert "Não tentada" in body["items"][1]["error"]


def test_only_admin_and_valid_job(user_client, admin_client, jobs):
    assert _move(user_client, [T1]).status_code == 403
    assert _move(admin_client, [T1], job="a:b").status_code == 400
    assert _move(admin_client, []).status_code == 422
    assert (jobs / T1).exists()
