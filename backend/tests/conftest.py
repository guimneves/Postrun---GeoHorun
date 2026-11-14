"""Cada teste roda num banco e numa pasta de dados temporários — definidos
ANTES de importar o app (a configuração é lida na importação).

Quem pede: cabeçalhos de identidade do Core (X-Horun-*), sem login local —
admin = nível 2 (coordenação), usuários comuns = níveis 3/4, cada um com o
seu id do Core. O RE7S (fila, histórico, biblioteca, padrões, réplica das
renomeações) é um falso em memória (`FakeRe7s`), instalado em todo teste.
Os `.B00` são sintéticos (tests/b00_factory.py), gerados uma vez por sessão
e copiados para uma pasta temporária por teste."""

import os
import shutil
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="postrun_test_"))
os.environ["MODULE_DATABASE_URL"] = f"sqlite:///{(_TMP / 'test.db').as_posix()}"
os.environ["POSTRUN_DATA_DIR"] = str(_TMP / "data")
os.environ["POSTRUN_AGENT_MODE"] = "false"
for _var in ("POSTRUN_RESULTADOS_URL", "HORUN_DEV_MODE", "RE7S_INTERNAL_URL", "RE7S_INTERNAL_TOKEN",
             "POSTRUN_STANDARD_INI"):
    os.environ.pop(_var, None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from tests import b00_factory  # noqa: E402

ADMIN = {"user_id": "1", "user": "admin", "level": 2}
USER = {"user_id": "2", "user": "usuario1", "level": 3}
SECOND_USER = {"user_id": "3", "user": "usuario2", "level": 4}


def headers(level: int = 3, user: str = "ana", user_id: str = "7") -> dict:
    return {"X-Horun-User-Id": user_id, "X-Horun-User": user, "X-Horun-Role": "user", "X-Horun-Level": str(level)}


# ------------------------------------------------------------------ RE7S falso


class FakeRe7s:
    """As rotas internas do RE7S (`/internal/geohorun/...`) em memória.
    `down = True` simula o RE7S fora do ar (toda chamada falha);
    `posts_down = True`, só o recebimento das réplicas falhando."""

    def __init__(self):
        self.down = False
        self.posts_down = False
        self.carousel: dict[str, int] = {}  # nome da análise -> posição no carrossel
        self.taken: set[str] = set()  # nomes já usados na fila/histórico
        self.history: dict[int, dict] = {}  # id -> {"id", "extra", "analysis_name"}
        self.library: dict[int, dict] = {}  # id -> {"id", "code", "name"}
        self.groups: list[dict] = []
        self.standards_: dict[int, dict] = {}  # id -> {"id", "name", "kind", "reference_values"}
        self.renames: list[dict] = []  # réplicas recebidas
        self.calls: list[tuple[str, str]] = []

    def _check(self):
        from app.modules.re7s_link import Re7sUnavailable

        if self.down:
            raise Re7sUnavailable("RE7S inacessível (teste)")

    # -- semeadura
    def add_library_sample(self, code: str, name: str | None = None) -> int:
        sid = len(self.library) + 1
        self.library[sid] = {"id": sid, "code": code, "name": name or code}
        return sid

    def add_history(self, analysis_name: str, extra: str = "") -> int:
        hid = len(self.history) + 101
        self.history[hid] = {"id": hid, "extra": extra, "analysis_name": analysis_name}
        self.taken.add(analysis_name)
        return hid

    def add_standard(self, name: str, reference_values: dict[str, float], kind: str = "verification") -> int:
        sid = len(self.standards_) + 1
        self.standards_[sid] = {"id": sid, "name": name, "kind": kind, "reference_values": dict(reference_values)}
        return sid

    # -- interface do backend
    def get(self, path: str, params: dict | None = None):
        from urllib.parse import unquote

        self.calls.append(("GET", path))
        self._check()
        if path.startswith("/analysis-name/"):
            name = unquote(path[len("/analysis-name/"):])
            hist = next((h for h in self.history.values() if h["analysis_name"] == name), None)
            return {
                "in_carousel": self.carousel.get(name),
                "taken": name in self.taken or name in self.carousel,
                "history": {"id": hist["id"], "extra": hist["extra"]} if hist else None,
            }
        if path.startswith("/history/"):
            h = self.history.get(int(path.rsplit("/", 1)[1]))
            return {"id": h["id"], "extra": h["extra"]} if h else None
        if path == "/library/groups":
            return list(self.groups)
        if path == "/library/samples":
            return list(self.library.values())
        if path.startswith("/library/samples/"):
            return self.library.get(int(path.rsplit("/", 1)[1]))
        if path == "/standards":
            return [{k: v for k, v in s.items() if k != "reference_values"} for s in self.standards_.values()]
        if path.startswith("/standards/"):
            return self.standards_.get(int(path.rsplit("/", 1)[1]))
        return None

    def post(self, path: str, body: dict):
        self.calls.append(("POST", path))
        self._check()
        if self.posts_down:
            from app.modules.re7s_link import Re7sUnavailable

            raise Re7sUnavailable("RE7S respondeu 503: reiniciando (teste)")
        if path == "/renames":
            self.renames.append(body)
            return {"ok": True}
        return None


@pytest.fixture(autouse=True)
def re7s():
    from app.api import routes_postrun
    from app.modules import postrun_scan, re7s_link

    fake = FakeRe7s()
    re7s_link.set_backend(fake)
    postrun_scan.reset()
    routes_postrun._sync_failed_at.clear()
    routes_postrun._last_jobs = None
    yield fake
    re7s_link.set_backend(None)
    postrun_scan.reset()


# ------------------------------------------------------------------ banco e clientes


@pytest.fixture()
def db_engine():
    from app.db.session import create_db_and_tables, engine
    from app.main import app  # noqa: F401 — registra todos os modelos

    create_db_and_tables()
    SQLModel.metadata.drop_all(engine)
    create_db_and_tables()
    return engine


def _client(identity: dict) -> TestClient:
    from app.main import app

    return TestClient(app, headers=headers(identity["level"], identity["user"], identity["user_id"]))


@pytest.fixture()
def admin_client(db_engine):
    return _client(ADMIN)


@pytest.fixture()
def user_client(db_engine):
    return _client(USER)


@pytest.fixture()
def second_user_client(db_engine):
    return _client(SECOND_USER)


# ------------------------------------------------------------------ .B00 sintéticos


@pytest.fixture(scope="session")
def b00_source(tmp_path_factory) -> Path:
    return b00_factory.build_standard_tree(tmp_path_factory.mktemp("b00_source"))


@pytest.fixture()
def jobs(b00_source, tmp_path, monkeypatch) -> Path:
    """Cópia do conjunto sintético como RE7raw-data, modo disco local."""
    from app.core import config as config_module

    copy = tmp_path / "RE7raw-data"
    shutil.copytree(b00_source, copy)
    monkeypatch.setattr(config_module.settings, "jobs_dir", copy)
    monkeypatch.setattr(config_module.settings, "agent_mode", False)
    return copy
