"""Configuração do PostRun · GeoHorun, lida de variáveis de ambiente.

Desenvolvimento: sem nada configurado, lê os `.B00` sintéticos de
`sample_data/` e guarda as publicações na fila (sem Resultados), sem RE7S.

Produção (atrás do Core):
- MODULE_DATABASE_URL — Postgres do módulo;
- POSTRUN_AGENT_MODE=true — arquivos pelo Agente Horun do PC do Rock-Eval,
  pastas `jobs` (RE7raw-data, `.B00`; leitura/movimento/escrita) e `data`
  (standard.ini) liberadas no config.json dele para este módulo;
- RE7S_INTERNAL_URL=http://re7s-backend:8000 e RE7S_INTERNAL_TOKEN — rotas
  internas do RE7S (fila, histórico, biblioteca, padrões; réplica das
  renomeações). Vazio = sem RE7S (renomear consulta só o próprio banco);
- POSTRUN_RESULTADOS_URL / POSTRUN_RESULTADOS_TOKEN — envio ao Resultados.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


class Settings:
    database_url: str = os.environ.get("MODULE_DATABASE_URL", "sqlite:///./geohorun_dev.db")
    # arquivos brutos: Agente (produção) ou uma pasta local (desenvolvimento)
    agent_mode: bool = os.environ.get("POSTRUN_AGENT_MODE", "false").lower() == "true"
    agent_task_timeout_seconds: float = float(os.environ.get("POSTRUN_AGENT_TASK_TIMEOUT", "30"))
    # pasta dos .B00 em desenvolvimento (= RE7raw-data do equipamento)
    jobs_dir: Path = Path(os.environ.get("POSTRUN_DATA_DIR", str(BACKEND_DIR / "sample_data")))
    standard_ini_file: str = os.environ.get("POSTRUN_STANDARD_INI", "")
    # rotas internas do RE7S
    re7s_url: str = os.environ.get("RE7S_INTERNAL_URL", "")
    re7s_token: str = os.environ.get("RE7S_INTERNAL_TOKEN", "")
    # envio ao Resultados — vazio = publicações ficam na fila
    resultados_url: str = os.environ.get("POSTRUN_RESULTADOS_URL", "")
    resultados_token: str = os.environ.get("POSTRUN_RESULTADOS_TOKEN", "")
    outbox_retry_seconds: float = float(os.environ.get("POSTRUN_OUTBOX_RETRY_SECONDS", "300"))
    # permissões por nível do Core (1 administrador máximo … 5 IC)
    validate_max_level: int = _int("POSTRUN_VALIDATE_MAX_LEVEL", 4)
    unpublish_max_level: int = _int("POSTRUN_UNPUBLISH_MAX_LEVEL", 2)
    # quem é "admin" no GeoHorun (renomear/mover/trocar amostra, apagar o que é dos outros)
    admin_max_level: int = _int("GEOHORUN_ADMIN_MAX_LEVEL", 2)

    @property
    def standard_ini_path(self) -> Path:
        return Path(self.standard_ini_file) if self.standard_ini_file else self.jobs_dir / "standard.ini"


settings = Settings()
