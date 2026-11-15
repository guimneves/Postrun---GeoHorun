"""PostRun · GeoHorun — pós-corrida do Rock-Eval 7S (docs/PLANO.md).

Fase 1: as rotas do PostRun que estavam no RE7S, sob /api. As rotas comuns de
todo PostRun (app/postrun_core: /api/postrun/runs, /scan, /batch...) usam os
mesmos caminhos que o PostRun do RE7S já usava — entram quando a publicação
no Resultados for ligada (Fase 3), num prefixo próprio.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlmodel import Session

from app.api import (
    routes_analysis_rename,
    routes_postrun,
    routes_postrun_curves,
    routes_postrun_deconv,
    routes_postrun_report,
    routes_postrun_study,
    routes_postrun_compare,
    routes_postrun_runs,
    routes_postrun_validation,
    routes_postrun_workflow,
    routes_session,
)
from app.core.config import settings
from app.db.session import create_db_and_tables, engine
from app.modules import re7s_link

log = logging.getLogger(__name__)


def _start_replica_worker() -> threading.Event:
    """Reenvia ao RE7S as réplicas de renomeação que ficaram pendentes."""
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(settings.outbox_retry_seconds):
            try:
                with Session(engine) as session:
                    re7s_link.retry_replicas(session)
            except Exception:  # noqa: BLE001 — o laço nunca pode morrer
                log.exception("falha ao reenviar réplicas ao RE7S")

    threading.Thread(target=loop, name="geohorun-re7s-replica", daemon=True).start()
    return stop


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    create_db_and_tables()
    stop = _start_replica_worker()
    yield
    stop.set()


app = FastAPI(title="Horun · PostRun · GeoHorun", version="0.1.0", lifespan=lifespan)

for _router in (
    routes_postrun.router,
    routes_postrun_curves.router,
    routes_postrun_deconv.router,
    routes_postrun_report.router,
    routes_postrun_study.router,
    routes_postrun_compare.router,
    routes_postrun_runs.router,
    routes_postrun_validation.router,
    routes_postrun_workflow.router,
    routes_analysis_rename.router,
    routes_session.router,
):
    app.include_router(_router, prefix="/api")

try:  # servidor do Agente (copiado por Agent-Horun/scripts/vendor_server.py)
    from app.api.routes_agent import router as agent_router
except ImportError:  # sem a cópia: só funciona com POSTRUN_DATA_DIR (desenvolvimento)
    agent_router = None
if agent_router is not None:
    app.include_router(agent_router, prefix="/api")


@app.get("/health")
def health():
    # Sem autenticação — usado pelo Horun Core para o dashboard de status.
    return {"status": "ok", "module": "geohorun"}
