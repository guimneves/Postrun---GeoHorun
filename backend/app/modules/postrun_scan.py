"""Leitura das análises de um job em segundo plano (aba PostRun, pedido do
usuário de 16/10/2026: "o tempo para verificar está curto — quero um botão
de verificar novamente, que leia em segundo plano, para eu começar a
análise enquanto o agente lê").

Antes, `GET /postrun/analyses` lia os `.B00` pelo agente dentro da própria
requisição, com orçamento de ~22 s (o proxy do Core corta em 30 s): com a
rede lenta, o que não coubesse simplesmente sumia da lista. Agora:

- `start(job, worker)` dispara uma *thread* que lista os `.B00` do job e
  lê (e guarda no `PostrunB00Cache`) um por um, sem pressa — prazos longos,
  uma nova tentativa no fim para os que falharam;
- `GET /postrun/analyses` passa a montar a lista só com o que já está no
  cache (instantâneo), e a tela consulta `GET /postrun/scan` para mostrar
  o progresso e recarregar a lista conforme os arquivos chegam;
- "Verificar novamente" = `start` de novo: lista outra vez (pega análises
  novas) e lê só o que ainda não está no cache.

O estado fica em memória (um processo de backend); se o servidor
reiniciar, a próxima visita começa uma leitura nova — o cache em banco
continua valendo.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable


@dataclass
class ScanState:
    job: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    state: str = "running"  # running | done | error
    # None = ainda listando os arquivos no equipamento
    tokens: list[str] | None = None
    total: int = 0
    read: int = 0
    failed: int = 0
    error: str | None = None
    finished_at: datetime | None = None
    # renomeação/movimentação depois da listagem: a lista de tokens não
    # vale mais (ver `invalidate_all`)
    stale: bool = False
    _thread: threading.Thread | None = field(default=None, repr=False)


_lock = threading.Lock()
_scans: dict[str, ScanState] = {}


def get(job: str) -> ScanState | None:
    with _lock:
        return _scans.get(job)


def start(job: str, worker: Callable[[ScanState], None], *, background: bool = True) -> ScanState:
    """Começa (ou devolve, se já está rodando) a leitura do job. Sem
    `background`, roda na hora — modo local (disco), onde tudo é
    instantâneo."""
    with _lock:
        current = _scans.get(job)
        if current is not None and current.state == "running" and not current.stale:
            return current
        state = ScanState(job=job)
        _scans[job] = state
    if not background:
        _run(state, worker)
        return state
    thread = threading.Thread(target=_run, args=(state, worker), daemon=True, name=f"postrun-scan:{job}")
    state._thread = thread
    thread.start()
    return state


def _run(state: ScanState, worker: Callable[[ScanState], None]) -> None:
    try:
        worker(state)
        state.state = "done"
    except Exception as exc:  # noqa: BLE001 — qualquer falha vira mensagem na tela
        state.error = str(exc) or exc.__class__.__name__
        state.state = "error"
    finally:
        state.finished_at = datetime.now(timezone.utc)


def invalidate_all() -> None:
    """Uma análise foi renomeada/movida: as listas de tokens guardadas não
    valem mais. A próxima visita (ou "Verificar novamente") lista de novo."""
    with _lock:
        for job, state in list(_scans.items()):
            if state.state == "running":
                state.stale = True
            else:
                del _scans[job]


def wait(job: str, timeout: float = 10.0) -> ScanState | None:
    """Para os testes: espera a leitura do job terminar."""
    state = get(job)
    if state is not None and state._thread is not None:
        state._thread.join(timeout)
    return state


def reset() -> None:
    """Para os testes: esquece todas as leituras."""
    with _lock:
        _scans.clear()
