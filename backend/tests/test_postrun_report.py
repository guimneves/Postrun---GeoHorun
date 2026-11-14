"""Relatório de recuperação e interferência do PostRun (Fase 4, pedido do
usuário de 16/10/2026), com os `.B00` sintéticos de tests/b00_factory.py
(STD puro a 60 e 30 mg; mistura STD + X, 40 mg, metade de cada)."""

import io

import pytest
from openpyxl import load_workbook

from tests.b00_factory import T1, T2, T3


def _spec(token, **extra):
    return {"token": token, "channel": "pyro:FID", "start_idx": 300, "end_idx": 1100, "baseline_mode": "linear",
            "shape": "gaussian", "mode": "free", "n_peaks": 1, **extra}


def _setup(client):
    for t, m, comp in ((T1, 60.0, "STD"), (T2, 30.0, "STD"), (T3, 40.0, "STD 50, X 50")):
        r = client.put("/api/postrun/analyses/meta", json=[{"token": t, "mass_mg": m, "composition_text": comp}])
        assert r.status_code == 200, r.text
    r = client.put("/api/postrun/deconvolution/save", json={"upserts": [
        _spec(T1, names=["STD"]), _spec(T2, names=["STD"]), _spec(T3, n_peaks=2, names=["STD", "X"]),
    ]})
    assert r.status_code == 200, r.text
    spec = {"channel": "pyro:FID", "area_source": "gaussian", "x_kind": "component_mass", "component": "STD",
            "model": "origin", "weighting": "none",
            "points": [{"region": {"token": t, "channel": "pyro:FID", "label": "", "start_idx": 300, "end_idx": 1100},
                        "gaussian": "STD"} for t in (T1, T2)]}
    curve = client.post("/api/postrun/curves", json={**spec, "name": "STD gaussiana"})
    assert curve.status_code == 200, curve.text
    return curve.json()


def test_recovery_report_groups_replicates(user_client, jobs):
    curve = _setup(user_client)
    r = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1, T2, T3, "Outro/x.B00"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["reason"] for s in body["skipped"]] == ["sem deconvolução por gaussiana salva"]
    assert body["missing_curves"] == ["X"]
    assert [c["id"] for c in body["curves"]] == [curve["id"]]

    keys = [g["key"] for g in body["groups"]]
    assert keys == ["STD 50 % · X 50 %", "STD 100 %"]  # misturas primeiro
    pure = body["groups"][1]
    assert pure["n_runs"] == 2
    std = pure["materials"][0]
    assert std["material"] == "STD" and std["recovery_pct"]["n"] == 2
    assert std["recovery_pct"]["mean"] is not None and std["recovery_pct"]["sd"] is not None
    assert std["recovery_pct"]["mean"] == pytest.approx(100.0, abs=3)  # área do S2 = YIELD × massa
    assert pure["total_recovery_pct"]["n"] == 2

    mix = body["groups"][0]
    mats = {m["material"]: m for m in mix["materials"]}
    assert mats["STD"]["fraction"] == 0.5 and mats["STD"]["expected_mg"]["mean"] == 20.0
    assert mats["X"]["recovery_pct"]["n"] == 0  # sem curva para X
    run = next(x for x in body["runs"] if x["token"] == T3)
    assert run["total_recovery_pct"] is None  # nem todo componente quantificado
    assert {m["material"] for m in run["materials"]} == {"STD", "X"}
    found = next(m for m in run["materials"] if m["material"] == "STD")
    assert found["found_mg"] == pytest.approx(20.0, rel=0.05)  # metade dos 40 mg da mistura


def test_recovery_report_curve_override_and_cycle(user_client, jobs):
    curve = _setup(user_client)
    r = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1], "curve_ids": {"STD": curve["id"] + 999}})
    assert r.json()["missing_curves"] == ["STD"]  # curva escolhida não existe: não troca por outra


def test_recovery_report_excel(user_client, jobs):
    _setup(user_client)
    r = user_client.post("/api/postrun/report/recovery.xlsx", json={"tokens": [T1, T2, T3]})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    wb = load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames[:5] == ["Resumo", "Corridas", "Curvas", "Referências", "Deconvoluções"]
    assert "Fora do relatório" in wb.sheetnames
    resumo = list(wb["Resumo"].iter_rows(values_only=True))
    assert resumo[0][0] == "Mistura" and len(resumo) == 1 + 3  # STD+X da mistura, STD do puro
    corridas = list(wb["Corridas"].iter_rows(values_only=True))
    assert len(corridas) == 1 + 4  # T1, T2 (STD) e T3 (STD, X)


def test_real_component_masses_drive_expected_and_keep_grouping(user_client, jobs):
    """24/10/2026: "50-50" nominal não é exatamente 50-50 — com as massas
    reais pesadas de cada polímero, a esperada é a massa real; as réplicas
    continuam agrupadas pela composição nominal."""
    _setup(user_client)
    r = user_client.put("/api/postrun/analyses/meta", json=[{"token": T3, "component_masses_text": "STD 21,5; X 19,0"}])
    assert r.status_code == 200, r.text
    assert r.json()[0]["component_masses"] == {"STD": 21.5, "X": 19.0}
    bad = user_client.put("/api/postrun/analyses/meta", json=[{"token": T3, "component_masses_text": "STD 21,5, X 19,0"}])
    assert bad.status_code == 400 and ";" in bad.json()["detail"]

    body = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1, T2, T3]}).json()
    assert [g["key"] for g in body["groups"]] == ["STD 50 % · X 50 %", "STD 100 %"]
    run = next(x for x in body["runs"] if x["token"] == T3)
    std = next(m for m in run["materials"] if m["material"] == "STD")
    assert std["expected_mg"] == 21.5 and std["expected_source"] == "massa real pesada"
    assert std["real_fraction"] == pytest.approx(21.5 / 40.5) and std["fraction"] == 0.5
    assert std["recovery_pct"] == pytest.approx(100 * std["found_mg"] / 21.5)
    assert run["component_masses"] == {"STD": 21.5, "X": 19.0}
    # soma das massas reais (40,5) ≠ massa da corrida (40) por mais de 3 %? não: 1,25 % — sem aviso
    assert not any("soma das massas" in f for m in run["materials"] for f in m["flags"])

    # tirar as massas reais: volta à fração nominal × massa
    user_client.put("/api/postrun/analyses/meta", json=[{"token": T3, "component_masses_text": ""}])
    body = user_client.post("/api/postrun/report/recovery", json={"tokens": [T3]}).json()
    std = next(m for m in body["runs"][0]["materials"] if m["material"] == "STD")
    assert std["expected_mg"] == 20.0 and std["expected_source"] != "massa real pesada"
