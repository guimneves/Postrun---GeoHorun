"""F9 do artigo: identificabilidade — correlação das áreas por material,
recomendação de reportar a soma do par mal condicionado e bootstrap dos
resíduos. `.B00` sintéticos: X bem separado do STD; Y quase em cima dele."""

from datetime import datetime

import numpy as np

from app.api.routes_postrun_identifiability import material_correlation
from tests.b00_factory import YIELD, B00Spec, Peak, write_b00
from tests.test_postrun_compare import _build, _region

PURE_Y = "Puros Y/BULK ROCK/2026-07-20_Y_{}.B00"
MIX_Y = "Mix Y/BULK ROCK/2026-07-20_MIXY_{}.B00"


def test_material_correlation_sums_peaks_of_the_same_material():
    peaks = [{"material": "A", "u_area_s": 1.0}, {"material": "A", "u_area_s": 1.0}, {"material": "B", "u_area_s": 1.0}]
    corr = [[1, 0, -0.5], [0, 1, -0.5], [-0.5, -0.5, 1]]
    mats, mc = material_correlation(peaks, corr)
    assert mats == ["A", "B"]
    # cov(A,B) = −1; var(A) = 2; var(B) = 1 → ρ = −1/√2
    assert np.isclose(mc[0, 1], -1 / np.sqrt(2))


def _study_with_overlap(client, jobs):
    pures, mixes = _build(client, jobs)
    ys, ymix = [], []
    for i, m in enumerate((20.0, 40.0, 60.0), start=1):
        t = PURE_Y.format(i)
        write_b00(jobs / t, B00Spec(sample="Y", quant_mg=m, date=datetime(2026, 7, 20, 9, i),
                                    s2_peaks=(Peak(452.0, 45.0, YIELD * m),), seed=920 + i))
        ys.append(t)
    for i, (a, b) in enumerate(((20.0, 20.0), (30.0, 10.0)), start=1):
        t = MIX_Y.format(i)
        write_b00(jobs / t, B00Spec(sample="MIXY", quant_mg=a + b, date=datetime(2026, 7, 20, 10, i),
                                    s2_peaks=(Peak(440.0, 45.0, YIELD * a), Peak(452.0, 45.0, YIELD * b)), seed=930 + i))
        ymix.append(t)
    meta = [*({"token": t, "composition_text": "Y"} for t in ys),
            {"token": ymix[0], "composition_text": "STD 50, Y 50"}, {"token": ymix[1], "composition_text": "STD 75, Y 25"}]
    client.put("/api/postrun/analyses/meta", json=meta)
    new = ys + ymix
    client.put("/api/postrun/regions/save", json={"upserts": [_region(t) for t in new]})
    tokens = pures + mixes + new
    assert client.post("/api/postrun/workflow/references", json={"tokens": tokens}).status_code == 200
    for method in ("molde",):
        res = client.post("/api/postrun/workflow/fit", json={"tokens": tokens, "method": method}).json()
        assert all(i["ok"] for i in res), [i for i in res if not i["ok"]]
    r = client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": "molde", "model": "origin"})
    assert all(c["ok"] for c in r.json()), r.text
    s = client.post("/api/postrun/studies", json={"name": "identificabilidade", "method": "molde"}).json()
    client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": tokens})
    return s["id"], mixes, ymix


def test_overlapping_pair_is_flagged_and_sum_recommended(user_client, jobs):
    sid, mixes, ymix = _study_with_overlap(user_client, jobs)
    body = user_client.post(f"/api/postrun/studies/{sid}/identifiability").json()
    by = {r["token"]: r for r in body["runs"]}
    sep = by[mixes[1]]["pairs"][0]
    assert {sep["a"], sep["b"]} == {"STD", "X"} and not sep["ill_conditioned"]
    over = by[ymix[0]]["pairs"][0]
    assert {over["a"], over["b"]} == {"STD", "Y"} and over["ill_conditioned"] and over["rho"] < -0.9
    assert over["recovery_sum"] is not None
    assert any("STD + Y" in r for r in body["recommendations"])
    assert not any("X" in r for r in body["recommendations"])


def test_bootstrap_shows_the_sum_is_better_determined(user_client, jobs):
    sid, mixes, ymix = _study_with_overlap(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/identifiability/bootstrap",
                         json={"token": ymix[0], "n_boot": 30, "block": 15})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_ok"] >= 25
    (pair,) = body["pairs"]
    assert pair["sum_cv_pct"] < min(pair["a_cv_pct"], pair["b_cv_pct"])
    assert len(body["samples"]["STD"]) == body["n_ok"]
    assert all(m["found_p2_5"] <= m["found_mean"] <= m["found_p97_5"] for m in body["materials"])
