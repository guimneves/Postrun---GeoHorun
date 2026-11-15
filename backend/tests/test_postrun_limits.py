"""F2 do artigo: brancos de matriz e limites (LoB/LoD/LoQ de Armbruster & Pry,
LD/LQ da curva), em mg e em ppm — com `.B00` sintéticos de branco (sem S2)."""

from datetime import datetime

import pytest

from app.modules import postrun_limits
from tests.b00_factory import SPECS, T1, B00Spec, Program, write_b00
from tests.test_postrun_report import _setup

BLANK = "Brancos/BULK ROCK/2026-07-18_SILICA_{}.B00"


def test_formulas_and_ppm():
    blanks = [0.010, 0.012, 0.008, 0.011, 0.009, 0.010, 0.013, 0.007, 0.010, 0.010]
    res = postrun_limits.compute(blanks, matrix_mass_mg=60.0, curve_lod_mg=0.05, curve_loq_mg=0.15)
    lim = {x.key: x for x in res.limits}
    sd = res.blank_sd_mg
    assert lim["lob"].mg == pytest.approx(0.010 + 1.645 * sd)
    assert lim["lod"].mg == pytest.approx(lim["lob"].mg + 1.645 * sd)  # sem nível baixo: σ do branco
    assert lim["loq"].mg == pytest.approx(0.010 + 10 * sd)
    assert lim["ld_curve"].ppm == pytest.approx(0.05 / 60.0 * 1e6)  # mg ÷ mg de matriz × 10⁶ = µg/g
    assert not any("menos de 10" in w for w in res.warnings)
    assert any("baixa concentração" in w for w in res.warnings)


def test_low_level_replicates_and_few_blanks_warning():
    res = postrun_limits.compute([0.0, 0.01, -0.01], low_mg=[0.10, 0.12, 0.08], matrix_mass_mg=None)
    lim = {x.key: x for x in res.limits}
    assert lim["lod"].mg == pytest.approx(lim["lob"].mg + 1.645 * 0.02)
    assert lim["lob"].ppm is None  # sem massa de matriz, só mg
    assert any("menos de 10" in w for w in res.warnings)
    with pytest.raises(postrun_limits.LimitsError):
        postrun_limits.compute([0.01])


def _write_blanks(jobs, n: int, **changes):
    for i in range(1, n + 1):
        spec = B00Spec(sample="SILICA", quant_mg=60.0, date=datetime(2026, 7, 18, 9, i, 0), s2_peaks=(),
                       s1_area=500.0, seed=200 + i, **changes)
        write_b00(jobs / BLANK.format(i), spec)
    return [BLANK.format(i) for i in range(1, n + 1)]


def test_curve_limits_from_blank_runs(user_client, jobs):
    curve = _setup(user_client)
    blanks = _write_blanks(jobs, 10)
    other = "Brancos/BULK ROCK/2026-07-18_SILICA_rapido_1.B00"
    write_b00(jobs / other, B00Spec(sample="SILICA", quant_mg=60.0, date=datetime(2026, 7, 18), s2_peaks=(),
                                    pyro=Program(rate=50.0), seed=300))

    r = user_client.post(f"/api/postrun/curves/{curve['id']}/limits", json={"blank_tokens": [*blanks, other]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_blanks"] == 10
    assert body["matrix_mass_mg"] == 60.0 and body["matrix_mass_source"] == "média das massas dos brancos"
    bad = next(b for b in body["blanks"] if b["token"] == other)
    assert "ciclo diferente" in bad["error"]  # rampa diferente da curva: fora
    lim = {x["key"]: x for x in body["limits"]}
    # branco sem S2: massa aparente ~0 e limites pequenos perto da faixa da curva (30–60 mg)
    assert abs(body["blank_mean_mg"]) < 0.5
    assert 0 < lim["lob"]["mg"] < lim["lod"]["mg"] < lim["loq"]["mg"] < 5
    assert lim["lod"]["ppm"] == pytest.approx(lim["lod"]["mg"] / 60.0 * 1e6)
    assert body["start_idx"] == 300 and body["end_idx"] == 1100  # intervalo da curva

    saved = user_client.get(f"/api/postrun/curves/{curve['id']}").json()
    assert saved["limits"]["n_blanks"] == 10


def test_limits_permissions_and_validation(user_client, second_user_client, jobs):
    curve = _setup(user_client)
    blanks = _write_blanks(jobs, 3)
    url = f"/api/postrun/curves/{curve['id']}/limits"
    # outra pessoa pode calcular, mas não guardar na curva de quem a criou
    assert second_user_client.post(url, json={"blank_tokens": blanks, "save": False}).status_code == 200
    assert second_user_client.post(url, json={"blank_tokens": blanks}).status_code == 403
    both = user_client.post(url, json={"blank_tokens": blanks, "low_tokens": blanks[:1]})
    assert both.status_code == 400
    one = user_client.post(url, json={"blank_tokens": blanks[:1]})
    assert one.status_code == 400 and "2 brancos" in one.json()["detail"]
    assert T1 in SPECS  # o conjunto padrão continua lá
