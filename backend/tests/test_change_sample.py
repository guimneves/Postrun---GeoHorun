"""Trocar a amostra de análises já feitas pelo PostRun (pedido do usuário,
2026-10-20): `Sample=` dentro do `.B00`/`.B00~` + o código no nome do
arquivo, em lote (réplicas), só com amostras da biblioteca do RE7S (falsa,
`re7s.add_library_sample`). Roda sobre uma CÓPIA dos .B00 sintéticos."""

from __future__ import annotations

import shutil

import pytest
from sqlmodel import Session, select

from app.db.models import AnalysisRename, PostrunRegion
from app.modules import agent_bridge, b00_sample
from app.modules.analysis_rename import RenameError, sample_corrections
from tests.b00_factory import T1, T2

DIR = "PADRAO/BULK ROCK"


@pytest.fixture()
def jobs(jobs):
    # .B00~ com o Sample= também (como o GeoWorks guarda a versão anterior)
    (jobs / f"{T1}~").write_bytes(b"[Param]\r\nSample=STDA\r\nType=Analysis\r\n")
    return jobs


def test_sample_line_is_replaced_and_nothing_else():
    content = b"[Param]\r\nSample=ERRADA\r\nType=Analysis\r\n[Data]\r\nSample=nao mexer\r\n1;2;3\r\n"
    assert b00_sample.read_sample(content) == "ERRADA"
    out = b00_sample.with_sample(content, "CERTA")
    assert out == content.replace(b"Sample=ERRADA", b"Sample=CERTA", 1)
    with pytest.raises(RenameError, match="ASCII"):
        b00_sample.with_sample(content, "Amostra Ç")


def test_generated_b00_sample_and_quantity_lines(b00_source):
    content = (b00_source / T1).read_bytes()
    assert b00_sample.read_sample(content) == "STDA"
    assert b00_sample.read_quantity(content) == 60.0
    assert b00_sample.read_quantity(b00_sample.with_quantity(content, 12.3456)) == 12.346


@pytest.mark.parametrize(
    ("name", "old", "expected"),
    [
        ("2026-07-17_STDA_1", "STDA", ("2026-07-17", "", 1)),
        ("2026-07-17_PE_AD_rep_3", "PE_AD", ("2026-07-17", "_rep", 3)),  # código com "_" e extra
    ],
)
def test_name_parts(name, old, expected):
    assert b00_sample.split_name(name, old) == expected


def test_name_must_start_with_the_code_in_the_file():
    with pytest.raises(RenameError, match="não começa pelo código"):
        b00_sample.split_name("2026-07-17_OUTRA_1", "STDA")


def test_change_sample_in_batch_renumbers_replicas(admin_client, db_engine, jobs, b00_source, re7s):
    right = re7s.add_library_sample("STD_CERTA", "Padrão certo")
    # PostRun da análise segue o arquivo
    admin_client.put("/api/postrun/regions/save", json={"upserts": [
        {"token": T1, "channel": "pyro:FID", "label": "S2", "start_idx": 100, "end_idx": 400}]})

    preview = admin_client.post("/api/postrun/analyses/change-sample",
                                json={"tokens": [T2, T1], "library_sample_id": right, "dry_run": True})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert [i["new_analysis_name"] for i in body["items"]] == ["2026-07-17_STD_CERTA_1", "2026-07-17_STD_CERTA_2"]
    assert all(i["status"] == "planned" and i["old_sample"] == "STDA" for i in body["items"])
    assert (jobs / T1).exists()  # prévia não mexe em nada

    r = admin_client.post("/api/postrun/analyses/change-sample", json={"tokens": [T1, T2], "library_sample_id": right})
    assert r.status_code == 200, r.text
    assert r.json()["done"] == 2 and r.json()["code"] == "STD_CERTA"
    new1 = jobs / DIR / "2026-07-17_STD_CERTA_1.B00"
    assert new1.exists() and not (jobs / T1).exists()
    assert b00_sample.read_sample(new1.read_bytes()) == "STD_CERTA"
    assert b00_sample.read_sample((jobs / DIR / "2026-07-17_STD_CERTA_1.B00~").read_bytes()) == "STD_CERTA"
    # fora a linha Sample=, o arquivo é o mesmo
    original = (b00_source / T1).read_bytes()
    assert new1.read_bytes() == b00_sample.with_sample(original, "STD_CERTA")
    with Session(db_engine) as s:
        assert s.exec(select(PostrunRegion)).first().token == f"{DIR}/2026-07-17_STD_CERTA_1.B00"
        recs = s.exec(select(AnalysisRename).where(AnalysisRename.new_sample == "STD_CERTA")).all()
        assert len(recs) == 2 and {r.old_sample for r in recs} == {"STDA"}
        assert {r.new_library_sample_id for r in recs} == {right}
    # o RE7S recebe a troca (amostra nova e id na biblioteca) na réplica
    final = {x["id"]: x for x in re7s.renames}  # a última réplica de cada renomeação vale
    assert {(x["old_sample"], x["new_sample"], x["new_library_sample_id"]) for x in final.values()} == {
        ("STDA", "STD_CERTA", right)
    }

    # refazer: já está certo → pulado
    again = admin_client.post("/api/postrun/analyses/change-sample", json={
        "tokens": [f"{DIR}/2026-07-17_STD_CERTA_1.B00"], "library_sample_id": right}).json()
    assert again["skipped"] == 1

    # outra amostra errada do mesmo dia vira a réplica seguinte (o _1 já existe)
    shutil.copy(b00_source / T1, jobs / DIR / "2026-07-17_OUTRA_1.B00")
    p = jobs / DIR / "2026-07-17_OUTRA_1.B00"
    p.write_bytes(b00_sample.with_sample(p.read_bytes(), "OUTRA"))
    third = admin_client.post("/api/postrun/analyses/change-sample", json={
        "tokens": [f"{DIR}/2026-07-17_OUTRA_1.B00"], "library_sample_id": right}).json()["items"][0]
    assert third["status"] == "done" and third["renumbered"] and third["new_analysis_name"] == "2026-07-17_STD_CERTA_3"


def test_each_analysis_can_go_to_a_different_sample(admin_client, db_engine, jobs, re7s):
    # pedido do usuário (2026-11-19): trocar para amostras diferentes no mesmo lote
    a = re7s.add_library_sample("AMOSTRA_A")
    b = re7s.add_library_sample("AMOSTRA_B")
    body = {"assignments": [{"token": T1, "library_sample_id": a}, {"token": T2, "library_sample_id": b}]}
    preview = admin_client.post("/api/postrun/analyses/change-sample", json={**body, "dry_run": True})
    assert preview.status_code == 200, preview.text
    planned = {i["token"]: (i["code"], i["new_analysis_name"]) for i in preview.json()["items"]}
    assert planned == {T1: ("AMOSTRA_A", "2026-07-17_AMOSTRA_A_1"), T2: ("AMOSTRA_B", "2026-07-17_AMOSTRA_B_2")}
    assert preview.json()["code"] is None  # mais de uma amostra no lote

    r = admin_client.post("/api/postrun/analyses/change-sample", json=body).json()
    assert r["done"] == 2
    assert {(i["token"], i["new_analysis_name"]) for i in r["items"]} == {
        (t, n) for t, (_, n) in planned.items()}  # a prévia é o que aconteceu
    assert b00_sample.read_sample((jobs / DIR / "2026-07-17_AMOSTRA_A_1.B00").read_bytes()) == "AMOSTRA_A"
    assert b00_sample.read_sample((jobs / DIR / "2026-07-17_AMOSTRA_B_2.B00").read_bytes()) == "AMOSTRA_B"
    with Session(db_engine) as s:
        recs = s.exec(select(AnalysisRename).where(AnalysisRename.old_sample == "STDA")).all()
        assert {(r.new_sample, r.new_library_sample_id) for r in recs} == {("AMOSTRA_A", a), ("AMOSTRA_B", b)}

    # sem amostra nenhuma: erro claro; amostra que não existe: 404
    assert admin_client.post("/api/postrun/analyses/change-sample", json={"tokens": [T1]}).status_code == 422
    assert admin_client.post("/api/postrun/analyses/change-sample", json={
        "assignments": [{"token": T1, "library_sample_id": 999}]}).status_code == 404


def test_batch_in_parts_gives_the_same_names(admin_client, db_engine, jobs, b00_source, re7s):
    # 2026-11-19: 21 análises passavam dos 30 s do proxy do Core — a interface
    # manda a operação em partes; os nomes têm de sair iguais aos de um pedido só
    a = re7s.add_library_sample("AMOSTRA_A")
    other = jobs / DIR / "2026-07-17_OUTRA_1.B00"
    shutil.copy(b00_source / T1, other)
    other.write_bytes(b00_sample.with_sample(other.read_bytes(), "OUTRA"))
    t_other = f"{DIR}/2026-07-17_OUTRA_1.B00"
    everything = [T1, t_other]
    url = "/api/postrun/analyses/change-sample"

    whole = admin_client.post(url, json={"assignments": [{"token": t, "library_sample_id": a} for t in everything],
                                         "dry_run": True}).json()
    planned = {i["token"]: i["new_analysis_name"] for i in whole["items"]}
    assert sorted(planned.values()) == ["2026-07-17_AMOSTRA_A_1", "2026-07-17_AMOSTRA_A_2"]

    # prévia em partes, na ordem devolvida pelo pedido inteiro
    order = [i["token"] for i in whole["items"]]
    reserved: list[str] = []
    for t in order:
        part = admin_client.post(url, json={"assignments": [{"token": t, "library_sample_id": a}], "dry_run": True,
                                            "context_tokens": everything, "reserved_names": reserved}).json()
        item = part["items"][0]
        assert item["new_analysis_name"] == planned[t]
        reserved.append(item["new_analysis_name"])

    # troca de verdade, uma por vez
    for t in order:
        part = admin_client.post(url, json={"assignments": [{"token": t, "library_sample_id": a}],
                                            "context_tokens": everything}).json()
        assert part["items"][0]["status"] == "done"
        assert part["items"][0]["new_analysis_name"] == planned[t]


def test_read_only_agent_folder_changes_nothing(admin_client, db_engine, jobs, monkeypatch, re7s):
    right = re7s.add_library_sample("STD_CERTA")
    monkeypatch.setattr("app.api.routes_analysis_rename.settings.agent_mode", True)
    monkeypatch.setattr(agent_bridge, "read_bytes", lambda s, root, path, **k: (jobs / path).read_bytes())

    def refuse(*a, **k):
        raise agent_bridge.AgentTaskError("sem permissão para escrever em 'jobs'", code="read_only")

    monkeypatch.setattr(agent_bridge, "write_bytes", refuse)
    r = admin_client.post("/api/postrun/analyses/change-sample",
                          json={"tokens": [T1, T2], "library_sample_id": right}).json()
    first, second = r["items"]
    assert first["status"] == "failed" and "read-write" in first["error"]
    assert second["status"] == "skipped"  # o lote para: vale para todas
    assert (jobs / T1).exists() and b00_sample.read_sample((jobs / T1).read_bytes()) == "STDA"


def test_only_library_samples_and_admins(user_client, admin_client, jobs, re7s):
    assert admin_client.post("/api/postrun/analyses/change-sample",
                             json={"tokens": [T1], "library_sample_id": 999}).status_code == 404
    right = re7s.add_library_sample("STD_CERTA")
    assert user_client.post("/api/postrun/analyses/change-sample",
                            json={"tokens": [T1], "library_sample_id": right}).status_code == 403
    re7s.down = True
    assert admin_client.post("/api/postrun/analyses/change-sample",
                             json={"tokens": [T1], "library_sample_id": right}).status_code == 502


def test_corrections_map_history(db_engine):
    with Session(db_engine) as s:
        assert sample_corrections(s) == {}
        s.add(AnalysisRename(
            old_token="a", new_token="b", old_analysis_name="a", new_analysis_name="b", old_job="J", new_job="J",
            history_entry_id=101, old_sample="ERRADA", new_sample="CERTA", new_library_sample_id=5,
            status="done", renamed_by_id=1,
        ))
        s.commit()
        assert sample_corrections(s) == {101: ("CERTA", 5)}
