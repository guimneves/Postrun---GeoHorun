"""Curvas de calibração massa × área do PostRun (pedido do usuário,
16/10/2026): eixo de tempo pelo ciclo, composição pelo nome, correções de
massa/composição, regressão com inversa e o quantificador.

Regressão testada com números sintéticos; as rotas, com os `.B00`
sintéticos de tests/b00_factory.py (área do S2 = YIELD × massa — a curva
tem de devolver a massa de cada corrida)."""

import math
import re

import pytest

from app.modules import postrun_b00, postrun_composition, postrun_regression, postrun_timebase
from tests.b00_factory import JOB_STD, SPECS, T1, T2, T3, YIELD


def _region(token, start=250, end=950):
    return {"token": token, "channel": "pyro:FID", "label": "S2", "start_idx": start, "end_idx": end,
            "baseline_mode": "linear", "fixed_baseline": 0}


# ------------------------------------------------------------------ ciclo e tempo


def test_cycle_program_and_one_second_per_point(b00_source):
    a = postrun_b00.read_full(b00_source / T1)
    assert a.header.cycle_pyro.rate == 25 and a.header.cycle_pyro.final_temp == 650
    assert a.header.cycle_key == "BULK ROCK | BASIC | P 300/3/25/650/0 | O 300/1/20/850/5"
    tb = postrun_timebase.time_base(a.pyro, a.header.cycle_pyro)
    assert tb.seconds_per_point == 1.0 and tb.warning is None
    assert abs(tb.estimated - 1.0) < 0.02


def test_timebase_flags_unexpected_acquisition(b00_source):
    a = postrun_b00.read_full(b00_source / T1)
    program = postrun_b00.CycleProgram(300, 3, 50, 650, 0, 3)  # o dobro da rampa gravada
    tb = postrun_timebase.time_base(a.pyro, program)
    assert tb.warning and abs(tb.seconds_per_point - 2.0) < 0.05
    assert postrun_timebase.time_base(a.pyro, None).seconds_per_point == 1.0


# ------------------------------------------------------------------ composição


@pytest.mark.parametrize(
    ("filename", "sample", "expected", "nominal"),
    [
        ("2026-10-01_PEAD_PP_PS_50-25-25_1.B00", "PEAD_PP_PS", {"PEAD": 0.5, "PP": 0.25, "PS": 0.25}, None),
        ("2026-06-19_PE+PS_1.1.B00", "PE + PS (50-50)", {"PE": 0.5, "PS": 0.5}, None),
        ("2026-08-10_PEAD_040_2.B00", "PEAD", {"PEAD": 1.0}, 4.0),
        ("2026-06-19_PS_2.1.B00", "PS", {"PS": 1.0}, None),
        ("2026-10-01_PEAD_PP_PS_33-33-33_1.B00", "x", {"PEAD": 1 / 3, "PP": 1 / 3, "PS": 1 / 3}, None),
    ],
)
def test_composition_from_names(filename, sample, expected, nominal):
    c = postrun_composition.from_names(filename, sample)
    assert c is not None and c.nominal_mass_mg == nominal
    assert c.components == pytest.approx(expected)


def test_composition_unknown_and_typed():
    # mistura sem proporção: os componentes são conhecidos, a proporção não
    no_ratio = postrun_composition.from_names("2026-06-19_PP+PS_1.B00", "PP + PS")
    assert no_ratio is not None and not no_ratio.complete and no_ratio.names == ["PP", "PS"]
    assert no_ratio.text == "PP + PS (sem proporção)"
    assert postrun_composition.parse_text("PEAD 50, PP 25, PS 25").components == pytest.approx(
        {"PEAD": 0.5, "PP": 0.25, "PS": 0.25}
    )
    assert postrun_composition.parse_text("ps").components == {"PS": 1.0}
    assert postrun_composition.parse_text("PP_PS_75-25").components == pytest.approx({"PP": 0.75, "PS": 0.25})
    typed = postrun_composition.parse_text("PP, PS")
    assert not typed.complete and typed.to_json_dict() == {"PP": None, "PS": None}
    assert postrun_composition.parse_text("PP + PS").names == ["PP", "PS"]
    with pytest.raises(postrun_composition.CompositionError):
        postrun_composition.parse_text("PP 50, PS")
    # porcentagens que não somam 100 viram proporção — e a nota diz
    odd = postrun_composition.parse_text("PP 50, PS 30")
    assert odd.components == pytest.approx({"PP": 0.625, "PS": 0.375}) and "somavam 80" in odd.note


@pytest.mark.parametrize(
    ("filename", "names", "complete"),
    [
        ("2026-07-17_PEAD_rep_2.B00", ["PEAD"], True),  # "rep" não é material: ignorado
        ("2026-07-17_PP_PS_1.B00", ["PP", "PS"], False),  # dois materiais, sem proporção
        ("2026-07-17_PE+PP+PS_3.B00", ["PE", "PP", "PS"], False),
        ("2026-07-17_Parafina4_1.B00", None, None),  # nada conhecido: não identificada
        ("2026-07-17_160k_2.B00", None, None),
        ("2026-07-17_vide_1.B00", None, None),
        ("2026-07-17_PP_PS_75_1.B00", ["PP", "PS"], False),
    ],
)
def test_composition_only_known_materials_without_ratio(filename, names, complete):
    reading = postrun_composition.read_names(filename, "")
    if names is None:
        assert reading.composition is None and "nenhum material conhecido" in reading.note
    else:
        assert reading.composition.names == names and reading.composition.complete is complete


def test_composition_learns_a_new_material():
    assert postrun_composition.from_names("2026-07-17_PBX_1.B00", "") is None
    c = postrun_composition.from_names("2026-07-17_PBX_1.B00", "", known={"PBX"})
    assert c is not None and c.components == {"PBX": 1.0}
    # com a proporção no nome, qualquer nome vale (é explícito)
    assert postrun_composition.from_names("2026-07-17_AAA_BBB_60-40_1.B00", "").components == pytest.approx(
        {"AAA": 0.6, "BBB": 0.4}
    )


# ------------------------------------------------------------------ regressão


def test_linear_fit_and_inverse_recover_mass():
    x = [0.1, 0.1, 0.5, 0.5, 1, 1, 2, 2, 4, 4]
    y = [1000 + 50000 * m + e for m, e in zip(x, [30, -30, 80, -60, 150, -120, 300, -250, 600, -500])]
    f = postrun_regression.fit(x, y, "linear", "1/x2")
    assert f.coef[1] == pytest.approx(50000, rel=0.01)
    inv = postrun_regression.inverse(f, 1000 + 50000 * 1.5)
    assert inv.x == pytest.approx(1.5, rel=0.01)
    assert 0 < inv.u < 0.1 and inv.U95 > inv.u and not inv.outside_range
    assert postrun_regression.inverse(f, 1000 + 50000 * 8).outside_range
    assert f.lod is not None and f.loq == pytest.approx(f.lod * 10 / 3.3)
    assert f.rf_cv_pct is not None


def test_origin_and_quadratic_models():
    x = [1, 1, 2, 2, 3, 3, 4, 4]
    f = postrun_regression.fit(x, [10 * m + d for m, d in zip(x, [0.2, -0.2] * 4)], "origin")
    assert f.coef[0] == pytest.approx(10, rel=0.01) and f.lod is not None
    yq = [5 + 10 * m - 0.8 * m * m for m in x]
    q = postrun_regression.fit(x, yq, "quadratic")
    assert postrun_regression.inverse(q, 5 + 10 * 2.5 - 0.8 * 6.25).x == pytest.approx(2.5, rel=1e-6)


def test_fit_errors():
    with pytest.raises(postrun_regression.FitError):
        postrun_regression.fit([1, 2], [1, 2], "linear")
    with pytest.raises(postrun_regression.FitError):
        postrun_regression.fit([0, 1, 2], [0, 1, 2], "linear", "1/x")
    with pytest.raises(postrun_regression.FitError):
        postrun_regression.fit([1, 1, 1], [1, 2, 3], "linear")


# ------------------------------------------------------------------ rotas


def _set_mass(client, token, mass, composition=None):
    body = [{"token": token, "mass_mg": mass, "composition_text": composition}]
    r = client.put("/api/postrun/analyses/meta", json=body)
    assert r.status_code == 200, r.text
    return r.json()[0]


def test_meta_corrects_mass_and_composition(user_client, jobs):
    out = _set_mass(user_client, T1, 12.5, "PEAD 50, PS 50")
    assert out["mass_mg"] == 12.5 and out["mass_source"] == "manual"
    assert out["composition"] == {"PEAD": 0.5, "PS": 0.5} and out["composition_source"] == "manual"
    listed = {a["token"]: a for a in user_client.get("/api/postrun/analyses", params={"job": JOB_STD}).json()}
    assert listed[T1]["mass_mg"] == 12.5 and listed[T2]["mass_source"] == "arquivo"
    assert listed[T2]["cycle_key"].startswith("BULK ROCK | BASIC | P 300/3/25/650/0")
    back = _set_mass(user_client, T1, None, "")
    # "STDA" não é um material conhecido — sem composição, e a tela diz por quê
    assert back["mass_source"] == "arquivo" and back["composition"] is None
    assert back["composition_status"] == "desconhecida" and "nenhum material conhecido" in back["composition_note"]
    bad = user_client.put("/api/postrun/analyses/meta", json=[{"token": T1, "composition_text": "PP 50, PS"}])
    assert bad.status_code == 400


def test_meta_composition_without_ratio_and_learned_material(user_client, jobs):
    out = _set_mass(user_client, T1, 10.0, "PP, PS")
    assert out["composition"] is None and out["components"] == ["PP", "PS"]
    assert out["composition_status"] == "sem_proporcao" and out["composition_text"] == "PP + PS (sem proporção)"
    # informar STDA numa corrida ensina o material: a outra (STDA no nome) passa a ser lida sozinha
    _set_mass(user_client, T1, 10.0, "STDA")
    listed = {a["token"]: a for a in user_client.get("/api/postrun/analyses", params={"job": JOB_STD}).json()}
    assert listed[T2]["composition"] == {"STDA": 1.0} and listed[T2]["composition_source"] == "nome do arquivo"


def _spec(points, **extra):
    return {"channel": "pyro:FID", "model": "linear", "weighting": "none",
            "points": [{"region": _region(t)} for t in points], **extra}


def test_curve_preview_save_and_quantify(user_client, jobs):
    masses = {t: SPECS[t].quant_mg for t in (T1, T2, T3)}  # 60, 30, 40 mg — área = YIELD × massa
    for t, m in masses.items():
        _set_mass(user_client, t, m)
    r = user_client.post("/api/postrun/curves/preview", json=_spec([T1, T2, T3]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None and body["fit"]["n"] == 3
    assert [p["x"] for p in body["points"]] == [60.0, 30.0, 40.0]
    assert all(p["area_s"] and p["area_per_mg"] for p in body["points"])
    assert all(p["area_per_mg"] == pytest.approx(YIELD, rel=0.01) for p in body["points"])
    assert body["cycle_key"].startswith("BULK ROCK | BASIC")

    # região ainda não salva entra direto; nada é gravado na prévia
    assert user_client.get("/api/postrun/curves").json() == []
    saved = user_client.post("/api/postrun/curves", json={**_spec([T1, T2, T3]), "name": "Teste FID"})
    assert saved.status_code == 200, saved.text
    curve = saved.json()
    assert curve["name"] == "Teste FID" and curve["fit"]["equation"].startswith("A = ")

    q = user_client.post("/api/postrun/quantify", json={"curve_id": curve["id"], "regions": [_region(T2)]})
    assert q.status_code == 200, q.text
    item = q.json()[0]
    assert item["error"] is None and item["mass_mg"] is not None and item["U95_mg"] > 0
    assert item["expected_mg"] == 30.0
    assert item["mass_mg"] == pytest.approx(30.0, rel=0.02)  # a curva devolve a massa da corrida
    assert item["recovery_pct"] == pytest.approx(100 * item["mass_mg"] / 30.0)
    assert not math.isnan(item["mass_mg"])

    other = user_client.post("/api/postrun/quantify", json={"curve_id": curve["id"], "regions": [
        {**_region(T2), "channel": "oxi:CO2"}]}).json()[0]
    assert "canal" in other["error"]

    assert user_client.delete(f"/api/postrun/curves/{curve['id']}").status_code == 200
    assert user_client.get("/api/postrun/curves").json() == []


def test_curve_by_component_uses_the_fraction(user_client, jobs):
    for t, m, comp in ((T1, 10.0, "PS 100"), (T2, 20.0, "PS 50, PEAD 50"), (T3, 40.0, "PS 25, PEAD 75")):
        _set_mass(user_client, t, m, comp)
    body = user_client.post(
        "/api/postrun/curves/preview", json=_spec([T1, T2, T3], x_kind="component_mass", component="ps")
    ).json()
    assert body["component"] == "PS"
    assert [p["x"] for p in body["points"]] == [10.0, 10.0, 10.0]
    assert body["fit"] is None and "massas iguais" in body["error"]  # um só nível de massa

    _set_mass(user_client, T3, 40.0, "PEAD 100")
    body = user_client.post(
        "/api/postrun/curves/preview", json=_spec([T1, T2, T3], x_kind="component_mass", component="PS")
    ).json()
    assert "sem PS na composição" in body["points"][2]["error"]


def test_curve_refuses_points_from_different_cycles(user_client, jobs):
    path = jobs / T3
    text = path.read_text(encoding="utf-8", errors="replace")
    path.write_text(text.replace("Rate=25", "Rate=50", 1), encoding="utf-8")
    for t, m in ((T1, 10.0), (T2, 20.0), (T3, 30.0)):
        _set_mass(user_client, t, m)
    body = user_client.post("/api/postrun/curves/preview", json=_spec([T1, T2, T3])).json()
    assert body["fit"] is None and "ciclos diferentes" in body["error"]
    saved = user_client.post("/api/postrun/curves", json={**_spec([T1, T2, T3]), "name": "x"})
    assert saved.status_code == 400

    # sem o ponto de outro ciclo, ajusta; e o quantificador recusa a análise desse ciclo
    pts = _spec([T1, T2, T3])
    pts["points"][2]["excluded"] = True
    pts["model"] = "origin"
    curve = user_client.post("/api/postrun/curves", json={**pts, "name": "x"}).json()
    item = user_client.post("/api/postrun/quantify", json={"curve_id": curve["id"], "regions": [_region(T3)]}).json()[0]
    assert "ciclo diferente" in item["error"]


def test_zero_mass_point_is_flagged(user_client, jobs):
    path = jobs / T3
    text = path.read_text(encoding="utf-8", errors="replace")
    path.write_text(re.sub(r"^Quant=.*$", "Quant=0", text, count=1, flags=re.M), encoding="utf-8")
    body = user_client.post("/api/postrun/curves/preview", json=_spec([T1, T2, T3])).json()
    assert "massa zero" in body["points"][2]["error"]


# ------------------------------------------------------------------ massa gravada no .B00 (23/10/2026)


def _quant(jobs, token):
    return re.search(r"^Quant=(.*)$", (jobs / token).read_text(encoding="latin-1"), re.M).group(1).strip()


def test_mass_edit_writes_quant_in_b00_and_back(user_client, jobs, b00_source):
    original = _quant(jobs, T1)
    out = _set_mass(user_client, T1, 12.5)
    assert _quant(jobs, T1) == "12.500"
    assert out["quantity_mg"] == 12.5 and out["mass_mg"] == 12.5 and out["file_note"] is None
    assert out["file_mass_before_mg"] == float(original)
    # o resto do arquivo não muda
    before = (b00_source / T1).read_bytes()
    after = (jobs / T1).read_bytes()
    assert len(before.splitlines()) == len(after.splitlines())
    assert [a for a, b in zip(before.splitlines(), after.splitlines()) if a != b] == [f"Quant={original}".encode()]
    # corrigir de novo guarda a ORIGINAL, não a intermediária
    out = _set_mass(user_client, T1, 13.0)
    assert out["file_mass_before_mg"] == float(original) and _quant(jobs, T1) == "13.000"
    # vazio = grava de volta a original
    back = _set_mass(user_client, T1, None)
    assert _quant(jobs, T1) == original and back["mass_source"] == "arquivo" and back["file_mass_before_mg"] is None


def test_mass_already_edited_is_synced_when_listing(user_client, jobs, db_engine):
    from sqlmodel import Session

    from app.db.models import PostrunAnalysisMeta

    original = _quant(jobs, T2)
    # correção feita antes de a tela gravar no arquivo: só no banco
    with Session(db_engine) as s:
        s.add(PostrunAnalysisMeta(token=T2, mass_mg=7.25, updated_by_id=1))
        s.commit()
    listed = {a["token"]: a for a in user_client.get("/api/postrun/analyses", params={"job": JOB_STD}).json()}
    assert _quant(jobs, T2) == "7.250"
    assert listed[T2]["quantity_mg"] == 7.25 and listed[T2]["file_mass_before_mg"] == float(original)


def test_mass_edit_when_file_cannot_be_written(user_client, jobs, monkeypatch):
    from app.api import routes_postrun

    def refuse(*_a, **_k):
        raise OSError("somente leitura")

    monkeypatch.setattr(routes_postrun, "_write_raw", refuse)
    out = _set_mass(user_client, T1, 9.0)
    assert out["mass_mg"] == 9.0 and out["mass_source"] == "manual"
    assert "não gravada no .B00" in out["file_note"] and _quant(jobs, T1) != "9.000"


def test_mass_edit_updates_cached_header(user_client, jobs, db_engine):
    """Com o Agente, a lista sai do cache: a massa nova tem de aparecer nele."""
    from sqlmodel import Session

    from app.db.models import PostrunB00Cache

    with Session(db_engine) as s:
        s.add(PostrunB00Cache(token=T1, content=(jobs / T1).read_text(encoding="latin-1")))
        s.commit()
    _set_mass(user_client, T1, 4.321)
    with Session(db_engine) as s:
        assert "Quant=4.321" in s.get(PostrunB00Cache, T1).content
