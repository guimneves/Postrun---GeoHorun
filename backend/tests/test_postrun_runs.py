"""F4 do artigo: exclusões com motivo, metadados por corrida, histórico e o
relatório de rastreabilidade (SHA-256 dos .B00) — `.B00` sintéticos."""

import hashlib
import io

from openpyxl import load_workbook

from tests.b00_factory import T1, T2, T3
from tests.test_postrun_report import _setup

R = "/api/postrun/runs"


def test_exclusion_needs_reason_from_list_and_comment(user_client, jobs):
    assert user_client.post(f"{R}/exclude", json={"tokens": [T1], "reason": "falha", "comment": ""}).status_code == 400
    assert user_client.post(f"{R}/exclude", json={"tokens": [T1], "reason": "cansei", "comment": "x"}).status_code == 400
    r = user_client.post(f"{R}/exclude", json={"tokens": [T1], "reason": "massa_ausente", "comment": "balança desligou"})
    assert r.status_code == 200
    (rec,) = r.json()
    assert rec["excluded"] and rec["exclusion_reason_label"] == "massa ausente" and rec["excluded_by"] == "usuario1"
    assert set(user_client.get(f"{R}/reasons").json()) == {"falha", "massa_ausente", "nome_suspeito", "outro"}


def test_excluded_run_leaves_report_and_curve_with_the_reason(user_client, jobs):
    curve = _setup(user_client)
    user_client.post(f"{R}/exclude", json={"tokens": [T2], "reason": "falha", "comment": "pico cortado"})

    body = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1, T2, T3]}).json()
    sk = {s["token"]: s["reason"] for s in body["skipped"]}
    assert sk[T2] == "excluída — corrida falha: pico cortado"
    assert T2 not in {r["token"] for r in body["runs"]}

    spec = {k: curve[k] for k in ("channel", "area_source", "x_kind", "component", "model", "weighting")}
    pts = [{"region": {"token": p["token"], "channel": "pyro:FID", "label": "", "start_idx": 300, "end_idx": 1100},
            "gaussian": "STD"} for p in curve["points"]]
    prev = user_client.post("/api/postrun/curves/preview", json={**spec, "points": pts}).json()
    t2 = next(p for p in prev["points"] if p["token"] == T2)
    assert t2["error"].startswith("excluída")

    # restaurar volta tudo, e o histórico guarda as duas coisas
    assert user_client.post(f"{R}/restore", json={"tokens": [T2], "comment": "era outra corrida"}).status_code == 200
    body = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1, T2]}).json()
    assert T2 in {r["token"] for r in body["runs"]}
    log = user_client.post(f"{R}/exclusions/log", json=[T2]).json()
    assert [g["action"] for g in log] == ["restaurada", "excluida"]


def test_metadata_round_trip_and_validation(user_client, jobs):
    items = [{"token": T1, "matrix_mass_mg": 60.0, "polymer_lot": "lote A", "granulometry": "< 250 µm",
              "operator": "op", "run_date": "2026-07-17", "notes": ""}]
    assert user_client.put(f"{R}/records", json=items).status_code == 200
    (rec,) = user_client.post(f"{R}/records", json=[T1]).json()
    assert rec["matrix_mass_mg"] == 60.0 and rec["polymer_lot"] == "lote A" and rec["granulometry"] == "< 250 µm"
    bad = user_client.put(f"{R}/records", json=[{**items[0], "run_date": "17/07/2026"}])
    assert bad.status_code == 400
    (empty,) = user_client.post(f"{R}/records", json=[T2]).json()
    assert empty == {**empty, "excluded": False, "polymer_lot": ""}


def test_study_excel_has_traceability_sheets_with_sha256(user_client, jobs):
    _setup(user_client)
    s = user_client.post("/api/postrun/studies", json={"name": "rastreio", "method": "gauss"}).json()
    user_client.post(f"/api/postrun/studies/{s['id']}/collect", json={"tokens": [T1, T2, T3]})
    user_client.post(f"{R}/exclude", json={"tokens": [T3], "reason": "outro", "comment": "teste"})
    user_client.put(f"{R}/records", json=[{"token": T1, "matrix_mass_mg": 55.0, "operator": "op"}])

    r = user_client.get(f"/api/postrun/studies/{s['id']}/export.xlsx")
    assert r.status_code == 200
    wb = load_workbook(io.BytesIO(r.content), read_only=True)
    assert {"Arquivos e metadados", "Parâmetros dos ajustes", "Exclusões", "Exclusões (histórico)"} <= set(wb.sheetnames)
    files = list(wb["Arquivos e metadados"].iter_rows(values_only=True))
    head, rows = files[0], {row[0]: row for row in files[1:]}
    sha_col = head.index("SHA-256 do .B00")
    assert rows[T1][sha_col] == hashlib.sha256((jobs / T1).read_bytes()).hexdigest()
    assert rows[T1][head.index("Massa de matriz (mg)")] == 55.0
    assert rows[T3][head.index("Excluída")] == "sim"
    params = list(wb["Parâmetros dos ajustes"].iter_rows(values_only=True))
    assert len(params) > 1 and params[1][params[0].index("Início (idx)")] == 300
    about = {k: v for k, v in wb["Sobre"].iter_rows(values_only=True)}
    assert about.get("geohorun")
    excl = list(wb["Exclusões"].iter_rows(values_only=True))
    assert excl[1][0] == T3 and excl[1][1] == "outro"
