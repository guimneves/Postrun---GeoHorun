"""Estudos do PostRun (pedido do usuário, 22/10/2026): guardar análises,
referências/moldes, curvas e calibrações num estudo, reabrir de uma vez,
finalizar (relatório congelado) e exportar o Excel absoluto — com a aba
`Horun_Resultados` no formato que o módulo Resultados importa. Com os `.B00`
sintéticos de tests/b00_factory.py (o padrão "STD" como "puro")."""

import io

from openpyxl import load_workbook

from tests.b00_factory import T1, T2

RESULT_HEADER = [
    "Estudo", "Método", "Amostra", "Réplica", "Composição", "Componente", "Parâmetro", "Valor", "Unidade", "U95",
    "Fração nominal (%)", "Fração real (%)", "Massa da amostra (mg)", "Data",
]


def _prepare(client):
    for t, m in ((T1, 60.0), (T2, 30.0)):
        assert client.put("/api/postrun/analyses/meta", json=[{"token": t, "mass_mg": m, "composition_text": "STD"}]).status_code == 200
    client.put("/api/postrun/regions/save", json={"upserts": [
        {"token": t, "channel": "pyro:FID", "label": "S2", "start_idx": 300, "end_idx": 1100, "baseline_mode": "linear"}
        for t in (T1, T2)
    ]})
    ref = client.post("/api/postrun/workflow/references", json={"tokens": [T1, T2]}).json()["references"][0]["reference"]
    for method in ("gauss", "molde"):
        assert client.post("/api/postrun/workflow/fit", json={"tokens": [T1, T2], "method": method}).status_code == 200
        assert client.post("/api/postrun/workflow/curves", json={"tokens": [T1, T2], "method": method, "model": "origin"}).status_code == 200
    return ref


def test_study_collects_reopens_freezes_and_exports(user_client, jobs):
    ref = _prepare(user_client)
    r = user_client.post("/api/postrun/studies", json={"name": "Puros STD", "description": "teste", "method": "molde"})
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    assert user_client.post("/api/postrun/studies", json={"name": "Puros STD"}).status_code == 409

    # guardar o workspace: análises + a referência dos puros + as curvas (dos dois métodos)
    r = user_client.post(f"/api/postrun/studies/{sid}/collect", json={"tokens": [T1, T2]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tokens"] == [T1, T2] and body["reference_ids"] == [ref["id"]] and len(body["curve_ids"]) == 2

    det = user_client.get(f"/api/postrun/studies/{sid}").json()
    assert [a["saved_methods"] for a in det["analyses"]] == [["gauss", "molde"]] * 2
    assert det["analyses"][0]["summary"]["mass_mg"] == 60.0
    assert {c["method"] for c in det["curves"]} == {"gauss", "molde"} and det["references"][0]["has_template"]

    # recuperação do estudo (método principal) e o resumo na lista
    rep = user_client.post(f"/api/postrun/studies/{sid}/report").json()
    assert not rep["frozen"] and rep["report"]["method"] == "molde" and len(rep["report"]["runs"]) == 2
    head = user_client.get("/api/postrun/studies").json()[0]["headline"]["molde"][0]
    assert head["materials"][0]["material"] == "STD" and head["materials"][0]["recovery_mean"] is not None

    # tolerância ótima: só puros aqui (nenhuma mistura com molde) — avisa, sem gravar nada
    r = user_client.post(f"/api/postrun/studies/{sid}/sensitivity", json={"tolerances": [20, 40]})
    assert r.status_code == 400 and "mistura" in r.json()["detail"]

    # não apaga por baixo do estudo
    curve_id = body["curve_ids"][0]
    r = user_client.delete(f"/api/postrun/curves/{curve_id}")
    assert r.status_code == 409 and "Puros STD" in r.json()["detail"]
    assert user_client.delete(f"/api/postrun/deconvolution/references/{ref['id']}").status_code == 409

    # finalizar: relatório congelado, itens travados
    r = user_client.put(f"/api/postrun/studies/{sid}", json={"status": "finalizado"})
    assert r.status_code == 200 and r.json()["finalized_at"]
    rep2 = user_client.post(f"/api/postrun/studies/{sid}/report", params={"method": "gauss"}).json()
    assert rep2["frozen"] and rep2["report"]["method"] == "gauss"
    assert user_client.post(f"/api/postrun/studies/{sid}/items", json={"remove": {"tokens": [T2]}}).status_code == 409

    # Excel absoluto
    r = user_client.get(f"/api/postrun/studies/{sid}/export.xlsx")
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content), read_only=True)
    for name in ("Sobre", "Horun_Resultados", "Recuperação (médias)", "Réplicas", "Análises", "Curvas de calibração",
                 "Pontos das curvas", "Referências", "Moldes (pontos)", "Puros dos moldes", "Deconvoluções (pontos)",
                 "Deconvoluções (picos)", "Sinais FID (pirólise)"):
        assert name in wb.sheetnames, name
    about = {row[0]: row[1] for row in wb["Sobre"].iter_rows(min_row=2, values_only=True)}
    assert about["formato"] == "horun-postrun-estudo" and about["versao"] == 1 and about["metodo"] == "molde"
    rows = list(wb["Horun_Resultados"].iter_rows(values_only=True))
    assert list(rows[0]) == RESULT_HEADER
    rec = [r_ for r_ in rows[1:] if r_[1] == "molde" and r_[6] == "Recuperação" and r_[5] == "STD"]
    assert len(rec) == 2 and all(isinstance(r_[7], float) for r_ in rec) and rec[0][10] == 100.0
    assert len(list(wb["Pontos das curvas"].iter_rows(min_row=2))) == 4  # 2 pontos × 2 curvas
    assert len(list(wb["Sinais FID (pirólise)"].iter_rows(min_row=2))) > 1000
    assert len(list(wb["Moldes (pontos)"].iter_rows(min_row=2))) > 10

    # reabrir e tirar uma análise; apagar o estudo libera as curvas
    assert user_client.put(f"/api/postrun/studies/{sid}", json={"status": "aberto"}).json()["finalized_at"] is None
    out = user_client.post(f"/api/postrun/studies/{sid}/items", json={"remove": {"tokens": [T2]}}).json()
    assert out["tokens"] == [T1]
    assert user_client.delete(f"/api/postrun/studies/{sid}").status_code == 200
    assert user_client.delete(f"/api/postrun/curves/{curve_id}").status_code == 200
