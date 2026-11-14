"""Calibração de área -> mg no PostRun — contra os `.B00` sintéticos do
padrão "STDA" (tests/b00_factory.py), com o padrão certificado cadastrado
no catálogo do RE7S (falso, `re7s.add_standard`). A referência de massa é o
**S2** (não S1+S2), com fonte primária no `standard.ini` e o catálogo
certificado como reserva."""

import pytest

from tests.b00_factory import SPECS, T1, T2

S2_CERT, TMAX_CERT = 10.0, 440.0  # valores "certificados" inventados para o STDA


@pytest.fixture(autouse=True)
def _jobs_dir(jobs):
    return jobs


def _create_standard(re7s, name="STDA"):
    return re7s.add_standard(name, {"S1": 0.2, "S2": S2_CERT, "Tmax": TMAX_CERT})


def _write_standard_ini(name="STDA", s2=12.9, tmax=443.0):
    """Grava um standard.ini onde o módulo procura (jobs_dir/standard.ini,
    já apontado para a pasta temporária pela fixture `jobs`)."""
    from app.core import config as config_module

    content = f'[STD2]\nstdName = "{name}"\nstdTmax = {tmax:.6f}\nstdS2 = {s2:.6f}\n'
    config_module.settings.standard_ini_path.write_text(content, encoding="utf-8")


def test_standards_catalog_comes_from_re7s(user_client, re7s):
    _create_standard(re7s)
    r = user_client.get("/api/postrun/standards")
    assert r.status_code == 200, r.text
    assert [(s["name"], s["kind"]) for s in r.json()] == [("STDA", "verification")]

    re7s.down = True
    r = user_client.get("/api/postrun/standards")
    assert r.status_code == 502 and "RE7S" in r.json()["detail"]


def test_standards_catalog_empty_without_re7s(user_client, monkeypatch):
    from app.core import config as config_module
    from app.modules import re7s_link

    monkeypatch.setattr(config_module.settings, "re7s_url", "")
    re7s_link.set_backend(None)  # padrão da configuração: sem RE7S
    assert user_client.get("/api/postrun/standards").json() == []


def test_candidate_uses_s2_from_catalog_when_not_in_standard_ini(user_client, re7s):
    standard_id = _create_standard(re7s)
    spec = SPECS[T1]

    r = user_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "pyro:FID", "standard_id": standard_id,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # cursor auto_1 gravado no arquivo -> min/max
    assert body["start_idx"] == min(spec.fid_cursor)
    assert body["end_idx"] == max(spec.fid_cursor)
    assert body["mass_mg"] == pytest.approx(spec.quant_mg)
    # só S2, não S1+S2
    assert body["known_mg"] == pytest.approx(S2_CERT * spec.quant_mg / 1000, rel=1e-6)
    assert body["reference_source"] == "catálogo"
    assert body["tmax_certified"] == pytest.approx(TMAX_CERT)
    # temperatura no pico do FID = centro da gaussiana gerada
    assert body["tmax_measured"] == pytest.approx(spec.s2_peaks[0].center_c, abs=1.5)
    assert body["suggested_k1"] == pytest.approx(body["known_mg"] / body["area"], rel=1e-9)


def test_candidate_prefers_standard_ini_for_s2_and_tmax(user_client, re7s):
    standard_id = _create_standard(re7s, name="STDA")
    _write_standard_ini(name="STDA", s2=12.9, tmax=443.0)

    r = user_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "pyro:FID", "standard_id": standard_id,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reference_source"] == "standard.ini"
    assert body["known_mg"] == pytest.approx(12.9 * SPECS[T1].quant_mg / 1000, rel=1e-6)  # o S2 do .ini
    assert body["tmax_certified"] == pytest.approx(443.0)


def test_candidate_404_for_unknown_standard(user_client):
    r = user_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "pyro:FID", "standard_id": 99999,
    })
    assert r.status_code == 404, r.text


def test_candidate_502_when_re7s_is_down(user_client, re7s):
    standard_id = _create_standard(re7s)
    re7s.down = True
    r = user_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "pyro:FID", "standard_id": standard_id,
    })
    assert r.status_code == 502, r.text


def test_candidate_400_for_channel_without_certified_parameters(user_client, re7s):
    """Só pyro:FID tem parâmetro de massa configurado (S2) — outro canal não
    tem candidato automático."""
    standard_id = _create_standard(re7s)
    r = user_client.get("/api/postrun/calibration/candidate", params={
        "token": T1, "channel": "oxi:CO2", "standard_id": standard_id,
    })
    assert r.status_code == 400, r.text


def test_create_calibration_gain_mode_single_point(user_client, re7s):
    standard_id = _create_standard(re7s)
    r = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain",
        "points": [{"token": T1, "standard_id": standard_id}],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "gain"
    assert body["k0"] == 0.0
    assert body["k1"] > 0
    assert body["r2"] is None
    assert len(body["source_points"]) == 1
    assert body["source_points"][0]["standard_name"] == "STDA"


def test_create_calibration_gain_mode_rejects_wrong_point_count(user_client, re7s):
    standard_id = _create_standard(re7s)
    r = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain",
        "points": [
            {"token": T1, "standard_id": standard_id},
            {"token": T2, "standard_id": standard_id},
        ],
    })
    assert r.status_code == 400, r.text


def test_create_calibration_linear_mode_two_points(user_client, re7s):
    standard_id = _create_standard(re7s)
    r = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "linear",
        "points": [
            {"token": T1, "standard_id": standard_id},
            {"token": T2, "standard_id": standard_id},
        ],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "linear"
    assert body["r2"] is not None
    assert len(body["source_points"]) == 2


def test_create_calibration_linear_mode_requires_two_points(user_client, re7s):
    standard_id = _create_standard(re7s)
    r = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "linear",
        "points": [{"token": T1, "standard_id": standard_id}],
    })
    assert r.status_code == 400, r.text


def test_list_calibrations_orders_newest_first(user_client, re7s):
    standard_id = _create_standard(re7s)
    first = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain",
        "points": [{"token": T1, "standard_id": standard_id}],
    }).json()
    second = user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain",
        "points": [{"token": T2, "standard_id": standard_id}],
    }).json()

    r = user_client.get("/api/postrun/calibration", params={"channel": "pyro:FID"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 2
    assert body[0]["id"] == second["id"]  # mais recente primeiro = vigente
    assert body[1]["id"] == first["id"]


def test_region_gains_calibrated_value_once_calibration_is_validated(user_client, re7s):
    standard_id = _create_standard(re7s)
    spec = SPECS[T1]

    region = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "teste",
        "start_idx": min(spec.fid_cursor), "end_idx": max(spec.fid_cursor),
        "baseline_mode": "fixed", "fixed_baseline": spec.fid_base,
    }).json()
    assert region["calibrated_mg"] is None  # sem calibração vigente ainda

    user_client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain",
        "points": [{"token": T2, "standard_id": standard_id}],
    })

    listed = user_client.get("/api/postrun/regions", params={"tokens": [T1]}).json()
    updated = listed[0]
    assert updated["calibrated_mg"] is not None
    # calibrada com a réplica de 30 mg; a de 60 mg tem o dobro do S2: o mesmo S2 por grama
    assert updated["calibrated_mg"] == pytest.approx(S2_CERT * spec.quant_mg / 1000, rel=0.03)
    expected_mass_g = spec.quant_mg / 1000
    assert updated["calibrated_mg_per_g"] == pytest.approx(updated["calibrated_mg"] / expected_mass_g, rel=1e-6)


def _gain(client, standard_id, token=T1, **extra):
    r = client.post("/api/postrun/calibration", json={
        "channel": "pyro:FID", "mode": "gain", "points": [{"token": token, "standard_id": standard_id}], **extra,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_calibration_name_and_run_date(user_client, re7s):
    """Nome escolhido e a data em que o padrão rodou."""
    standard_id = _create_standard(re7s)
    c = _gain(user_client, standard_id, name="  STDA — julho/2026 ", notes="padrão do lote 3")
    assert c["name"] == "STDA — julho/2026" and c["notes"] == "padrão do lote 3"
    assert c["is_active"] is True
    # o .B00 sintético é de 17/07/2026
    assert c["run_date_min"].startswith("2026-07-17") and c["source_points"][0]["run_date"].startswith("2026-07-17")

    r = user_client.patch(f"/api/postrun/calibration/{c['id']}", json={"name": "renomeada"})
    assert r.status_code == 200 and r.json()["name"] == "renomeada"


def test_saving_an_old_calibration_without_replacing_the_active_one(user_client, re7s):
    standard_id = _create_standard(re7s)
    current = _gain(user_client, standard_id, name="vigente")
    old = _gain(user_client, standard_id, token=T2, name="agosto", make_active=False)
    assert old["is_active"] is False
    listed = {c["name"]: c for c in user_client.get("/api/postrun/calibration", params={"channel": "pyro:FID"}).json()}
    assert listed["vigente"]["is_active"] and not listed["agosto"]["is_active"]

    r = user_client.patch(f"/api/postrun/calibration/{old['id']}", json={"make_active": True})
    assert r.json()["is_active"] is True
    listed = {c["name"]: c for c in user_client.get("/api/postrun/calibration", params={"channel": "pyro:FID"}).json()}
    assert listed["agosto"]["is_active"] and not listed["vigente"]["is_active"]
    assert current["id"] != old["id"]
    assert user_client.patch("/api/postrun/calibration/9999", json={"name": "x"}).status_code == 404
