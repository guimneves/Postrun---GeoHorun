"""Aba Deconvolução (pedido do usuário, 17/10/2026): o processo inteiro em
passos — puros → referência e molde, ajustar (gaussiana ou molde), curvas,
recuperação — com gaussiana e molde salvos lado a lado. Com os `.B00` sintéticos de
tests/b00_factory.py (padrão "STD", um pico só, usado como "puro")."""

import pytest

from tests.b00_factory import T1, T2, T3


def _region(token):
    return {"token": token, "channel": "pyro:FID", "label": "S2", "start_idx": 300, "end_idx": 1100,
            "baseline_mode": "linear"}


def test_whole_flow_keeps_gauss_and_mold_side_by_side(user_client, jobs):
    for t, m, comp in ((T1, 60.0, "STD"), (T2, 30.0, "STD"), (T3, 20.0, "STD 50, PS 50")):
        assert user_client.put("/api/postrun/analyses/meta", json=[{"token": t, "mass_mg": m, "composition_text": comp}]).status_code == 200
    tokens = [T1, T2, T3]
    # sem região: o passo 1 avisa
    r = user_client.post("/api/postrun/workflow/references", json={"tokens": tokens}).json()
    assert all(not i["ok"] and "região" in i["error"] for i in r["items"]) and r["references"] == []

    user_client.put("/api/postrun/regions/save", json={"upserts": [_region(t) for t in tokens]})
    st = user_client.get("/api/postrun/workflow/status", params={"tokens": tokens}).json()
    kinds = {x["token"]: (x["kind"], x["material"], x["has_region"]) for x in st["runs"]}
    assert kinds[T1] == ("pure", "STD", True) and kinds[T3][0] == "mixture"

    # 1) puros → referência com molde (a mistura não entra)
    r = user_client.post("/api/postrun/workflow/references", json={"tokens": tokens})
    assert r.status_code == 200, r.text
    body = r.json()
    assert {i["token"] for i in body["items"]} == {T1, T2} and all(i["ok"] for i in body["items"])
    (ref,) = body["references"]
    assert ref["ok"] and ref["material"] == "STD" and ref["reference"]["n_runs"] == 2 and ref["reference"]["has_template"]
    # de novo: refaz a mesma referência (mesma id)
    again = user_client.post("/api/postrun/workflow/references", json={"tokens": [T1, T2]}).json()["references"][0]
    assert again["updated"] and again["reference"]["id"] == ref["reference"]["id"]

    # tirar uma corrida à mão: o passo 1 não a devolve; "devolver" traz de volta
    rid = ref["reference"]["id"]
    out = user_client.put(f"/api/postrun/deconvolution/references/{rid}/runs", json={"tokens": [T2]}).json()
    assert out["excluded"] == [T1]
    again = user_client.post("/api/postrun/workflow/references", json={"tokens": [T1, T2]}).json()["references"][0]
    assert again["reference"]["n_runs"] == 1 and again["n_excluded"] == 1
    back = user_client.put(f"/api/postrun/deconvolution/references/{rid}/runs", json={"tokens": [T2, T1]}).json()
    assert back["excluded"] == [] and back["n_runs"] == 2

    # 2) ajustar nos dois métodos — a mistura falha (falta a referência de PS)
    for method in ("gauss", "molde"):
        r = user_client.post("/api/postrun/workflow/fit", json={"tokens": tokens, "method": method})
        assert r.status_code == 200, r.text
        res = {i["token"]: i for i in r.json()}
        assert res[T1]["ok"] and res[T2]["ok"], res
        assert not res[T3]["ok"] and "PS" in res[T3]["error"]
    # molde: o puro sobreposto (mesma área) e as larguras em °C, para ver a dilatação
    mold1 = user_client.get("/api/postrun/deconvolution", params={"tokens": [T1], "method": "molde"}).json()[0]
    assert len(mold1["curve"]["pure_components"]) == 1 and len(mold1["curve"]["temps"]) == len(mold1["curve"]["idx"])
    pk = mold1["peaks"][0]
    assert pk["fwhm_c"] and pk["pure_fwhm_c"]
    assert pk["fwhm_c"] / pk["pure_fwhm_c"] == pytest.approx(pk["stretch"], rel=0.05)
    st = user_client.get("/api/postrun/workflow/status", params={"tokens": tokens}).json()
    run1 = next(x for x in st["runs"] if x["token"] == T1)
    assert set(run1["saved"]) == {"gauss", "molde"} and run1["saved"]["molde"]["mode"] == "template"
    # a lista do painel filtra pelo método
    only_mold = user_client.get("/api/postrun/deconvolution", params={"tokens": [T1], "method": "molde"}).json()
    assert [d["method"] for d in only_mold] == ["molde"]

    # 3) curvas automáticas, uma por método
    for method in ("gauss", "molde"):
        r = user_client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": method, "model": "origin"})
        assert r.status_code == 200, r.text
        (c,) = r.json()
        assert c["ok"], c
        assert c["curve"]["method"] == method and c["curve"]["n_points"] == 2
    again = user_client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": "molde", "model": "origin"}).json()[0]
    assert again["updated"]

    # 4) recuperação por método — cada um usa a curva do próprio método
    for method in ("gauss", "molde"):
        rep = user_client.post("/api/postrun/report/recovery", json={"tokens": [T1, T2], "method": method})
        assert rep.status_code == 200, rep.text
        body = rep.json()
        assert body["method"] == method and not body["missing_curves"], body
        # dilatação natural dos puros (faixa do gráfico Δlargura × fração)
        nat = body["natural_width"]["STD"]
        assert nat["n"] == 2 and nat["mean"] is not None
        assert {c["name"] for c in body["curves"]} == {f"STD · {'gaussiana' if method == 'gauss' else 'molde'} (automática)"}
        assert all(r_["materials"][0]["recovery_pct"] for r_ in body["runs"])


def test_mixture_without_ratio_is_fitted_and_quantified_without_recovery(user_client, jobs):
    """Composição sem proporção ("STD, PS" — 16/11/2026): o ajuste usa as
    referências dos componentes e o relatório dá a massa encontrada, sem
    recuperação (não há massa esperada)."""
    for t, m, comp in ((T1, 60.0, "STD"), (T2, 30.0, "PS"), (T3, 20.0, "STD, PS")):
        assert user_client.put("/api/postrun/analyses/meta", json=[{"token": t, "mass_mg": m, "composition_text": comp}]).status_code == 200
    tokens = [T1, T2, T3]
    user_client.put("/api/postrun/regions/save", json={"upserts": [_region(t) for t in tokens]})
    st = user_client.post("/api/postrun/workflow/status", json={"tokens": tokens}).json()
    run3 = next(x for x in st["runs"] if x["token"] == T3)
    assert run3["kind"] == "no_ratio" and run3["components"] == ["STD", "PS"]
    assert run3["composition_status"] == "sem_proporcao" and run3["composition"] is None

    assert user_client.post("/api/postrun/workflow/references", json={"tokens": tokens}).status_code == 200
    res = {i["token"]: i for i in user_client.post("/api/postrun/workflow/fit", json={"tokens": tokens, "method": "molde"}).json()}
    assert res[T3]["ok"], res[T3]
    user_client.post("/api/postrun/workflow/curves", json={"tokens": tokens, "method": "molde", "model": "origin"})
    body = user_client.post("/api/postrun/report/recovery", json={"tokens": [T3], "method": "molde"}).json()
    (run,) = body["runs"]
    assert run["group"] == "STD + PS (sem proporção)"
    assert {m["material"] for m in run["materials"]} <= {"STD", "PS"}
    assert all(m["recovery_pct"] is None and m["expected_mg"] is None for m in run["materials"])
    assert all("material fora da composição" not in m["flags"] for m in run["materials"])


def test_status_by_post_lists_every_open_analysis_even_with_a_broken_one(user_client, jobs, monkeypatch):
    """Com 44 análises abertas a aba mostrava só 1 (a lista ia na URL); agora
    vai no corpo, e uma análise com problema vira uma linha com o erro."""
    from app.api import routes_postrun_workflow as wf

    (jobs / "Quebrado").mkdir()
    bad = "Quebrado/BULK ROCK/x.B00"
    (jobs / "Quebrado" / "BULK ROCK").mkdir()
    (jobs / bad).write_text("isto não é um .B00", encoding="latin-1")
    tokens = [T1, T2, T3, bad]
    st = user_client.post("/api/postrun/workflow/status", json={"tokens": tokens})
    assert st.status_code == 200, st.text
    runs = {r["token"]: r for r in st.json()["runs"]}
    assert set(runs) == set(tokens) and runs[bad]["error"] and not runs[T1]["error"]

    # erro inesperado numa análise não derruba as outras
    real = wf._gather

    def flaky(session, toks, channel):
        if toks == [T2]:
            raise RuntimeError("falha inesperada")
        return real(session, toks, channel)

    monkeypatch.setattr(wf, "_gather", flaky)
    runs = {r["token"]: r for r in user_client.post("/api/postrun/workflow/status", json={"tokens": tokens}).json()["runs"]}
    assert len(runs) == 4 and "falha inesperada" in runs[T2]["error"] and runs[T1]["error"] is None
