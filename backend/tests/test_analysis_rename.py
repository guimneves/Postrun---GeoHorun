"""Renomear nome/job de uma análise já feita (mover .B00 + .B00~) — pedido do
usuário, 2026-10-01. Roda sobre uma CÓPIA dos .B00 sintéticos
(tests/b00_factory.py). A fila do RE7S (carrossel, histórico, nomes já
usados) vem do RE7S falso do conftest; cada renomeação vira uma réplica
mandada a ele."""

from __future__ import annotations

import pytest
from sqlmodel import Session, select

from app.db.models import AnalysisRename, PostrunAnalysisMeta, PostrunRegion
from app.modules import agent_bridge
from app.modules import analysis_rename as ar
from tests.b00_factory import JOB_STD, T1, T2, T3

TOKEN = T1
NAME = "2026-07-17_STDA_1"
RENAMED = "2026-07-17_STDA_rep_1"


@pytest.fixture()
def jobs(jobs):
    # o conjunto sintético não tem o .B00~ ao lado do T1 — cria um (conteúdo diferente, como no equipamento)
    (jobs / (TOKEN + "~")).write_bytes(b"versao anterior do GeoWorks")
    return jobs


# ---------------------------------------------------------------- regras puras


def test_split_token_handles_nested_method_folders():
    p = ar.split_token("Cinetica_X/Rochas_Y/BULK ROCK/2026-05-01_X_1.B00")
    assert (p.job, p.method_dirs, p.name) == ("Cinetica_X", ("Rochas_Y", "BULK ROCK"), "2026-05-01_X_1")


@pytest.mark.parametrize(
    ("name", "extra", "expected"),
    [
        (NAME, "rep", RENAMED),
        ("2026-07-17_C_Amostra_Trit_2", "moido", "2026-07-17_C_Amostra_Trit_moido_2"),
        ("2026-07-17_STDA_ja_1", "mais", "2026-07-17_STDA_ja_mais_1"),  # nunca apaga o extra que já existe
    ],
)
def test_extra_goes_before_the_replica(name, extra, expected):
    assert ar.name_with_extra(name, extra) == expected


@pytest.mark.parametrize("name", ["RE7_MIXX_0_11052026", "2026-06-11-Amostra_sem_convencao"])
def test_extra_needs_the_convention(name):
    with pytest.raises(ar.RenameError, match="nome completo"):
        ar.name_with_extra(name, "x")


@pytest.mark.parametrize("bad", ["a/b", "a:b", 'a"b', "a?b", "CON", "nome.", "   "])
def test_windows_invalid_names_are_rejected(bad):
    with pytest.raises(ar.RenameError):
        ar.validate_component(bad, "Nome")


def test_extra_cannot_contain_the_separator():
    with pytest.raises(ar.RenameError, match="separador"):
        ar.name_with_extra(NAME, "a_b")


def test_plan_moves_b00_and_optional_backup():
    target, moves = ar.plan(ar.split_token(TOKEN), new_name="N_1", new_job="J2")
    assert target.token == "J2/BULK ROCK/N_1.B00"
    assert moves == [
        {"from": TOKEN, "to": "J2/BULK ROCK/N_1.B00"},
        {"from": TOKEN + "~", "to": "J2/BULK ROCK/N_1.B00~", "optional": True},
    ]


def test_plan_refuses_no_change():
    with pytest.raises(ar.RenameError, match="Nada mudou"):
        ar.plan(ar.split_token(TOKEN), new_name=NAME, new_job=JOB_STD)


# ---------------------------------------------------------------- rota (disco local)


def _rename(client, **body):
    return client.post("/api/postrun/analyses/rename", json={"token": TOKEN, **body})


def test_admin_adds_extra_renaming_both_files_without_touching_content(admin_client, jobs):
    original = (jobs / TOKEN).read_bytes()
    r = _rename(admin_client, extra="rep")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["new_token"] == f"{JOB_STD}/BULK ROCK/{RENAMED}.B00"
    assert body["moved"] == [f"{JOB_STD}/BULK ROCK/{RENAMED}.B00", f"{JOB_STD}/BULK ROCK/{RENAMED}.B00~"]
    assert (jobs / body["new_token"]).read_bytes() == original
    assert (jobs / (body["new_token"] + "~")).read_bytes() == b"versao anterior do GeoWorks"
    assert not (jobs / TOKEN).exists() and not (jobs / (TOKEN + "~")).exists()


def test_change_job_only_moves_to_the_same_method_folder(admin_client, jobs):
    r = _rename(admin_client, job="Novo Job")
    assert r.status_code == 200, r.text
    assert (jobs / f"Novo Job/BULK ROCK/{NAME}.B00").is_file()
    assert (jobs / f"Novo Job/BULK ROCK/{NAME}.B00~").is_file()


def test_full_name_for_names_outside_the_convention(admin_client, jobs):
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": T3, "analysis_name": "2026-05-11_MIXX_1"})
    assert r.status_code == 200, r.text
    assert (jobs / "Mix X/BULK ROCK/2026-05-11_MIXX_1.B00").is_file()


def test_only_admin_renames(user_client, second_user_client, jobs):
    assert _rename(user_client, extra="rep").status_code == 403  # nível 3
    assert _rename(second_user_client, extra="rep").status_code == 403  # nível 4
    assert (jobs / TOKEN).exists()


def test_dry_run_moves_nothing(admin_client, jobs, re7s):
    r = _rename(admin_client, extra="rep", dry_run=True)
    assert r.status_code == 200 and r.json()["status"] == "planned"
    assert (jobs / TOKEN).exists()
    assert re7s.renames == []  # nada a replicar


def test_existing_destination_on_disk_changes_nothing(admin_client, jobs):
    (jobs / f"{JOB_STD}/BULK ROCK/{RENAMED}.B00~").write_bytes(b"outro")
    r = _rename(admin_client, extra="rep")
    assert r.status_code == 409 and "Nada foi alterado" in r.json()["detail"]
    assert (jobs / TOKEN).exists() and (jobs / (TOKEN + "~")).exists()


def test_postrun_regions_follow_the_renamed_file(admin_client, jobs, db_engine):
    created = admin_client.post("/api/postrun/regions", json={
        "token": TOKEN, "channel": "pyro:FID", "label": "S1",
        "start_idx": 180, "end_idx": 626, "baseline_mode": "fixed", "fixed_baseline": 90.0,
    })
    assert created.status_code == 200, created.text
    new_token = _rename(admin_client, extra="rep").json()["new_token"]
    with Session(db_engine) as s:
        assert [r.token for r in s.exec(select(PostrunRegion)).all()] == [new_token]
    listed = {a["token"]: a for a in admin_client.get("/api/postrun/analyses").json()}
    assert listed[new_token]["renamed_from"] == NAME


def test_analysis_meta_follows_the_renamed_file_with_every_column(admin_client, jobs, db_engine):
    """Bug do porte: a massa/composição seguiam o arquivo renomeado, mas a
    massa original do arquivo (`file_mass_before_mg`) e as massas reais dos
    componentes (`component_masses`) se perdiam."""
    r = admin_client.put("/api/postrun/analyses/meta", json=[{
        "token": TOKEN, "mass_mg": 12.5, "composition_text": "STD 50, X 50", "component_masses_text": "STD 6,1; X 6,4",
    }])
    assert r.status_code == 200, r.text
    with Session(db_engine) as s:
        before = s.get(PostrunAnalysisMeta, TOKEN).model_dump()
    assert before["file_mass_before_mg"] == 60.0 and before["component_masses"]

    new_token = _rename(admin_client, extra="rep").json()["new_token"]
    with Session(db_engine) as s:
        assert s.get(PostrunAnalysisMeta, TOKEN) is None
        after = s.get(PostrunAnalysisMeta, new_token).model_dump()
    assert after == {**before, "token": new_token}
    # "voltar à massa original" continua funcionando depois da renomeação
    back = admin_client.put("/api/postrun/analyses/meta", json=[{"token": new_token, "mass_mg": None}]).json()[0]
    assert back["quantity_mg"] == 60.0 and back["component_masses"] == {"STD": 6.1, "X": 6.4}


# ---------------------------------------------------------------- fila do RE7S


def test_refuses_while_the_analysis_is_still_waiting_in_the_carousel(admin_client, jobs, re7s):
    re7s.carousel[NAME] = 3
    r = _rename(admin_client, extra="rep")
    assert r.status_code == 409 and "ainda está no carrossel" in r.json()["detail"]
    assert "posição 3" in r.json()["detail"]
    assert (jobs / TOKEN).exists()


def test_rename_points_to_the_re7s_history_entry_and_is_replicated(admin_client, jobs, db_engine, re7s):
    """O histórico do RE7S nunca é editado: a renomeação guarda a entrada
    dele e vai para o RE7S como réplica (ele mostra o nome atual)."""
    hid = re7s.add_history(NAME, extra="")
    assert _rename(admin_client, extra="rep").status_code == 200
    with Session(db_engine) as s:
        record = s.exec(select(AnalysisRename)).one()
        assert record.history_entry_id == hid and record.status == "done"
    assert re7s.history[hid]["analysis_name"] == NAME  # o histórico continua com o nome original
    (sent,) = re7s.renames
    assert (sent["old_analysis_name"], sent["new_analysis_name"]) == (NAME, RENAMED)
    assert sent["history_entry_id"] == hid and sent["status"] == "done" and sent["new_job"] == JOB_STD


def test_new_name_cannot_collide_with_a_carousel_sample(admin_client, jobs, re7s):
    re7s.carousel["2026-07-17_STDA_7"] = 4  # ainda na fila do RE7S
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": TOKEN, "analysis_name": "2026-07-17_STDA_7"})
    assert r.status_code == 409 and "Já existe" in r.json()["detail"]
    re7s.taken.add("2026-07-17_STDA_8")  # analisada / no histórico do RE7S
    r = admin_client.post("/api/postrun/analyses/rename", json={"token": TOKEN, "analysis_name": "2026-07-17_STDA_8"})
    assert r.status_code == 409 and "Já existe" in r.json()["detail"]


def test_a_renamed_name_cannot_be_reused(admin_client, jobs):
    """Mesmo sem o RE7S saber ainda, o nome que uma renomeação deu não pode
    ser dado a outra análise."""
    assert _rename(admin_client, extra="rep").status_code == 200
    r = admin_client.post(
        "/api/postrun/analyses/rename", json={"token": T2, "analysis_name": RENAMED, "job": "Outro"}
    )
    assert r.status_code == 409 and "Já existe" in r.json()["detail"]


def test_rename_info_reports_convention_and_blocking(admin_client, jobs, re7s):
    info = admin_client.get("/api/postrun/analyses/rename-info", params={"token": TOKEN}).json()
    assert info["follows_convention"] is True and info["blocked_reason"] is None
    other = admin_client.get("/api/postrun/analyses/rename-info", params={"token": T3}).json()
    assert other["follows_convention"] is False

    re7s.add_history(NAME, extra="moido")
    re7s.carousel[NAME] = 2
    info = admin_client.get("/api/postrun/analyses/rename-info", params={"token": TOKEN}).json()
    assert info["current_extra"] == "moido" and "carrossel" in info["blocked_reason"]


def test_re7s_down_means_502_never_a_silent_ok(admin_client, jobs, re7s):
    re7s.down = True
    r = _rename(admin_client, extra="rep")
    assert r.status_code == 502 and "RE7S" in r.json()["detail"]
    assert (jobs / TOKEN).exists()
    assert admin_client.get("/api/postrun/analyses/rename-info", params={"token": TOKEN}).status_code == 502


# ---------------------------------------------------------------- modo agente


def test_agent_timeout_records_uncertain_and_listing_reconciles(admin_client, db_engine, monkeypatch, jobs, re7s):
    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "agent_mode", True)

    def timeout(*_a, **_k):
        raise agent_bridge.AgentTimeoutError("sem resposta")

    monkeypatch.setattr(agent_bridge, "move_files", timeout)
    r = _rename(admin_client, extra="rep")
    assert r.status_code == 504
    assert [x["status"] for x in re7s.renames] == ["uncertain"]
    with Session(db_engine) as s:
        record = s.exec(select(AnalysisRename)).one()
        assert record.status == "uncertain"
        # o agente pegou a tarefa a tempo e moveu depois do prazo:
        assert ar.reconcile_uncertain(s, {record.new_token}) == 1
        s.refresh(record)
        assert record.status == "done"
    assert [x["status"] for x in re7s.renames] == ["uncertain", "done"]  # o RE7S fica sabendo do desfecho


def test_uncertain_that_did_not_happen_becomes_failed(db_engine):
    with Session(db_engine) as s:
        rec = AnalysisRename(
            old_token=TOKEN, new_token="x/y/z.B00", old_analysis_name=NAME, new_analysis_name="z",
            old_job=JOB_STD, new_job="x", status="uncertain", renamed_by_id=1,
        )
        s.add(rec)
        s.commit()
        assert ar.reconcile_uncertain(s, {TOKEN}) == 1
        s.refresh(rec)
        assert rec.status == "failed"


def test_old_agent_gets_a_clear_upgrade_message(db_engine, monkeypatch):
    # a ponte mora no pacote do servidor do agente (app/agent_server)
    monkeypatch.setattr(agent_bridge.impl, "_enqueue", lambda *a, **k: 1)
    monkeypatch.setattr(
        agent_bridge.impl,
        "_wait",
        lambda *a, **k: agent_bridge._TaskSnapshot("error", False, None, None, "operação desconhecida: 'move_files'"),
    )
    with Session(db_engine) as s:
        with pytest.raises(agent_bridge.AgentTaskError, match="0.2.0"):
            agent_bridge.move_files(s, "jobs", [{"from": "a", "to": "b"}])

