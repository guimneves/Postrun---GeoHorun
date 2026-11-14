"""Log de ações do backend em texto simples (pedido do usuário: um .txt
para facilitar o diagnóstico de problemas de sincronização com o
equipamento). Fica em `backend/logs/horun_actions.log`, fora do
`RE7S_DATA_DIR` de propósito — assim continua registrando mesmo se o
caminho do equipamento estiver errado ou inacessível, que é exatamente o
tipo de problema que ele serve para diagnosticar.

Rotaciona em 5 MB (mantém 3 arquivos antigos) para nunca crescer sem
limite num PC que fica ligado por meses."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parents[2] / "logs" / "horun_actions.log"

_logger = logging.getLogger("horun.actions")
_logger.setLevel(logging.INFO)

if not _logger.handlers:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _handler = RotatingFileHandler(LOG_PATH, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    _handler.setFormatter(logging.Formatter("%(asctime)s\t%(message)s"))
    _logger.addHandler(_handler)
    _logger.propagate = False


def log_action(event: str, **details: object) -> None:
    """Grava uma linha no log: `evento  chave=valor  chave=valor ...`."""
    detail_str = "  ".join(f"{k}={v!r}" for k, v in details.items())
    _logger.info(f"{event}\t{detail_str}" if detail_str else event)
