"""PCA e PLS (17/11/2026): a matemática conferida contra cálculos
independentes e contra os números do exemplo de brinquedo (roteiro de slides);
as rotas com `.B00` sintéticos (STD em 440 °C, X em 500 °C)."""

import numpy as np
import pytest

from app.modules import postrun_chemometrics as chem
from tests.test_postrun_compare import _build

# exemplo de brinquedo (as mesmas contas do roteiro de slides)
A = np.array([2, 10, 4, 1, 0], float)
B = np.array([0, 1, 4, 10, 3], float)
FRAC = np.array([1, 0.75, 0.5, 0.5, 0.25, 0])


def _toy():
    X = np.outer(FRAC, A) + np.outer(1 - FRAC, B)
    X[3] += np.array([0, 0.3, 0.8, -0.6, 0.4])  # a réplica "esquisita"
    return X


def test_pca_two_variables_matches_the_slides():
    X = np.array([[8, 2], [6, 4], [5, 5], [4, 6.5], [2, 8]], float)
    res = chem.pca(X, 2)
    # contra a decomposição da covariância (cálculo independente do SVD)
    w, v = np.linalg.eigh(np.cov(X.T))
    assert np.allclose(sorted(res.eigenvalues, reverse=True), sorted(w, reverse=True))
    assert res.explained[0] == pytest.approx(0.998, abs=5e-4)
    assert abs(res.loadings[:, 0]) == pytest.approx([0.697, 0.717], abs=1e-3)
    assert abs(res.scores[:, 0]) == pytest.approx([4.314, 1.486, 0.072, 1.701, 4.170], abs=2e-3)
    # X = T·Pᵀ + E: com todos os PCs, E = 0
    assert np.allclose(res.scores @ res.loadings.T + res.mean, X)


def test_pca_of_mixtures_loading_is_A_minus_B_and_pc2_flags_the_odd_replica():
    res = chem.pca(_toy(), 2)
    assert res.explained[0] == pytest.approx(0.993, abs=1e-3)
    ab = (A - B) / np.linalg.norm(A - B)
    assert abs(float(res.loadings[:, 0] @ ab)) == pytest.approx(1.0, abs=1e-3)
    # o score do PC1 acompanha a fração de A
    assert abs(np.corrcoef(res.scores[:, 0], FRAC)[0, 1]) > 0.99
    # o PC2 isola a réplica esquisita (índice 3), que também tem o maior Q com 1 PC
    assert int(np.argmax(np.abs(res.scores[:, 1]))) == 3
    assert int(np.argmax(chem.pca(_toy(), 1).q)) == 3


def test_pls_one_lv_matches_the_slides():
    m = chem.pls1(_toy(), FRAC, 1)
    assert m.b == pytest.approx([0.011, 0.051, 0.000, -0.051, -0.017], abs=1e-3)
    assert m.b0 == pytest.approx(0.508, abs=1e-3)
    assert m.predict(_toy()) == pytest.approx([0.992, 0.743, 0.493, 0.533, 0.244, -0.006], abs=1e-3)


def test_pls_with_all_lvs_equals_least_squares():
    # com o número máximo de LVs, a PLS é a solução de mínimos quadrados de
    # norma mínima — cálculo independente pela pseudoinversa
    rng = np.random.default_rng(3)
    X = rng.normal(size=(8, 20))
    y = rng.normal(size=8)
    m = chem.pls1(X, y, 7)
    Xc, yc = X - X.mean(0), y - y.mean()
    assert np.allclose(m.b, np.linalg.pinv(Xc) @ yc, atol=1e-8)


def test_vip_points_to_the_informative_variables():
    rng = np.random.default_rng(5)
    y = rng.uniform(0, 1, 30)
    X = rng.normal(scale=0.05, size=(30, 10))
    X[:, 2] += y
    X[:, 7] -= 2 * y
    v = chem.vip(chem.pls1(X, y, 2))
    assert set(np.argsort(v)[-2:]) == {2, 7}
    assert np.mean(v ** 2) == pytest.approx(1.0, abs=1e-9)  # propriedade do VIP


def test_cv_keeps_replicates_together_and_picks_parsimonious_lvs():
    rng = np.random.default_rng(7)
    fr = np.repeat([0, 0.25, 0.5, 0.75, 1.0], 3)
    X = np.outer(fr, A) + np.outer(1 - fr, B) + rng.normal(scale=0.05, size=(15, 5))
    groups = [f"g{f}" for f in fr]
    cv = chem.pls_cv(X, fr, groups, max_lv=4)
    assert cv.chosen == 1  # uma fonte de variação só: 1 LV basta
    assert cv.rmsecv[0] < 0.05 and cv.q2 > 0.98
    assert all(a >= b - 1e-12 for a, b in zip(cv.rmsec, cv.rmsec[1:]))  # RMSEC só cai
    with pytest.raises(chem.ChemometricsError):
        chem.pls_cv(X[:6], fr[:6], groups[:6])  # 2 composições: não dá validação


def test_preprocess_area_derivative_and_alignment():
    grid = np.arange(400, 601, 1.0)
    peak = lambda c, h: h * np.exp(-0.5 * ((grid - c) / 15) ** 2)  # noqa: E731
    X = np.vstack([peak(500, 1), peak(500, 3), peak(508, 2)])
    Xa, _ = chem.preprocess(grid, X, None, chem.Prep(normalize="area"))
    assert np.allclose(Xa[0], Xa[1])  # mesma forma, massas diferentes → iguais
    Xl, shifts = chem.preprocess(grid, X, None, chem.Prep(normalize="area", align=True))
    assert shifts[2] == pytest.approx(-8, abs=1) and np.max(np.abs(Xl[2] - Xl[0])) < 0.02 * Xl[0].max()
    Xd, _ = chem.preprocess(grid, X, None, chem.Prep(normalize="none", derivative=1))
    assert abs(grid[int(np.argmin(np.abs(Xd[0][80:120]))) + 80] - 500) <= 1  # derivada zera no máximo
    with pytest.raises(chem.ChemometricsError):
        chem.preprocess(grid, X, np.array([1.0, 0.0, 2.0]), chem.Prep(normalize="mass"))


# ------------------------------------------------------------------ rotas

def _study(client, jobs) -> int:
    pures, mixes = _build(client, jobs)
    s = client.post("/api/postrun/studies", json={"name": "quimiometria", "method": "molde"}).json()
    client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": pures + mixes})
    return s["id"]


def test_pca_route_separates_the_two_materials(user_client, jobs):
    sid = _study(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/pca", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prep"]["normalize"] == "area" and not body["errors"]
    n, p = len(body["runs"]), len(body["grid"])
    assert n == 8 and len(body["x"]) == n and all(len(row) == p for row in body["x"])
    assert len(body["loadings"][0]) == p and body["explained"][0] > 0.9
    pc1 = {r["token"]: s[0] for r, s in zip(body["runs"], body["scores"])}
    kinds = {r["token"]: r for r in body["runs"]}
    std = [pc1[t] for t, r in kinds.items() if r["composition"] == {"STD": 1.0}]
    x = [pc1[t] for t, r in kinds.items() if r["composition"] == {"X": 1.0}]
    assert max(std) < min(x) or max(x) < min(std)  # os puros em lados opostos do PC1
    # o loading do PC1 troca de sinal entre o pico do STD (440 °C) e o do X (500 °C)
    grid = np.array(body["grid"])
    load = np.array(body["loadings"][0])
    assert np.sign(load[np.argmin(abs(grid - 440))]) != np.sign(load[np.argmin(abs(grid - 500))])


def test_pls_route_predicts_masses(user_client, jobs):
    sid = _study(user_client, jobs)
    r = user_client.post(f"/api/postrun/studies/{sid}/pls", json={"target": "mass"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unit"] == "mg" and body["prep"]["normalize"] == "none" and body["n_groups"] == 5
    by = {m["material"]: m for m in body["materials"]}
    assert set(by) == {"STD", "X"}
    for m in by.values():
        assert m["error"] is None and m["n_lv"] >= 1
        assert len(m["b"]) == len(m["vip"]) == len(body["grid"])
        assert m["r2_cal"] > 0.99
    # com a fração como alvo, a X vem normalizada pela área
    f = user_client.post(f"/api/postrun/studies/{sid}/pls", json={"target": "fraction"}).json()
    assert f["unit"] == "%" and f["prep"]["normalize"] == "area"
    assert user_client.post(f"/api/postrun/studies/{sid}/pls", json={"target": "x"}).status_code == 400


def test_chemometrics_need_runs(user_client):
    s = user_client.post("/api/postrun/studies", json={"name": "vazio", "method": "molde"}).json()
    assert user_client.post(f"/api/postrun/studies/{s['id']}/pca", json={}).status_code == 400
