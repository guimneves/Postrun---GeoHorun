"""F8 do artigo: robustez dos moldes — deixa-uma-corrida-de-fora, incerteza
combinada com o termo do molde e comparação com outro molde. Sintéticos."""

from tests.test_postrun_compare import _build


def _study(client, jobs):
    pures, mixes = _build(client, jobs)
    tokens = pures + mixes
    r = client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": "molde", "model": "origin"})
    assert r.status_code == 200 and all(c["ok"] for c in r.json()), r.text
    s = client.post("/api/postrun/studies", json={"name": "robustez", "method": "molde"}).json()
    client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": tokens})
    return s["id"], pures, mixes


def test_leave_one_run_out_and_combined_uncertainty(user_client, jobs):
    sid, pures, mixes = _study(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/template-robustness", json={"material": "x"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["material"] == "X" and body["n_template_runs"] == 3 and body["n_mixtures"] == 3
    assert body["baseline_recovery"] is not None and abs(body["baseline_recovery"] - 100) < 5
    assert len(body["loro"]) == 3 and all(x["error"] is None for x in body["loro"]), body["loro"]
    # puros idênticos em forma: tirar um não muda quase nada
    assert body["template_sd_recovery"] is not None and body["template_sd_recovery"] < 2
    assert len(body["combined"]) == 3
    for c in body["combined"]:
        assert c["U95_combined_mg"] >= 2 * c["u_fit_mg"] - 1e-9  # o termo do molde só soma
        assert 0 <= c["template_share_pct"] <= 100


def test_compare_with_another_template(user_client, jobs):
    sid, pures, mixes = _study(user_client, jobs)
    x_pures = [t for t in pures if "Puros X" in t]
    alt = user_client.post("/api/postrun/deconvolution/references", json={"name": "X-LOTE2", "tokens": x_pures[:2]})
    assert alt.status_code == 200, alt.text
    body = user_client.post(f"/api/postrun/studies/{sid}/template-robustness",
                            json={"material": "X", "alt_reference_id": alt.json()["id"]}).json()
    cmp = body["compare"]
    assert cmp["correlation"] > 0.99 and cmp["l2_rel_pct"] < 10
    assert abs(cmp["delta_recovery"]) < 3
    assert any("X-LOTE2" in w for w in body["warnings"])  # nome diferente do material: avisado


def test_needs_mixtures_with_the_material(user_client, jobs):
    sid, *_ = _study(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/template-robustness", json={"material": "PS"})
    assert r.status_code == 400
