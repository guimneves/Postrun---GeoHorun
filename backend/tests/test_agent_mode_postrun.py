"""Modo agente (`POSTRUN_AGENT_MODE=true`): os `.B00` passam pela ponte do
Agente Horun (`app/modules/agent_bridge.py` → pacote `app/agent_server/`).

Duas camadas (vindo da parte PostRun de test_agent_mode_file_migrations.py
do RE7S):
- cada rota chama a ponte com o `root`/token/prazo certos e trata "não
  encontrado" — `agent_bridge.read_text`/`write_text`/`list_files` trocados
  por um sistema de arquivos falso em memória;
- ponta a ponta com a ponte de verdade: um "agente" em linha de execução
  própria resolve as tarefas (`AgentTask`) direto no banco, lendo e movendo
  arquivos de uma pasta local — o mesmo caminho que o agente real faz pelas
  rotas /agent/*.
"""

from __future__ import annotations

import base64
import fnmatch
import json
import threading

import pytest
from sqlmodel import Session, select

from app.core import config as config_module
from app.modules import agent_bridge
from tests.b00_factory import JOB_STD, SPECS, T1, T2



@pytest.fixture()
def agent_mode(monkeypatch):
    monkeypatch.setattr(config_module.settings, "agent_mode", True)


class _FakeAgentFs:
    """Sistema de arquivos falso, em memória, no lugar do agente — grava/lê
    por (root, path), como o agente faria."""

    def __init__(self):
        self.files: dict[tuple[str, str], str] = {}
        self.read_calls: list[tuple[str, str]] = []
        # arquivo cujo agente nunca responde a tempo (rede lenta, agente sob carga)
        self.slow_tokens: set[tuple[str, str]] = set()
        self.timeouts_seen: list[float | None] = []
        self.list_timeouts_seen: list[float | None] = []
        self.globs_seen: list[str] = []

    def read_text(self, session, root, path, *, timeout=None):
        self.read_calls.append((root, path))
        self.timeouts_seen.append(timeout)
        key = (root, path)
        if key in self.slow_tokens:
            raise agent_bridge.AgentTimeoutError(f"o agente não respondeu em {timeout}s")
        if key not in self.files:
            raise agent_bridge.AgentTaskError(f"arquivo não encontrado: {path!r}")
        return self.files[key]

    def write_text(self, session, root, path, content, *, timeout=None):
        self.files[(root, path)] = content

    def list_files(self, session, root, glob, *, timeout=None):
        self.list_timeouts_seen.append(timeout)
        self.globs_seen.append(glob)
        ext = glob.rsplit(".", 1)[-1]
        return sorted(p for (r, p) in self.files if r == root and p.endswith(f".{ext}"))


@pytest.fixture()
def fake_fs(monkeypatch):
    fs = _FakeAgentFs()
    monkeypatch.setattr(agent_bridge, "read_text", fs.read_text)
    monkeypatch.setattr(agent_bridge, "write_text", fs.write_text)
    monkeypatch.setattr(agent_bridge, "list_files", fs.list_files)
    return fs


@pytest.fixture()
def b00(b00_source):
    def load(token: str = T1) -> str:
        return (b00_source / token).read_text(encoding="utf-8", errors="replace")

    return load


# ------------------------------------------------------------------ rotas → ponte


def test_postrun_list_and_detail_via_agent_mode(admin_client, agent_mode, fake_fs, b00):
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()

    r = admin_client.get("/api/postrun/analyses")
    assert r.status_code == 200, r.text
    assert {a["token"] for a in r.json()} == {T1}

    r2 = admin_client.get("/api/postrun/analyses/detail", params={"token": T1})
    assert r2.status_code == 200, r2.text
    assert r2.json()["sample"] == "STDA"
    assert len(r2.json()["pyro"]["idx"]) == SPECS[T1].pyro.n_points  # mesmo valor do modo local


def test_postrun_jobs_then_one_job_via_agent_mode(admin_client, agent_mode, fake_fs, b00):
    """Primeiro os jobs (só nomes de arquivo, nenhum .B00 lido), depois só o
    job escolhido — o agente varre só aquela pasta."""
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()
    fake_fs.files[(agent_bridge.ROOT_JOBS, "Outro/BULK ROCK/2026-08-01_X_1.B00")] = b00()

    jobs = admin_client.get("/api/postrun/jobs").json()
    assert [(j["name"], j["analyses"], j["last_date"]) for j in jobs] == [
        ("Outro", 1, "2026-08-01"), (JOB_STD, 1, "2026-07-17"),
    ]
    assert fake_fs.read_calls == []

    r = admin_client.get("/api/postrun/analyses", params={"job": JOB_STD})
    assert [a["token"] for a in r.json()] == [T1]
    assert fake_fs.globs_seen[-1] == f"{JOB_STD}/**/*.B00"
    assert fake_fs.read_calls == [(agent_bridge.ROOT_JOBS, T1)]  # só o do job escolhido


def test_postrun_jobs_keeps_the_last_good_list_when_the_agent_is_slow(admin_client, agent_mode, fake_fs, b00,
                                                                      monkeypatch):
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()
    first = admin_client.get("/api/postrun/jobs").json()

    def broken(*_a, **_k):
        raise agent_bridge.AgentTimeoutError("sem resposta")

    monkeypatch.setattr(agent_bridge, "list_files", broken)
    r = admin_client.get("/api/postrun/jobs")
    assert r.status_code == 200 and r.json() == first


def test_postrun_job_with_glob_characters_lists_everything_and_filters(admin_client, agent_mode, fake_fs, b00):
    token = "Lote [A]/BULK ROCK/2026-08-01_X_1.B00"
    fake_fs.files[(agent_bridge.ROOT_JOBS, token)] = b00()
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()
    r = admin_client.get("/api/postrun/analyses", params={"job": "Lote [A]"})
    assert [a["token"] for a in r.json()] == [token]
    assert fake_fs.globs_seen[-1] == "**/*.B00"


def test_postrun_detail_404_when_not_in_agent_fs(admin_client, agent_mode, fake_fs):
    r = admin_client.get("/api/postrun/analyses/detail", params={"token": T1})
    assert r.status_code == 404, r.text


def test_postrun_sparkline_via_agent_mode(admin_client, agent_mode, fake_fs, b00):
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()

    r = admin_client.post("/api/postrun/analyses/sparklines", json={"tokens": [T1]})
    assert r.status_code == 200, r.text
    ok = r.json()[0]
    assert ok["error"] is None
    assert len(ok["values"]) == 48


def test_postrun_b00_read_via_agent_is_cached_after_first_hit(admin_client, agent_mode, fake_fs, b00):
    """Um `.B00` nunca muda depois de pronto: a segunda leitura do mesmo token
    não chama o agente de novo (sem cache, listar estourava o prazo do proxy
    do Core com dezenas de análises)."""
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()

    r1 = admin_client.get("/api/postrun/analyses/detail", params={"token": T1})
    assert r1.status_code == 200, r1.text
    assert fake_fs.read_calls == [(agent_bridge.ROOT_JOBS, T1)]

    r2 = admin_client.get("/api/postrun/analyses/detail", params={"token": T1})
    assert r2.status_code == 200, r2.text
    assert r2.json() == r1.json()
    assert fake_fs.read_calls == [(agent_bridge.ROOT_JOBS, T1)]

    # /analyses (lista) e /sparklines também passam pelo mesmo cache
    assert admin_client.get("/api/postrun/analyses").status_code == 200
    assert admin_client.post("/api/postrun/analyses/sparklines", json={"tokens": [T1]}).status_code == 200
    assert fake_fs.read_calls == [(agent_bridge.ROOT_JOBS, T1)]


def test_postrun_list_skips_slow_file_instead_of_failing_whole_list(admin_client, agent_mode, fake_fs, b00):
    """Um único `.B00` lento (estourando o prazo individual) não derruba
    `/api/postrun/analyses` inteira — é pulado e não entra no cache."""
    fast_token = f"{JOB_STD}/BULK ROCK/outra-rapida.B00"
    fake_fs.files[(agent_bridge.ROOT_JOBS, fast_token)] = b00()
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()
    fake_fs.slow_tokens.add((agent_bridge.ROOT_JOBS, T1))

    r = admin_client.get("/api/postrun/analyses")
    assert r.status_code == 200, r.text
    assert {a["token"] for a in r.json()} == {fast_token}

    r2 = admin_client.get(f"/api/postrun/analyses/detail?token={T1}")
    assert r2.status_code == 502, r2.text  # ainda "lento", timeout padrão (sem limite curto)


def test_postrun_list_and_sparklines_use_a_short_timeout_per_file_in_agent_mode(admin_client, agent_mode, fake_fs,
                                                                                b00):
    """Rotas que varrem VÁRIOS tokens usam um prazo curto por arquivo (e a
    listagem dos nomes, o seu); uma leitura avulsa usa o padrão."""
    token_a = f"{JOB_STD}/BULK ROCK/a.B00"
    token_b = f"{JOB_STD}/BULK ROCK/b.B00"
    token_c = f"{JOB_STD}/BULK ROCK/c.B00"
    for token in (token_a, token_b, token_c):
        fake_fs.files[(agent_bridge.ROOT_JOBS, token)] = b00()

    r = admin_client.get("/api/postrun/analyses")
    assert r.status_code == 200, r.text
    assert fake_fs.list_timeouts_seen == [8.0]
    assert fake_fs.timeouts_seen == [5.0, 5.0, 5.0]

    fake_fs.timeouts_seen.clear()
    assert admin_client.post("/api/postrun/analyses/sparklines", json={"tokens": [token_a]}).status_code == 200
    assert fake_fs.timeouts_seen == []  # já em cache

    assert admin_client.get("/api/postrun/analyses/detail", params={"token": token_c}).status_code == 200
    assert fake_fs.timeouts_seen == []

    token_d = f"{JOB_STD}/BULK ROCK/d.B00"
    fake_fs.files[(agent_bridge.ROOT_JOBS, token_d)] = b00()
    r4 = admin_client.get("/api/postrun/analyses/detail", params={"token": token_d})
    assert r4.status_code == 200, r4.text
    assert fake_fs.timeouts_seen == [None]


def test_postrun_create_region_404_for_unknown_token_via_agent_mode(admin_client, agent_mode, fake_fs):
    r = admin_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "x", "start_idx": 180, "end_idx": 626,
    })
    assert r.status_code == 404, r.text


def test_standard_ini_is_read_from_the_data_root(admin_client, agent_mode, fake_fs, b00, re7s):
    """O standard.ini vem da pasta `data` do agente (não da `jobs`)."""
    fake_fs.files[(agent_bridge.ROOT_JOBS, T1)] = b00()
    fake_fs.files[(agent_bridge.ROOT_DATA, "standard.ini")] = '[STD1]\nstdName = "STDA"\nstdTmax = 441.0\nstdS2 = 11.0\n'
    sid = re7s.add_standard("STDA", {"S2": 10.0, "Tmax": 440.0})
    body = admin_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "pyro:FID", "standard_id": sid,
    }).json()
    assert body["reference_source"] == "standard.ini" and body["tmax_certified"] == 441.0
    assert (agent_bridge.ROOT_DATA, "standard.ini") in fake_fs.read_calls


# ------------------------------------------------------- ponta a ponta (ponte real)


class _ThreadAgent:
    """Faz o papel do Agente Horun: pega as tarefas pendentes no banco e
    resolve com os arquivos de `base` (root "jobs")."""

    def __init__(self, engine, base):
        self.engine, self.base = engine, base
        self.ops: list[tuple[str, str]] = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _resolve(self, task) -> None:
        from app.agent_server.models import utcnow

        self.ops.append((task.op, task.root))
        task.status, task.result_ok, task.completed_at = "done", True, utcnow()
        if task.root != agent_bridge.ROOT_JOBS:
            task.result_ok, task.result_error, task.result_code = False, "arquivo não encontrado", "not_found"
        elif task.op == "list_files":
            paths = [p.relative_to(self.base).as_posix() for p in self.base.rglob("*") if p.is_file()]
            task.result_paths = json.dumps(sorted(p for p in paths if fnmatch.fnmatch(p, task.glob.replace("**/", "*"))))
        elif task.op == "read_file":
            path = self.base / task.path
            if path.is_file():
                task.result_content_base64 = base64.b64encode(path.read_bytes()).decode("ascii")
            else:
                task.result_ok, task.result_error, task.result_code = False, "arquivo não encontrado", "not_found"
        elif task.op == "move_files":
            moves = json.loads(base64.b64decode(task.content_base64))["moves"]
            done = []
            for m in moves:
                src, dst = self.base / m["from"], self.base / m["to"]
                if src.is_file():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    src.rename(dst)
                    done.append(m["to"])
            task.result_paths = json.dumps(done)
        else:
            task.result_ok, task.result_error = False, f"operação desconhecida: {task.op!r}"

    def _loop(self) -> None:
        from app.agent_server.models import AgentTask

        while not self.stop.wait(0.02):
            with Session(self.engine) as s:
                for task in s.exec(select(AgentTask).where(AgentTask.status == "pending")).all():
                    self._resolve(task)
                    s.add(task)
                s.commit()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(5)


def test_end_to_end_through_the_vendored_agent_bridge(admin_client, db_engine, jobs, monkeypatch, re7s):
    # depois da fixture `jobs` (que liga o modo disco local)
    monkeypatch.setattr(config_module.settings, "agent_mode", True)
    monkeypatch.setattr(config_module.settings, "agent_task_timeout_seconds", 5.0)
    with _ThreadAgent(db_engine, jobs) as agent:
        listed = admin_client.get("/api/postrun/analyses", params={"job": JOB_STD})
        assert listed.status_code == 200, listed.text
        assert {a["token"] for a in listed.json()} == {T1, T2}

        detail = admin_client.get("/api/postrun/analyses/detail", params={"token": T1})
        assert detail.status_code == 200 and detail.json()["sample"] == "STDA"
        assert admin_client.get("/api/postrun/analyses/detail",
                                params={"token": f"{JOB_STD}/BULK ROCK/nope.B00"}).status_code == 404

        r = admin_client.post("/api/postrun/analyses/rename", json={"token": T1, "extra": "rep"})
        assert r.status_code == 200, r.text
        assert r.json()["moved"] == [f"{JOB_STD}/BULK ROCK/2026-07-17_STDA_rep_1.B00"]
    assert (jobs / f"{JOB_STD}/BULK ROCK/2026-07-17_STDA_rep_1.B00").is_file() and not (jobs / T1).exists()
    assert {op for op, _ in agent.ops} == {"list_files", "read_file", "move_files"}
    assert {root for _, root in agent.ops} == {agent_bridge.ROOT_JOBS}
    assert re7s.renames[-1]["status"] == "done"
