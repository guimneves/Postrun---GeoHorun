"""Rotas da aba PostRun — endpoints testados com `user_client` (sem gate de
admin) contra os `.B00` sintéticos (tests/b00_factory.py)."""

import pytest

from tests.b00_factory import JOB_MIX, JOB_STD, SPECS, T1, T2, T3

MISSING = f"{JOB_STD}/BULK ROCK/nope.B00"


@pytest.fixture(autouse=True)
def _jobs_dir(jobs):
    return jobs


def test_list_analyses_excludes_backup_and_reports_header(user_client):
    r = user_client.get("/api/postrun/analyses")
    assert r.status_code == 200, r.text
    body = r.json()
    tokens = {a["token"] for a in body}
    assert tokens == {T1, T2, T3}
    ifp1 = next(a for a in body if a["token"] == T1)
    assert ifp1["sample"] == "STDA"
    assert ifp1["job"] == JOB_STD
    assert ifp1["method_folder"] == "BULK ROCK"
    assert ifp1["quantity_mg"] == SPECS[T1].quant_mg


def test_jobs_list_counts_and_last_date_without_reading_any_b00(user_client, monkeypatch):
    from app.modules import postrun_b00

    def boom(*a, **k):
        raise AssertionError("listar jobs não pode abrir .B00")

    monkeypatch.setattr(postrun_b00, "read_header", boom)
    r = user_client.get("/api/postrun/jobs")
    assert r.status_code == 200, r.text
    # o com data no nome primeiro; "Mix X" (RE7_MIXX_0_11052026) não tem data no padrão
    assert r.json() == [
        {"name": JOB_STD, "analyses": 2, "last_date": "2026-07-17"},
        {"name": JOB_MIX, "analyses": 1, "last_date": None},
    ]


def test_list_analyses_of_one_job_only(user_client):
    r = user_client.get("/api/postrun/analyses", params={"job": JOB_MIX})
    assert r.status_code == 200, r.text
    assert [a["token"] for a in r.json()] == [T3]
    assert user_client.get("/api/postrun/analyses", params={"job": "NaoExiste"}).json() == []


@pytest.mark.parametrize("job", ["..", f"{JOB_STD}/BULK ROCK", "C:", "a\\b"])
def test_list_analyses_rejects_a_job_that_is_not_a_folder_name(user_client, job):
    assert user_client.get("/api/postrun/analyses", params={"job": job}).status_code == 400


def test_analysis_detail_returns_curves_and_cursors(user_client):
    r = user_client.get("/api/postrun/analyses/detail", params={"token": T1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sample"] == "STDA"
    assert len(body["pyro"]["idx"]) == SPECS[T1].pyro.n_points
    assert body["cursors_auto"]["pyro:FID"]["values"] == SPECS[T1].fid_cursor


def test_analysis_detail_rejects_path_traversal(user_client):
    r = user_client.get("/api/postrun/analyses/detail", params={"token": "../../../etc/passwd"})
    assert r.status_code == 400, r.text


def test_analysis_detail_404_for_unknown_token(user_client):
    r = user_client.get("/api/postrun/analyses/detail", params={"token": MISSING})
    assert r.status_code == 404, r.text


def test_requests_without_core_identity_are_refused(db_engine):
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/api/postrun/jobs").status_code == 401


def test_batch_endpoint_mixes_ok_and_error(user_client):
    r = user_client.post("/api/postrun/analyses/batch", json={"tokens": [T1, MISSING]})
    assert r.status_code == 200, r.text
    by_token = {item["token"]: item for item in r.json()}
    assert by_token[T1]["ok"] is True
    assert by_token[T1]["data"]["sample"] == "STDA"
    assert by_token[MISSING]["ok"] is False


def test_sparklines_returns_normalized_fid_minis(user_client):
    r = user_client.post("/api/postrun/analyses/sparklines", json={"tokens": [T1, MISSING]})
    assert r.status_code == 200, r.text
    by_token = {s["token"]: s for s in r.json()}

    ok = by_token[T1]
    assert ok["error"] is None
    assert len(ok["values"]) == 48
    assert min(ok["values"]) >= 0.0 and max(ok["values"]) == 1.0  # normalizado pelo próprio pico
    # o pico do FID de pirólise (S2) cai no bucket do centro da gaussiana, não no fim
    spec = SPECS[T1]
    expected_bucket = int(spec.s2_center_idx(spec.s2_peaks[0]) / spec.pyro.n_points * 48)
    assert abs(ok["values"].index(1.0) - expected_bucket) <= 1
    assert ok["values"].index(1.0) < 24

    assert by_token[MISSING]["values"] is None
    assert by_token[MISSING]["error"] is not None


def test_region_crud_and_area_computation(user_client):
    create = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "S1-ish",
        "start_idx": 180, "end_idx": 500, "baseline_mode": "fixed", "fixed_baseline": SPECS[T1].fid_base,
    })
    assert create.status_code == 200, create.text
    region = create.json()
    assert region["id"] is not None
    assert region["area"] is not None  # calculado na hora, não armazenado
    assert region["area_error"] is None

    listed = user_client.get("/api/postrun/regions", params={"tokens": [T1]})
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 1

    patched = user_client.patch(f"/api/postrun/regions/{region['id']}", json={"end_idx": 900})
    assert patched.status_code == 200, patched.text
    assert patched.json()["end_idx"] == 900
    assert patched.json()["area"] != region["area"]  # área recalculada com a nova faixa


def test_region_area_matches_the_known_gaussian(user_client):
    """Expectativa da própria geração: S2 = gaussiana de área conhecida sobre
    a linha de base do FID (1 ponto por segundo)."""
    spec = SPECS[T1]
    r = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "S2",
        "start_idx": 300, "end_idx": 900, "baseline_mode": "fixed", "fixed_baseline": spec.fid_base,
    })
    assert r.status_code == 200, r.text
    assert r.json()["area"] == pytest.approx(spec.s2_area, rel=0.01)
    assert r.json()["peak_idx"] == pytest.approx(spec.s2_center_idx(spec.s2_peaks[0]), abs=2)


def test_region_reports_peak_value_position_and_temperature(user_client):
    """Além da área, o pico (valor, índice e temperatura)."""
    create = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "S1-ish", "start_idx": 180, "end_idx": 626,
    })
    region = create.json()
    assert region["peak_value"] is not None
    assert region["peak_idx"] is not None
    assert region["peak_temp"] is not None

    detail = user_client.get("/api/postrun/analyses/detail", params={"token": T1}).json()
    pyro = detail["pyro"]
    pos = pyro["idx"].index(region["peak_idx"])
    # o valor/posição reportados batem com o máximo real da curva na faixa
    window = pyro["channels"]["FID"][pyro["idx"].index(180):pyro["idx"].index(626) + 1]
    assert region["peak_value"] == max(window)
    assert pyro["channels"]["FID"][pos] == region["peak_value"]
    assert pyro["temp"][pos] == region["peak_temp"]

    deleted = user_client.delete(f"/api/postrun/regions/{region['id']}")
    assert deleted.status_code == 200, deleted.text
    assert user_client.get("/api/postrun/regions", params={"tokens": [T1]}).json() == []


def test_apply_region_clones_definition_to_other_tokens(user_client):
    create = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "S1-ish", "start_idx": 180, "end_idx": 626,
    })
    region_id = create.json()["id"]

    applied = user_client.post("/api/postrun/regions/apply", json={
        "region_id": region_id, "target_tokens": [T2, T3],
    })
    assert applied.status_code == 200, applied.text
    clones = applied.json()
    assert {c["token"] for c in clones} == {T2, T3}
    assert all(c["label"] == "S1-ish" and c["start_idx"] == 180 and c["end_idx"] == 626 for c in clones)


def test_apply_region_is_idempotent_no_duplicates(user_client):
    """Clicar "Aplicar a todas" de novo atualiza a região existente do alvo
    em vez de duplicar, e nunca cria uma cópia da própria origem."""
    src = user_client.post("/api/postrun/regions", json={
        "token": T1, "channel": "pyro:FID", "label": "v1", "start_idx": 180, "end_idx": 500,
    }).json()

    first = user_client.post("/api/postrun/regions/apply", json={
        "region_id": src["id"], "target_tokens": [T1, T2, T3],
    })
    assert first.status_code == 200
    assert {c["token"] for c in first.json()} == {T2, T3}  # pula a própria origem

    user_client.patch(f"/api/postrun/regions/{src['id']}", json={"end_idx": 700, "label": "v2"})
    second = user_client.post("/api/postrun/regions/apply", json={
        "region_id": src["id"], "target_tokens": [T2, T3],
    })
    assert second.status_code == 200

    all_regions = user_client.get("/api/postrun/regions").json()
    per_token: dict[str, list] = {}
    for r in all_regions:
        per_token.setdefault(r["token"], []).append(r)
    assert all(len(v) == 1 for v in per_token.values()), per_token
    for r in all_regions:
        if r["token"] in (T2, T3):
            assert r["end_idx"] == 700 and r["label"] == "v2"


def test_bulk_delete_regions_clears_the_summary(user_client):
    for token in (T1, T2, T3):
        user_client.post("/api/postrun/regions", json={
            "token": token, "channel": "pyro:FID", "label": "x", "start_idx": 180, "end_idx": 626,
        })

    r = user_client.request("DELETE", "/api/postrun/regions", params={"tokens": [T1, T2]})
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2

    remaining = user_client.get("/api/postrun/regions").json()
    assert {x["token"] for x in remaining} == {T3}

    r2 = user_client.request("DELETE", "/api/postrun/regions")
    assert r2.json()["deleted"] == 1
    assert user_client.get("/api/postrun/regions").json() == []
