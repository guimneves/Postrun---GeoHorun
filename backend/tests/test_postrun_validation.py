"""F3 do artigo: validação independente (calibração × validação, modo cego,
RMSEP, viés, precisão intermediária por ANOVA) — `.B00` sintéticos."""

import math
from datetime import datetime

import pytest

from app.modules import postrun_validation as pv
from tests.b00_factory import YIELD, B00Spec, Peak, write_b00
from tests.test_postrun_report import _setup, _spec
from tests.b00_factory import T1, T2

# ------------------------------------------------------------------ matemática


def test_anova_separates_between_and_within_day():
    # dois dias, 3 réplicas cada: médias 99 e 103, dispersão dentro do dia 1
    a = pv.anova_one_way([[98.0, 99.0, 100.0], [102.0, 103.0, 104.0]])
    assert a.ms_within == pytest.approx(1.0)
    assert a.ms_between == pytest.approx(24.0)  # 3 × ((99−101)² + (103−101)²) / 1
    assert a.s_r == pytest.approx(1.0)
    assert a.s_between == pytest.approx(math.sqrt((24.0 - 1.0) / 3))
    assert a.s_ip == pytest.approx(math.sqrt(1.0 + 23.0 / 3))


def test_anova_edge_cases():
    one_day = pv.anova_one_way([[99.0, 101.0]])
    assert one_day.s_ip is None and one_day.s_r == pytest.approx(math.sqrt(2.0))
    assert any("2 dias" in w for w in one_day.warnings)
    no_rep = pv.anova_one_way([[99.0], [101.0]])
    assert no_rep.s_r is None
    no_day_effect = pv.anova_one_way([[90.0, 110.0], [91.0, 109.0]])
    assert no_day_effect.s_between == 0.0


def test_metrics_bias_rmsep_and_regression():
    pairs = [pv.Pair("t1", "PS", "d1", 1.0, 1.1), pv.Pair("t2", "PS", "d1", 2.0, 2.1), pv.Pair("t3", "PS", "d2", 3.0, 3.1)]
    (m,) = pv.metrics(pairs)
    assert m.bias_mg == pytest.approx(0.1) and m.rmsep_mg == pytest.approx(0.1)
    assert m.slope == pytest.approx(1.0) and m.intercept == pytest.approx(0.1)
    assert m.n == 3 and m.n_days == 2


# --------------------------------------------------------------- de ponta a ponta

VAL = "Validacao/BULK ROCK/2026-07-{day}_STDV_{i}.B00"


def _validation_runs(client, jobs) -> list[str]:
    """6 corridas de STD puro em 2 dias (20 e 21/07), fora da curva."""
    tokens = []
    for day, seed0 in ((20, 700), (21, 710)):
        for i, mass in enumerate((35.0, 45.0, 55.0), start=1):
            t = VAL.format(day=day, i=i)
            write_b00(jobs / t, B00Spec(sample="STDV", quant_mg=mass, date=datetime(2026, 7, day, 9, i),
                                        s2_peaks=(Peak(440.0, 45.0, YIELD * mass * (1.01 if day == 21 else 0.99)),),
                                        seed=seed0 + i))
            tokens.append(t)
    assert client.put("/api/postrun/analyses/meta", json=[{"token": t, "composition_text": "STD"} for t in tokens]).status_code == 200
    r = client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(t, names=["STD"]) for t in tokens]})
    assert r.status_code == 200, r.text
    return tokens


def _study(client, tokens) -> int:
    s = client.post("/api/postrun/studies", json={"name": "validação", "method": "gauss"}).json()
    assert client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": tokens}).status_code == 200
    return s["id"]


def test_validation_metrics_and_separation(user_client, jobs):
    _setup(user_client)
    val = _validation_runs(user_client, jobs)
    sid = _study(user_client, [T1, T2, *val])
    roles = {T1: "calibracao", T2: "calibracao", **{t: "validacao" for t in val}}
    assert user_client.put(f"/api/postrun/studies/{sid}/validation/config", json={"roles": roles}).status_code == 200

    body = user_client.post(f"/api/postrun/studies/{sid}/validation").json()
    assert body["n_calibration"] == 2 and body["n_validation"] == 6 and not body["hidden"]
    (m,) = body["metrics"]
    assert m["material"] == "STD" and m["n"] == 6 and m["n_days"] == 2
    assert m["recovery_mean"] == pytest.approx(100.0, abs=3)
    assert m["anova"]["k_days"] == 2 and m["anova"]["s_ip"] is not None
    assert len(body["points"]) == 6 and body["conflicts"] == []

    # uma corrida da curva marcada como validação: sai das métricas, com o motivo
    roles[T1] = "validacao"
    user_client.put(f"/api/postrun/studies/{sid}/validation/config", json={"roles": roles})
    body = user_client.post(f"/api/postrun/studies/{sid}/validation").json()
    assert any("ponto da curva" in c for c in body["conflicts"])
    t1 = next(r for r in body["runs"] if r["token"] == T1)
    assert not t1["included"] and "ponto da curva" in t1["reason"]
    assert body["metrics"][0]["n"] == 6


def test_blind_mode_hides_answers_until_reveal_and_then_locks(user_client, second_user_client, jobs):
    _setup(user_client)
    val = _validation_runs(user_client, jobs)
    sid = _study(user_client, [T1, T2, *val])
    roles = {T1: "calibracao", T2: "calibracao", **{t: "validacao" for t in val}}
    url = f"/api/postrun/studies/{sid}/validation"
    assert user_client.put(f"{url}/config", json={"roles": roles, "blind": True}).status_code == 200

    blind = user_client.post(url).json()
    assert blind["hidden"] and blind["metrics"] == [] and blind["points"] == []
    assert [r["code"] for r in blind["runs"]] == [f"V0{i}" for i in range(1, 7)]
    assert all(r["token"] is None and r["label"].startswith("V") for r in blind["runs"])
    mats = [m for r in blind["runs"] for m in r["materials"]]
    assert all(m["added_mg"] is None and m["recovery_pct"] is None for m in mats)
    assert all(m["found_mg"] is not None for m in mats)  # a quantificação aparece

    assert second_user_client.post(f"{url}/reveal").status_code == 403  # só quem criou (ou admin)
    shown = user_client.post(f"{url}/reveal").json()
    assert not shown["hidden"] and shown["metrics"][0]["n"] == 6
    assert shown["config"]["revealed_at"] is not None
    assert user_client.post(f"{url}/reveal").status_code == 409

    # depois de revelar, o conjunto de validação fica travado
    roles[val[0]] = "calibracao"
    assert user_client.put(f"{url}/config", json={"roles": roles, "blind": True}).status_code == 409


def test_config_rejects_tokens_outside_the_study_and_bad_roles(user_client, jobs):
    _setup(user_client)
    sid = _study(user_client, [T1, T2])
    url = f"/api/postrun/studies/{sid}/validation/config"
    assert user_client.put(url, json={"roles": {"Outro/x.B00": "validacao"}}).status_code == 400
    assert user_client.put(url, json={"roles": {T1: "teste"}}).status_code == 400
