"""Ponte entre o backend do RE7S e o Agente Horun instalado no PC do
equipamento — usada só quando `settings.agent_mode` está ligado
(`RE7S_AGENT_MODE=true`). Desligado (Fase 1), o resto do backend continua
lendo/escrevendo disco local direto.

A implementação é o pacote único do servidor do agente, o MESMO para todo
módulo (cópia em `app/agent_server/`, gerada por
`Agent-Horun/scripts/vendor_server.py` — não edite lá). Aqui ficam só o que
é do RE7S: os nomes das pastas (`ROOT_*`) e o tempo de espera, lido de
`RE7S_AGENT_TASK_TIMEOUT`.

Os nomes de `root` precisam bater com as chaves de `roots` no `config.json`
da instalação do agente no PC do Rock-Eval:
    data         TABSAMPLE.txt, savecycle, standard.ini, filas  (read-write)
    jobs         RE7raw-data — .B00 brutos (PostRun, renomear)  (read-move)
    mtl_results  pendrive da balança Mettler Toledo             (read)
"""

from __future__ import annotations

from app.agent_server import bridge as impl
from app.agent_server.bridge import (  # noqa: F401 — reexportados para o resto do RE7S e testes
    AgentOfflineError,
    AgentTaskError,
    AgentTimeoutError,
    AgentTooOldError,
    _enqueue,
    _expire,
    _poll_once,
    _TaskSnapshot,
    _wait,
    file_not_found,
    list_files,
    move_files,
    read_bytes,
    read_text,
    write_bytes,
    write_text,
)
from app.agent_server.settings import settings as agent_settings
from app.core.config import settings

ROOT_DATA = "data"
ROOT_JOBS = "jobs"
ROOT_MTL_RESULTS = "mtl_results"

# o tempo de espera vem da configuração do RE7S, lido na hora de cada chamada
agent_settings.timeout_provider = lambda: settings.agent_task_timeout_seconds
