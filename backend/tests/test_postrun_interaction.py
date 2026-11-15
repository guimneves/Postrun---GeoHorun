"""F7 do artigo: painel de interação na co-pirólise — previsão sem
interação (moldes rígidos × massa esperada), curva de diferença e ΔM, ΔTmax e
Δlargura × fração, alerta de parâmetro no limite. `.B00` sintéticos."""

from datetime import datetime

from tests.b00_factory import YIELD, B00Spec, Peak, write_b00
from tests.test_postrun_compare import _build, _region

SHIFTED = "Mix X/BULK ROCK/2026-07-19_MIXDESLOC_1.B00"


def _study(client, jobs, extra: list[str] | None = None) -> int:
    pures, mixes = _build(client, jobs)
    tokens = pures + mixes + (extra or [])
    r = client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": "molde", "model": "origin"})
    assert r.status_code == 200 and all(c["ok"] for c in r.json()), r.text
    s = client.post("/api/postrun/studies", json={"name": "interação", "method": "molde"}).json()
    client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": tokens})
    return s["id"]


def test_no_interaction_gives_flat_difference(user_client, jobs):
    sid = _study(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/interaction")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method"] == "molde" and len(body["runs"]) == 3
    for run in body["runs"]:
        assert run["error"] is None, run["error"]
        assert abs(run["delta_m_pct"]) < 3 and run["max_dev_pct"] < 10  # mistura = soma dos puros
        assert len(run["measured"]) == len(run["predicted"]) == len(run["difference"]) <= 400
        assert len(run["components"]) == 2 and {c["material"] for c in run["component_info"]} == {"STD", "X"}
    assert {(p["material"], p["fraction"]) for p in body["trends"]} >= {("STD", 0.5), ("X", 0.75)}


def test_shifted_component_shows_in_difference_and_alerts(user_client, jobs):
    # X deslocado +25 °C e 30 % mais largo na mistura: interação que o molde rígido não prevê
    write_b00(jobs / SHIFTED, B00Spec(sample="MIX", quant_mg=40.0, date=datetime(2026, 7, 19, 11, 0),
                                      s2_peaks=(Peak(440.0, 45.0, YIELD * 20.0), Peak(525.0, 52.0, YIELD * 20.0)), seed=900))
    user_client.put("/api/postrun/analyses/meta", json=[{"token": SHIFTED, "composition_text": "STD 50, X 50"}])
    user_client.put("/api/postrun/regions/save", json={"upserts": [_region(SHIFTED)]})
    sid = _study(user_client, jobs, extra=[])
    assert user_client.post("/api/postrun/workflow/fit", json={"tokens": [SHIFTED], "method": "molde"}).status_code == 200
    s = user_client.get(f"/api/postrun/studies/{sid}").json()
    user_client.post(f"/api/postrun/studies/{sid}/collect", json={"tokens": [*s["tokens"], SHIFTED]})

    body = user_client.post(f"/api/postrun/studies/{sid}/interaction").json()
    run = next(r for r in body["runs"] if r["token"] == SHIFTED)
    normal = [r for r in body["runs"] if r["token"] != SHIFTED]
    assert run["max_dev_pct"] > 3 * max(r["max_dev_pct"] for r in normal)
    # +25 °C passa da tolerância de centro (±10 °C): o alerta aparece
    assert any(a["token"] == SHIFTED and a["material"] == "X" for a in body["alerts"])


def test_interaction_needs_mixtures(user_client, jobs):
    s = user_client.post("/api/postrun/studies", json={"name": "vazio", "method": "molde"}).json()
    assert user_client.post(f"/api/postrun/studies/{s['id']}/interaction").status_code == 400
