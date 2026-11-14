"""Conversa com o RE7S pelas rotas internas (docs/PLANO.md, Fase 1, passo 3).

O GeoHorun só LÊ da fila do RE7S — análise ainda no carrossel, nome já usado,
entrada de histórico, amostras da biblioteca, catálogo de padrões — e manda
ao RE7S uma RÉPLICA de cada renomeação/troca de amostra (o RE7S usa essas
renomeações nos contadores, no histórico e na checagem de nome duplicado).

Três "fundos":
- `HttpBackend`: produção (RE7S_INTERNAL_URL + RE7S_INTERNAL_TOKEN), pela
  horun-network. RE7S fora do ar = erro claro (Re7sUnavailable), nunca um
  "liberado" silencioso que deixaria repetir nome;
- `StandaloneBackend`: sem RE7S configurado (desenvolvimento) — a fila está
  vazia, a biblioteca e o catálogo também;
- nos testes, um falso em memória (`set_backend`).

A réplica das renomeações passa por uma fila de saída (`RenameReplica`),
reenviada sozinha (`retry_replicas`, chamado pelo laço do main.py).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Optional, Protocol

from sqlmodel import Field, Session, SQLModel, select

from app.core.config import settings


class Re7sUnavailable(RuntimeError):
    """RE7S configurado mas sem resposta — a rota devolve 502 com a mensagem."""


class RenameReplica(SQLModel, table=True):
    __tablename__ = "re7s_rename_replica"

    id: Optional[int] = Field(default=None, primary_key=True)
    rename_id: int = Field(index=True)
    payload_json: str = "{}"
    state: str = Field(default="pendente", index=True)  # pendente | enviado
    attempts: int = 0
    last_error: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    sent_at: Optional[datetime] = None


class Backend(Protocol):
    def get(self, path: str, params: dict | None = None) -> Any: ...

    def post(self, path: str, body: dict) -> Any: ...


class HttpBackend:
    def __init__(self, url: str, token: str, timeout: float = 8.0):
        self.base = url.rstrip("/") + "/internal/geohorun"
        self.token = token
        self.timeout = timeout

    def _call(self, req: urllib.request.Request) -> Any:
        req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise Re7sUnavailable(f"RE7S respondeu {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise Re7sUnavailable(f"RE7S inacessível: {exc}") from exc

    def get(self, path: str, params: dict | None = None) -> Any:
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._call(urllib.request.Request(f"{self.base}{path}{qs}", method="GET"))

    def post(self, path: str, body: dict) -> Any:
        req = urllib.request.Request(
            f"{self.base}{path}", data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json"},
        )
        return self._call(req)


class StandaloneBackend:
    """Sem RE7S: fila vazia, biblioteca vazia, catálogo vazio; réplicas ficam na fila."""

    def get(self, path: str, params: dict | None = None) -> Any:
        if path.startswith("/analysis-name/"):
            return {"in_carousel": None, "taken": False, "history": None}
        if path in ("/library/groups", "/library/samples", "/standards"):
            return []
        return None

    def post(self, path: str, body: dict) -> Any:
        raise Re7sUnavailable("RE7S não configurado (RE7S_INTERNAL_URL / RE7S_INTERNAL_TOKEN)")


_backend: Backend | None = None


def backend() -> Backend:
    global _backend
    if _backend is None:
        _backend = (
            HttpBackend(settings.re7s_url, settings.re7s_token)
            if settings.re7s_url and settings.re7s_token
            else StandaloneBackend()
        )
    return _backend


def set_backend(b: Backend | None) -> None:
    """Testes trocam o RE7S por um falso; None volta ao padrão da configuração."""
    global _backend
    _backend = b


def configured() -> bool:
    return not isinstance(backend(), StandaloneBackend)


def _ns(data: dict | None) -> SimpleNamespace | None:
    return SimpleNamespace(**data) if data else None


# ------------------------------------------------------------- leituras

def analysis_name_info(name: str) -> dict:
    """{"in_carousel": posição|None, "taken": bool, "history": {"id","extra"}|None}"""
    return backend().get(f"/analysis-name/{urllib.parse.quote(name, safe='')}") or {
        "in_carousel": None, "taken": False, "history": None,
    }


def waiting_on_carousel(name: str) -> SimpleNamespace | None:
    pos = analysis_name_info(name).get("in_carousel")
    return SimpleNamespace(crucible=pos) if pos is not None else None


def name_taken_in_queue(name: str) -> bool:
    return bool(analysis_name_info(name).get("taken"))


def history_entry_by_name(name: str) -> SimpleNamespace | None:
    return _ns(analysis_name_info(name).get("history"))


def history_entry_by_id(entry_id: int) -> SimpleNamespace | None:
    return _ns(backend().get(f"/history/{int(entry_id)}"))


def library_sample(sample_id: int) -> SimpleNamespace | None:
    return _ns(backend().get(f"/library/samples/{int(sample_id)}"))


def library_groups() -> list[dict]:
    return backend().get("/library/groups") or []


def library_samples(group_id: int | None = None) -> list[dict]:
    return backend().get("/library/samples", {"group_id": group_id} if group_id is not None else None) or []


def standards() -> list[dict]:
    """[{"id","name","kind",...}] — catálogo de padrões do RE7S."""
    return backend().get("/standards") or []


def standard(standard_id: int) -> SimpleNamespace | None:
    """{"id","name","reference_values": {parâmetro: valor certificado}}"""
    return _ns(backend().get(f"/standards/{int(standard_id)}"))


# ------------------------------------------------------- réplica das renomeações

def _payload(session: Session, record) -> dict:
    from app.db.models import User

    def iso(dt):
        if dt is None:
            return None
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()

    user = session.get(User, record.renamed_by_id) if record.renamed_by_id else None
    return {
        "id": record.id, "old_token": record.old_token, "new_token": record.new_token,
        "old_analysis_name": record.old_analysis_name, "new_analysis_name": record.new_analysis_name,
        "old_job": record.old_job, "new_job": record.new_job, "history_entry_id": record.history_entry_id,
        "old_sample": record.old_sample, "new_sample": record.new_sample,
        "new_library_sample_id": record.new_library_sample_id, "status": record.status, "error": record.error,
        "created_at": iso(record.created_at), "completed_at": iso(record.completed_at),
        # quem fez (identidade do Core) — o RE7S acha a conta correspondente
        "renamed_by": user.username if user else None,
        "renamed_by_core_user_id": user.core_user_id if user else None,
    }


def replicate_rename(session: Session, record) -> None:
    """Põe a renomeação (estado atual) na fila para o RE7S e tenta enviar já.
    Chamar depois de cada commit que muda um AnalysisRename."""
    item = RenameReplica(rename_id=record.id, payload_json=json.dumps(_payload(session, record)))
    session.add(item)
    session.commit()
    _try_send(session, item)


def _try_send(session: Session, item: RenameReplica) -> bool:
    item.attempts += 1
    try:
        backend().post("/renames", json.loads(item.payload_json))
    except Re7sUnavailable as exc:
        item.last_error = str(exc)[:300]
        session.add(item)
        session.commit()
        return False
    item.state = "enviado"
    item.sent_at = datetime.now(timezone.utc)
    item.last_error = ""
    session.add(item)
    session.commit()
    return True


def retry_replicas(session: Session) -> dict:
    pending = session.exec(
        select(RenameReplica).where(RenameReplica.state == "pendente").order_by(RenameReplica.id)
    ).all()
    sent = sum(1 for item in pending if _try_send(session, item))
    return {"tried": len(pending), "sent": sent}
