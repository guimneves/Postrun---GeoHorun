"""Migração dos dados do PostRun do RE7S (app/scripts/migrar_do_re7s.py) —
com uma exportação falsa no mesmo formato de /internal/geohorun/export."""

from __future__ import annotations

from datetime import timezone

import pytest
from sqlmodel import Session, select

from app.db.models import AnalysisRename, PostrunB00Cache, PostrunCalibration, PostrunRegion, User
from app.scripts.migrar_do_re7s import MigrationError, migrate

T0 = "2026-10-01T12:00:00+00:00"


def _export() -> dict[str, list[dict]]:
    return {
        "user": [
            {"id": 1, "username": "admin-protegido", "core_user_id": None},
            {"id": 5, "username": "ana", "core_user_id": "core-5"},
            {"id": 9, "username": "bia", "core_user_id": "core-9"},
        ],
        "postrunregion": [
            {"id": 10 + i, "token": f"J/BULK ROCK/A_{i}.B00", "channel": "pyro:FID", "label": f"R{i}",
             "start_idx": 1, "end_idx": 50, "baseline_mode": "linear", "fixed_baseline": 0.0,
             "created_by_id": 5, "created_at": T0, "coluna_que_nao_existe_mais": "x"}
            for i in range(7)  # mais que uma página (limite 3 no teste)
        ],
        "postruncalibration": [
            {"id": 3, "channel": "pyro:FID", "validated_by_id": 9, "validated_at": T0},
        ],
        "postrunb00cache": [{"token": "J/BULK ROCK/A_0.B00", "content": "[Header]\n", "cached_at": T0}],
        "analysisrename": [
            {"id": 4, "old_token": "J/x_1.B00", "new_token": "J/x_rep_1.B00", "old_analysis_name": "x_1",
             "new_analysis_name": "x_rep_1", "old_job": "J", "new_job": "J", "history_entry_id": 77,
             "status": "done", "renamed_by_id": 1, "created_at": T0, "completed_at": T0},
        ],
    }


def _fetch(data: dict[str, list[dict]], page: int = 3):
    calls = []

    def fetch(table: str, offset: int, limit: int) -> dict:
        calls.append((table, offset))
        rows = data.get(table, [])
        return {"table": table, "total": len(rows), "offset": offset, "rows": rows[offset:offset + min(limit, page)]}

    fetch.calls = calls  # type: ignore[attr-defined]
    return fetch


def _fill_required(data):
    """Completa as colunas obrigatórias da calibração a partir do modelo."""
    from sqlmodel import SQLModel

    cols = SQLModel.metadata.tables["postruncalibration"].columns
    for row in data["postruncalibration"]:
        for c in cols:
            if c.name not in row and not c.nullable and c.default is None:
                row[c.name] = 0 if "INT" in str(c.type).upper() or "FLOAT" in str(c.type).upper() else "x"
    return data


def test_migrates_with_same_ids_and_maps_users(db_engine):
    data = _fill_required(_export())
    with Session(db_engine) as s:
        result = migrate(s, _fetch(data))
    assert result["tables"]["postrunregion"] == 7 and result["tables"]["analysisrename"] == 1
    with Session(db_engine) as s:
        regions = s.exec(select(PostrunRegion).order_by(PostrunRegion.id)).all()
        assert [r.id for r in regions] == list(range(10, 17))  # mesmos ids
        ana = s.exec(select(User).where(User.core_user_id == "core-5")).one()
        assert ana.username == "ana" and {r.created_by_id for r in regions} == {ana.id}
        cal = s.get(PostrunCalibration, 3)
        assert cal.validated_by_id == s.exec(select(User).where(User.core_user_id == "core-9")).one().id
        rename = s.get(AnalysisRename, 4)
        # conta local do RE7S (sem Core): id provisório pelo nome
        assert s.get(User, rename.renamed_by_id).core_user_id == "re7s:admin-protegido"
        assert rename.history_entry_id == 77  # id do histórico NO RE7S, como antes
        created = rename.created_at if rename.created_at.tzinfo else rename.created_at.replace(tzinfo=timezone.utc)
        assert created.isoformat() == T0
        assert s.get(PostrunB00Cache, "J/BULK ROCK/A_0.B00").content == "[Header]\n"


def test_existing_core_user_is_reused(db_engine):
    with Session(db_engine) as s:
        s.add(User(core_user_id="core-5", username="ana"))
        s.commit()
    with Session(db_engine) as s:
        result = migrate(s, _fetch(_fill_required(_export())))
    assert "ana" not in result["users_created"]
    with Session(db_engine) as s:
        assert len(s.exec(select(User).where(User.core_user_id == "core-5")).all()) == 1


def test_simulation_writes_nothing(db_engine):
    with Session(db_engine) as s:
        result = migrate(s, _fetch(_fill_required(_export())), simulate=True)
    assert result["simulated"] and result["tables"]["postrunregion"] == 7
    with Session(db_engine) as s:
        assert s.exec(select(PostrunRegion)).all() == []
        assert s.exec(select(User)).all() == []


def test_refuses_when_geohorun_already_has_data(db_engine):
    data = _fill_required(_export())
    with Session(db_engine) as s:
        migrate(s, _fetch(data))
    with Session(db_engine) as s, pytest.raises(MigrationError, match="já tem dados"):
        migrate(s, _fetch(data))
    with Session(db_engine) as s:
        assert len(s.exec(select(PostrunRegion)).all()) == 7  # nada duplicado


def test_failure_in_the_middle_leaves_nothing(db_engine):
    data = _fill_required(_export())

    def broken(table, offset, limit):
        if table == "analysisrename":
            return None  # RE7S parou de responder
        return _fetch(data)(table, offset, limit)

    with Session(db_engine) as s, pytest.raises(MigrationError):
        migrate(s, broken)
    with Session(db_engine) as s:
        assert s.exec(select(PostrunRegion)).all() == []  # tudo ou nada


def test_new_records_after_migration_get_new_ids(db_engine):
    with Session(db_engine) as s:
        migrate(s, _fetch(_fill_required(_export())))
    with Session(db_engine) as s:
        uid = s.exec(select(User)).first().id
        r = PostrunRegion(token="J/x.B00", channel="pyro:FID", label="nova", start_idx=1, end_idx=2,
                          created_by_id=uid)
        s.add(r)
        s.commit()
        assert r.id == 17
