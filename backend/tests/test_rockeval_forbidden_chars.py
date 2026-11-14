r"""Pontuação que o RockSeven Supervisor não aceita (`. , / \ : ;`) — só a
parte do PostRun do teste do RE7S (renomear: extra e nome completo); a parte
da fila de amostras fica no RE7S."""

import pytest

from app.modules import analysis_rename as ar


def test_postrun_rename_extra_and_full_name_are_validated():
    with pytest.raises(ar.RenameError, match="RockSeven"):
        ar.name_with_extra("2026-07-17_STDA_1", "rep.2")
    with pytest.raises(ar.RenameError, match="RockSeven"):
        ar.plan(ar.split_token("J/BULK ROCK/2026-07-17_X_1.B00"), new_name="2026-07-17_X;1", new_job=None)
