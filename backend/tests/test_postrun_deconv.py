"""Deconvolução do PostRun (Fase 3, pedido do usuário de 16/10/2026).

Motor testado com sinais sintéticos (picos conhecidos + ruído); as rotas,
com os `.B00` sintéticos de tests/b00_factory.py (padrão "STD", cujo S2 é
uma gaussiana só, de centro e área conhecidos)."""

import math

import numpy as np
import pytest

from app.modules import postrun_deconv as d
from tests.b00_factory import SPECS, T1, T2, T3


rng = np.random.default_rng(7)
T = np.arange(300.0, 1100.0, 1.0)


def g(h, mu, s):
    return h * np.exp(-0.5 * ((T - mu) / s) ** 2)


def bg(h, mu, sl, sr):
    s = np.where(T < mu, sl, sr)
    return h * np.exp(-0.5 * ((T - mu) / s) ** 2)


# ------------------------------------------------------------------ motor


def test_two_free_gaussians_recover_centers_and_areas():
    y = g(1e5, 600, 30) + g(6e4, 700, 35) + rng.normal(0, 500, T.size)
    r = d.fit(T, y, d.auto_guesses(T, y, 2), "gaussian")
    assert [p.name for p in r.peaks] == ["G1", "G2"]
    a1, a2 = (1e5 * 30 * math.sqrt(2 * math.pi), 6e4 * 35 * math.sqrt(2 * math.pi))
    assert r.peaks[0].mu == pytest.approx(600, abs=1) and r.peaks[1].mu == pytest.approx(700, abs=1)
    assert r.peaks[0].area == pytest.approx(a1, rel=0.01) and r.peaks[1].area == pytest.approx(a2, rel=0.01)
    assert r.r2 > 0.999 and not r.warnings
    assert 0 < r.peaks[0].u_area < 0.02 * a1


def test_bigaussian_fits_a_skewed_peak_better():
    y = bg(1e5, 650, 40, 28) + rng.normal(0, 500, T.size)
    sym = d.fit(T, y, d.auto_guesses(T, y, 1), "gaussian")
    asym = d.fit(T, y, d.auto_guesses(T, y, 1), "bigaussian")
    p = asym.peaks[0]
    assert p.mu == pytest.approx(650, abs=0.5)
    assert p.sigma_l == pytest.approx(40, rel=0.02) and p.sigma_r == pytest.approx(28, rel=0.02)
    assert p.area == pytest.approx(1e5 * math.sqrt(math.pi / 2) * 68, rel=0.005)
    assert asym.bic < sym.bic


def test_guided_fit_respects_tolerance_and_flags_overlap():
    y = g(5e4, 700, 30) + g(5e4, 740, 28) + rng.normal(0, 500, T.size)
    guesses = [
        d.PeakGuess(mu=703, sigma=30, name="PP", mu_bounds=(693, 713), sigma_bounds=(24, 36), ref_mu=703, ref_sigma=30),
        d.PeakGuess(mu=737, sigma=28, name="PEAD", mu_bounds=(727, 747), sigma_bounds=(22, 34), ref_mu=737, ref_sigma=28),
    ]
    r = d.fit(T, y, guesses, "gaussian")
    assert [p.name for p in r.peaks] == ["PP", "PEAD"]
    assert all(693 <= r.peaks[0].mu <= 713 for _ in [0])
    assert r.total_area == pytest.approx(5e4 * math.sqrt(2 * math.pi) * 58, rel=0.01)  # a soma é robusta
    assert any("sobrepostos" in w for w in r.warnings)


def test_peak_pushed_against_tolerance_is_flagged():
    y = g(1e5, 650, 30) + rng.normal(0, 500, T.size)
    guess = d.PeakGuess(mu=700, sigma=30, name="PS", mu_bounds=(690, 710), sigma_bounds=(20, 40), ref_mu=700, ref_sigma=30)
    r = d.fit(T, y, [guess], "gaussian")
    assert r.peaks[0].mu == pytest.approx(690, abs=0.5)
    assert any("limite da tolerância" in w for w in r.warnings)


def test_engine_errors():
    with pytest.raises(d.DeconvError):
        d.auto_guesses(T, np.zeros_like(T), 1)
    with pytest.raises(d.DeconvError):
        d.fit(T[:5], np.ones(5), [d.PeakGuess(mu=302, sigma=1)] * 2, "gaussian")
    with pytest.raises(d.DeconvError):
        d.fit(T, g(1, 600, 30), [d.PeakGuess(mu=600, sigma=30)], "lorentz")


# ------------------------------------------------------------------ rotas


def _spec(token, **extra):
    return {"token": token, "channel": "pyro:FID", "start_idx": 300, "end_idx": 1100, "baseline_mode": "linear",
            "shape": "gaussian", "mode": "free", "n_peaks": 1, **extra}


def _fit(client, *specs):
    r = client.post("/api/postrun/deconvolution/fit", json={"items": list(specs)})
    assert r.status_code == 200, r.text
    return r.json()


def test_fit_does_not_save_and_returns_curves(user_client, jobs):
    item = _fit(user_client, _spec(T1))[0]
    assert item["ok"], item["error"]
    data = item["data"]
    pk = data["peaks"][0]
    assert pk["name"] == "G1" and 350 < pk["mu_c"] < 600 and pk["area_s"] > 0
    # centro e área da gaussiana gerada (tests/b00_factory.py)
    peak = SPECS[T1].s2_peaks[0]
    assert pk["mu_c"] == pytest.approx(peak.center_c, abs=3)
    assert pk["area_s"] == pytest.approx(peak.area, rel=0.03)
    assert data["seconds_per_point"] == 1.0 and data["r2"] > 0.8
    assert len(data["curve"]["idx"]) == len(data["curve"]["fitted"]) == len(data["curve"]["components"][0])
    # a soma dos picos e a área da janela são da mesma ordem (mesma unidade)
    assert 0.5 < data["total_area_s"] / data["window_area_s"] < 1.5
    assert user_client.get("/api/postrun/deconvolution", params={"tokens": [T1]}).json() == []
    bad = _fit(user_client, _spec(T1, mode="guided"))[0]
    assert not bad["ok"] and "referências" in bad["error"]


def test_save_reference_guided_curve_and_quantify(user_client, jobs):
    # 1) "puro": deconvolução livre com nome do material, salva nas duas réplicas
    saved = user_client.put("/api/postrun/deconvolution/save", json={
        "upserts": [_spec(T1, names=["STD"]), _spec(T2, names=["STD"])]
    })
    assert saved.status_code == 200, saved.text
    assert [s["peaks"][0]["material"] for s in saved.json()] == ["STD", "STD"]
    assert saved.json()[0]["curve"] is not None  # refeita pelos parâmetros

    # salvar de novo atualiza (uma por análise + canal)
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"])]})
    assert len(user_client.get("/api/postrun/deconvolution", params={"tokens": [T1, T2]}).json()) == 2

    # 2) referência a partir das salvas
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "std", "tokens": [T1, T2]})
    assert ref.status_code == 200, ref.text
    ref = ref.json()
    assert ref["name"] == "STD" and ref["n_runs"] == 2 and len(ref["peaks"]) == 1
    assert ref["peaks"][0]["sd_mu_c"] is not None

    # 3) guiada pela referência: centro perto do da referência, deslocamento informado
    g_item = _fit(user_client, _spec(T2, mode="guided", reference_ids=[ref["id"]], tol_c=5))[0]
    assert g_item["ok"], g_item["error"]
    pk = g_item["data"]["peaks"][0]
    assert pk["name"] == "STD" and pk["reference_id"] == ref["id"]
    assert abs(pk["delta_mu_c"]) <= 5.01 and pk["delta_width_pct"] is not None

    # 4) curva com a área da gaussiana (amostra virtual) e quantificação dela
    for t, m in ((T1, 60.0), (T2, 30.0)):
        user_client.put("/api/postrun/analyses/meta", json=[{"token": t, "mass_mg": m, "composition_text": "STD"}])
    spec = {"channel": "pyro:FID", "area_source": "gaussian", "x_kind": "component_mass", "component": "STD",
            "model": "origin", "weighting": "none",
            "points": [{"region": {"token": t, "channel": "pyro:FID", "label": "", "start_idx": 300, "end_idx": 1100},
                        "gaussian": "STD"} for t in (T1, T2)]}
    prev = user_client.post("/api/postrun/curves/preview", json=spec).json()
    assert prev["error"] is None, prev
    assert prev["area_source"] == "gaussian" and all(p["u_area_s"] for p in prev["points"])
    curve = user_client.post("/api/postrun/curves", json={**spec, "name": "STD gaussiana"}).json()
    q = user_client.post("/api/postrun/quantify", json={
        "curve_id": curve["id"], "gaussians": [{"token": T2, "material": "STD"}]
    }).json()[0]
    assert q["error"] is None and q["material"] == "STD" and q["expected_mg"] == 30.0 and q["recovery_pct"] > 0

    missing = user_client.post("/api/postrun/quantify", json={
        "curve_id": curve["id"], "gaussians": [{"token": T3, "material": "STD"}]
    }).json()[0]
    assert "deconvolução por gaussiana salva" in missing["error"]

    # 5) apagar
    ids = [x["id"] for x in user_client.get("/api/postrun/deconvolution", params={"tokens": [T1]}).json()]
    user_client.put("/api/postrun/deconvolution/save", json={"delete_ids": ids})
    assert user_client.get("/api/postrun/deconvolution", params={"tokens": [T1]}).json() == []
    assert user_client.delete(f"/api/postrun/deconvolution/references/{ref['id']}").status_code == 200


def test_reference_refuses_mixed_inputs(user_client, jobs):
    user_client.put("/api/postrun/deconvolution/save", json={
        "upserts": [_spec(T1), _spec(T2, n_peaks=2)]
    })
    r = user_client.post("/api/postrun/deconvolution/references", json={"name": "X", "tokens": [T1, T2]})
    assert r.status_code == 400 and "números de picos" in r.json()["detail"]
    r = user_client.post("/api/postrun/deconvolution/references", json={"name": "X", "tokens": [T3]})
    assert r.status_code == 400 and "sem deconvolução salva" in r.json()["detail"]


def test_guided_refuses_reference_of_another_cycle(user_client, jobs):
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1)]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1]}).json()
    path = jobs / T3
    path.write_text(path.read_text(encoding="utf-8", errors="replace").replace("Rate=25", "Rate=50", 1), encoding="utf-8")
    item = _fit(user_client, _spec(T3, mode="guided", reference_ids=[ref["id"]]))[0]
    assert not item["ok"] and "outro ciclo" in item["error"]


# ------------------------------------------------------------------ molde do material puro


def _real_like(mu, area):
    """Forma "real" (núcleo estreito + base larga), como os picos do PEAD."""
    y = 0.7 * np.exp(-0.5 * ((T - mu) / 20) ** 2) + 0.3 * np.exp(-0.5 * ((T - mu + 15) / 55) ** 2)
    return y / np.trapezoid(y, T) * area


def test_template_fit_recovers_areas_shift_and_stretch():
    ta = d.build_template([(T, _real_like(700, 1e6) + rng.normal(0, 20, T.size), 700.0) for _ in range(3)])
    tb = d.build_template([(T, _real_like(560, 1e6) + rng.normal(0, 20, T.size), 560.0) for _ in range(3)])
    assert np.trapezoid(ta.density, ta.tau) == pytest.approx(1.0, rel=1e-6)
    mix = _real_like(690, 6e5) + tb.eval(T, 575, 1.05) * 4e5 + rng.normal(0, 20, T.size)
    r = d.fit_templates(T, mix, [
        d.TemplateGuess("A", ta, 700, (680, 720), (0.9, 1.1)),
        d.TemplateGuess("B", tb, 560, (540, 580), (0.9, 1.1)),
    ])
    a = {p.name: p for p in r.peaks}
    assert a["A"].area == pytest.approx(6e5, rel=0.01) and a["B"].area == pytest.approx(4e5, rel=0.01)
    assert a["A"].center == pytest.approx(690, abs=0.5) and a["B"].center == pytest.approx(575, abs=0.5)
    assert a["B"].stretch == pytest.approx(1.05, abs=0.01)
    assert r.r2 > 0.999 and not r.warnings


def test_gaussian_misses_the_tails_that_the_template_keeps():
    y = _real_like(700, 1e6) + rng.normal(0, 20, T.size)
    g = d.fit(T, y, d.auto_guesses(T, y, 1), "bigaussian")
    tpl = d.build_template([(T, _real_like(700, 1e6), 700.0)])
    m = d.fit_templates(T, y, [d.TemplateGuess("X", tpl, 700, (690, 710), (0.95, 1.05))])
    assert g.total_area < 0.98e6  # a gaussiana deixa as caudas de fora
    assert m.peaks[0].area == pytest.approx(1e6, rel=0.005)
    assert m.bic < g.bic


def test_template_mode_through_the_routes(user_client, jobs):
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"]), _spec(T2, names=["STD"])]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1, T2]}).json()
    assert ref["has_template"] is True
    item = _fit(user_client, _spec(T2, mode="template", reference_ids=[ref["id"]], tol_c=10, tol_width_pct=10))[0]
    assert item["ok"], item["error"]
    data = item["data"]
    pk = data["peaks"][0]
    assert pk["name"] == "STD" and pk["stretch"] is not None and abs(pk["delta_mu_c"]) < 10
    # o molde guarda a forma real: a área do componente ≈ a área integrada da janela
    assert data["total_area_s"] == pytest.approx(data["window_area_s"], rel=0.03)
    saved = user_client.put("/api/postrun/deconvolution/save", json={"upserts": [data["spec"]]}).json()[0]
    assert saved["curve"] is not None and saved["spec"]["mode"] == "template"


def test_template_mode_needs_a_reference_with_template(user_client, jobs, db_engine):
    from sqlmodel import Session

    from app.db.models import PostrunDeconvReference

    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"])]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1]}).json()
    with Session(db_engine) as s:  # simula uma referência antiga, de antes do molde
        r = s.get(PostrunDeconvReference, ref["id"])
        r.template = ""
        s.add(r)
        s.commit()
    item = _fit(user_client, _spec(T2, mode="template", reference_ids=[ref["id"]]))[0]
    assert not item["ok"] and "antes do molde" in item["error"]


def test_template_area_uncertainty_is_realistic_for_real_sized_signals():
    """Bug visto na tela: áreas ~10⁶ davam incerteza ~10⁻¹⁰ (pseudo-inversa
    descartando a direção da área). A incerteza relativa tem de ser da ordem
    do ruído relativo do sinal."""
    big = _real_like(700, 4.8e6)
    noise = 0.004 * big.max()
    tpl = d.build_template([(T, big, 700.0)])
    y = big + rng.normal(0, noise, T.size)
    r = d.fit_templates(T, y, [d.TemplateGuess("X", tpl, 700, (680, 720), (0.6, 1.4))])
    rel = r.peaks[0].u_area / r.peaks[0].area
    assert 1e-4 < rel < 1e-2


def test_template_is_aligned_by_the_signal_maximum(user_client, jobs):
    """O molde não depende da gaussiana do ajuste livre: alinhado pelo máximo
    do próprio sinal, a corrida pura contra a própria referência dá ΔTmax ≈ 0."""
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"], shape="gaussian")]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1]}).json()
    item = _fit(user_client, _spec(T1, mode="template", reference_ids=[ref["id"]], tol_c=10, tol_width_pct=10))[0]
    pk = item["data"]["peaks"][0]
    assert abs(pk["delta_mu_c"]) < 1.5 and abs(pk["delta_width_pct"]) < 1.0



def test_reference_detail_shows_mold_and_runs(user_client, jobs):
    """Aba Referências: molde, faixa entre as corridas e cada corrida contra
    o molde (dilatação natural ≈ 1, forma perto do molde)."""
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"]), _spec(T2, names=["STD"])]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1, T2]}).json()
    r = user_client.get(f"/api/postrun/deconvolution/references/{ref['id']}/detail")
    assert r.status_code == 200, r.text
    d_ = r.json()
    assert len(d_["tau"]) == len(d_["mold"]) == len(d_["sd"]) > 10
    assert d_["mold_fwhm_s"] > 0 and d_["center_s"] is not None
    assert [x["token"] for x in d_["runs"]] == [T1, T2]
    for run in d_["runs"]:
        assert run["ok"] and len(run["density"]) == len(d_["tau"])
        assert run["filename"].upper().endswith(".B00") and run["mass_mg"] is not None
        assert 0.8 < run["stretch"] < 1.25 and run["rms_pct"] < 20
    assert user_client.get("/api/postrun/deconvolution/references/99999/detail").status_code == 404


def test_remove_runs_from_reference_rebuilds_it(user_client, jobs):
    """Tirar corridas de uma referência: mesma id, refeita só com as que ficam."""
    user_client.put("/api/postrun/deconvolution/save", json={"upserts": [_spec(T1, names=["STD"]), _spec(T2, names=["STD"])]})
    ref = user_client.post("/api/postrun/deconvolution/references", json={"name": "STD", "tokens": [T1, T2]}).json()
    r = user_client.put(f"/api/postrun/deconvolution/references/{ref['id']}/runs", json={"tokens": [T2]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["id"] == ref["id"] and out["n_runs"] == 1 and out["tokens"] == [T2] and out["has_template"]
    assert out["peaks"][0]["sd_mu_c"] is None  # uma corrida só: sem desvio
    d_ = user_client.get(f"/api/postrun/deconvolution/references/{ref['id']}/detail").json()
    assert [x["token"] for x in d_["runs"]] == [T2]
    # devolver
    back = user_client.put(f"/api/postrun/deconvolution/references/{ref['id']}/runs", json={"tokens": [T1, T2]}).json()
    assert back["n_runs"] == 2
    assert user_client.put(f"/api/postrun/deconvolution/references/{ref['id']}/runs", json={"tokens": []}).status_code == 400
