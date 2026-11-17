"""F6 do artigo: comparador de modelos (molde, ablações, CLS, gaussiana e
bigaussiana guiadas, soma ponderada de Pawar e Kim, 2025) nos mesmos dados, sem gravar —
com `.B00` sintéticos de dois materiais (STD a 440 °C e X a 500 °C)."""

from datetime import datetime

import pytest

from tests.b00_factory import T1, T2, T3, YIELD, B00Spec, Peak, write_b00

PURE_X = "Puros X/BULK ROCK/2026-07-19_X_{}.B00"
MIX = "Mix X/BULK ROCK/2026-07-19_MIX_{}.B00"


def _region(token):
    return {"token": token, "channel": "pyro:FID", "label": "S2", "start_idx": 300, "end_idx": 1100,
            "baseline_mode": "linear"}


def _build(client, jobs) -> tuple[list[str], list[str]]:
    xs = []
    for i, m in enumerate((20.0, 40.0, 60.0), start=1):
        t = PURE_X.format(i)
        write_b00(jobs / t, B00Spec(sample="X", quant_mg=m, date=datetime(2026, 7, 19, 9, i),
                                    s2_peaks=(Peak(500.0, 40.0, YIELD * m),), seed=800 + i))
        xs.append(t)
    mixes = [T3]
    for i, (a, b) in enumerate(((10.0, 30.0), (30.0, 10.0)), start=1):
        t = MIX.format(i)
        write_b00(jobs / t, B00Spec(sample="MIX", quant_mg=a + b, date=datetime(2026, 7, 19, 10, i),
                                    s2_peaks=(Peak(440.0, 45.0, YIELD * a), Peak(500.0, 40.0, YIELD * b)), seed=810 + i))
        mixes.append(t)
    meta = [{"token": T1, "mass_mg": 60.0, "composition_text": "STD"}, {"token": T2, "mass_mg": 30.0, "composition_text": "STD"},
            *({"token": t, "composition_text": "X"} for t in xs),
            {"token": T3, "mass_mg": 40.0, "composition_text": "STD 50, X 50"},
            {"token": mixes[1], "composition_text": "STD 25, X 75"}, {"token": mixes[2], "composition_text": "STD 75, X 25"}]
    assert client.put("/api/postrun/analyses/meta", json=meta).status_code == 200
    pures = [T1, T2, *xs]
    tokens = pures + mixes
    client.put("/api/postrun/regions/save", json={"upserts": [_region(t) for t in tokens]})
    r = client.post("/api/postrun/workflow/references", json={"tokens": tokens})
    assert r.status_code == 200, r.text
    for method in ("molde", "gauss"):
        res = client.post("/api/postrun/workflow/fit", json={"tokens": tokens, "method": method}).json()
        assert all(i["ok"] for i in res), res
    return pures, mixes


def test_compare_models_on_the_same_data(user_client, jobs):
    pures, mixes = _build(user_client, jobs)
    s = user_client.post("/api/postrun/studies", json={"name": "comparação", "method": "molde"}).json()
    user_client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": pures + mixes})

    r = user_client.post(f"/api/postrun/studies/{s['id']}/compare-models", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_pure"] == 5 and body["n_mixtures"] == 3
    by = {m["key"]: m for m in body["models"]}
    assert set(by) == {"molde", "molde_c_fixo", "molde_s_fixo", "cls", "gauss", "bigauss", "pmp008"}
    for key, m in by.items():
        assert m["n_mixtures"] == 3 and m["n_failed"] == 0, (key, m["errors"])
        assert set(m["recovery"]) == {"STD", "X"}, key
        assert m["bic_mean"] is not None and m["r2_mean"] > 0.99
    # dados sintéticos com as mesmas formas dos puros: o molde recupera ~100 %
    assert by["molde"]["rmse_recovery_pct"] < 5
    assert by["cls"]["rmse_recovery_pct"] < 5
    assert by["molde"]["recovery"]["X"]["mean"] == pytest.approx(100.0, abs=5)
    assert body["best"] in by
    # nada foi gravado: as deconvoluções salvas continuam as mesmas
    saved = user_client.get("/api/postrun/deconvolution", params={"tokens": [mixes[1]], "method": "molde"}).json()
    assert len(saved) == 1


def test_compare_models_with_only_mixtures_in_the_study_uses_the_reference_runs(user_client, jobs):
    """16/11/2026 — "tem dois moldes e duas curvas salvas": o estudo guardou só
    as misturas; os puros que formaram as referências dele entram sozinhos."""
    pures, mixes = _build(user_client, jobs)
    s = user_client.post("/api/postrun/studies", json={"name": "só misturas", "method": "molde"}).json()
    user_client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": mixes})
    detail = user_client.get(f"/api/postrun/studies/{s['id']}").json()
    assert detail["reference_ids"] and set(detail["tokens"]) == set(mixes)
    r = user_client.post(f"/api/postrun/studies/{s['id']}/compare-models", json={"models": ["molde", "gauss"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_pure"] == 5 and body["n_mixtures"] == 3


def test_compare_models_needs_pures_and_mixtures(user_client, jobs):
    s = user_client.post("/api/postrun/studies", json={"name": "vazio", "method": "molde"}).json()
    user_client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": [T1, T2]})
    r = user_client.post(f"/api/postrun/studies/{s['id']}/compare-models", json={"models": ["molde"]})
    assert r.status_code == 400
    # a mensagem diz o que faltou, não só "precisa de puros e misturas"
    assert "Encontrei 0 pura(s) e 0 mistura(s)" in r.json()["detail"]
    r = user_client.post(f"/api/postrun/studies/{s['id']}/compare-models", json={"models": ["inexistente"]})
    assert r.status_code == 400
