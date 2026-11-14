"""Migração dos dados do PostRun do RE7S para o GeoHorun (docs/PLANO.md,
Fase 1, passo 6).

Copia as 8 tabelas `Postrun*` e a `AnalysisRename` do banco do RE7S para o
banco do GeoHorun, com os MESMOS ids (as tabelas têm os mesmos nomes e
colunas). Os dados vêm pelas rotas internas do RE7S
(`/internal/geohorun/export/<tabela>`, só leitura, com o token
RE7S_INTERNAL_TOKEN) — não é preciso ligar os dois bancos em rede.

Quem criou/validou cada coisa (`*_by_id`) é convertido: cada usuário do
RE7S vira um usuário local do GeoHorun com o MESMO id do Core
(`core_user_id`), então a pessoa se reconhece quando entrar pelo Core.
Contas do RE7S que nunca vieram do Core ganham um id provisório
"re7s:<nome>".

Uso (no servidor, dentro do container do GeoHorun):

    python -m app.scripts.migrar_do_re7s --simular   # só conta, não grava nada
    python -m app.scripts.migrar_do_re7s             # migra

Seguro de rodar de novo: recusa se as tabelas do GeoHorun já tiverem dados
(nada é sobrescrito). O RE7S não é alterado.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import func, text
from sqlalchemy import select as sa_select
from sqlmodel import Session, SQLModel, select

from app.db.models import Role, User

TABLES = (
    "postrunregion", "postruncalibration", "postrunanalysismeta", "postruncurve",
    "postrundeconvolution", "postrundeconvreference", "postrunstudy", "postrunb00cache",
    "analysisrename",
)
# o cache guarda o .B00 inteiro — páginas menores
_PAGE = {"postrunb00cache": 20}
_DEFAULT_PAGE = 200
UNKNOWN_USER = "re7s:desconhecido"


class MigrationError(RuntimeError):
    pass


Fetch = Callable[[str, int, int], dict]


def _all_rows(fetch: Fetch, table: str) -> list[dict]:
    rows: list[dict] = []
    limit = _PAGE.get(table, _DEFAULT_PAGE)
    while True:
        page = fetch(table, len(rows), limit)
        if page is None:
            raise MigrationError(f"O RE7S não respondeu a exportação de {table!r}")
        rows.extend(page["rows"])
        if not page["rows"] or len(rows) >= page["total"]:
            return rows


def _parse_dt(value: Any) -> Any:
    if value is None or isinstance(value, datetime):
        return value
    dt = datetime.fromisoformat(str(value))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class _Users:
    """id do usuário no RE7S -> id do usuário local do GeoHorun."""

    def __init__(self, session: Session, source: list[dict]):
        self.session = session
        self.source = {int(u["id"]): u for u in source}
        self.mapped: dict[int, int] = {}
        self.created: list[str] = []

    def _local(self, core_id: str, username: str) -> int:
        user = self.session.exec(select(User).where(User.core_user_id == core_id)).first()
        if user is None:
            user = User(core_user_id=core_id, username=username, role=Role.USER)
            self.session.add(user)
            self.session.flush()
            self.created.append(username)
        return user.id

    def map(self, source_id: Any) -> int:
        if source_id is None:
            return self._local(UNKNOWN_USER, "desconhecido (RE7S)")
        sid = int(source_id)
        if sid not in self.mapped:
            src = self.source.get(sid)
            if src is None:
                self.mapped[sid] = self._local(UNKNOWN_USER, "desconhecido (RE7S)")
            else:
                core_id = src.get("core_user_id") or f"re7s:{src['username']}"
                self.mapped[sid] = self._local(core_id, src["username"])
        return self.mapped[sid]


def _count(session: Session, table) -> int:
    return session.execute(sa_select(func.count()).select_from(table)).scalar_one()


def migrate(session: Session, fetch: Fetch, *, simulate: bool = False) -> dict:
    """Faz a migração numa transação só (tudo ou nada). `fetch(tabela,
    offset, limit)` devolve uma página da exportação do RE7S."""
    md = SQLModel.metadata.tables
    busy = [t for t in TABLES if _count(session, md[t]) > 0]
    if busy:
        raise MigrationError(
            "O GeoHorun já tem dados em " + ", ".join(busy) + " — a migração só roda num banco vazio "
            "(nada foi alterado)."
        )

    users = _Users(session, _all_rows(fetch, "user"))
    report: dict[str, int] = {}
    try:
        for name in TABLES:
            table = md[name]
            target_cols = {c.name: c for c in table.columns}
            dt_cols = {n for n, c in target_cols.items() if "DateTime" in type(c.type).__name__}
            by_cols = [n for n in target_cols if n.endswith("_by_id")]
            rows = []
            for row in _all_rows(fetch, name):
                clean = {k: v for k, v in row.items() if k in target_cols}
                for col in dt_cols & clean.keys():
                    clean[col] = _parse_dt(clean[col])
                for col in by_cols:
                    clean[col] = users.map(clean.get(col))
                rows.append(clean)
            if rows:
                session.execute(table.insert(), rows)
            report[name] = len(rows)
        _fix_sequences(session)
        if simulate:
            session.rollback()
        else:
            session.commit()
    except Exception:
        session.rollback()
        raise
    return {"tables": report, "users_created": users.created, "simulated": simulate}


def _fix_sequences(session: Session) -> None:
    """No Postgres, inserir com id explícito não avança o contador — sem
    isto o próximo registro novo colidiria com um migrado."""
    if session.get_bind().dialect.name != "postgresql":
        return
    md = SQLModel.metadata.tables
    for name in (*TABLES, "user"):
        if "id" not in md[name].columns:
            continue
        session.execute(text(
            f"SELECT setval(pg_get_serial_sequence('\"{name}\"', 'id'), "
            f"COALESCE((SELECT MAX(id) FROM \"{name}\"), 0) + 1, false)"
        ))


def _fetch_from_re7s(table: str, offset: int, limit: int) -> dict:
    from app.modules import re7s_link

    return re7s_link.backend().get(f"/export/{table}", {"offset": offset, "limit": limit})


def main(argv: list[str] | None = None) -> int:
    from app.db.session import create_db_and_tables, engine
    from app.modules import re7s_link

    parser = argparse.ArgumentParser(description="Migra os dados do PostRun do RE7S para o GeoHorun.")
    parser.add_argument("--simular", action="store_true", help="só conta o que seria copiado; não grava nada")
    args = parser.parse_args(argv)

    if not re7s_link.configured():
        print("RE7S não configurado: defina RE7S_INTERNAL_URL e RE7S_INTERNAL_TOKEN.", file=sys.stderr)
        return 2
    create_db_and_tables()
    try:
        with Session(engine) as session:
            result = migrate(session, _fetch_from_re7s, simulate=args.simular)
    except (MigrationError, re7s_link.Re7sUnavailable) as exc:
        print(f"Migração não feita: {exc}", file=sys.stderr)
        return 1
    print("SIMULAÇÃO (nada gravado)" if result["simulated"] else "Migração concluída")
    for name, n in result["tables"].items():
        print(f"  {name:24s} {n:6d}")
    print(f"  usuários criados: {len(result['users_created'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
