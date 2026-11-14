"""Parser do .B00 (aba PostRun) — contra os `.B00` sintéticos de
tests/b00_factory.py (2 réplicas de um padrão + 1 mistura + 1 `.B00~` órfão
que a listagem ignora). As expectativas saem dos parâmetros da geração."""

from datetime import datetime

import pytest

from tests.b00_factory import ORPHAN_BACKUP, SPECS, T1, T3, B00Spec, Peak, b00_text


def test_read_header(b00_source):
    from app.modules import postrun_b00

    header = postrun_b00.read_header(b00_source / T1)
    spec = SPECS[T1]
    assert header.sample == spec.sample == "STDA"
    assert header.method_folder == "BULK ROCK"
    assert header.cycle_name == "BASIC"
    assert header.quantity_mg == spec.quant_mg
    # [Identity] Date= é MM-DD-AAAA:HH-MM-SS
    assert header.date == datetime(2026, 7, 17, 9, 15, 30)
    assert header.cycle_pyro.rate == spec.pyro.rate and header.cycle_oxi.final_temp == spec.oxi.final_temp


def test_parse_full_curves_and_cursors(b00_source):
    from app.modules import postrun_b00

    spec = SPECS[T1]
    analysis = postrun_b00.read_full(b00_source / T1)

    assert analysis.pyro is not None
    assert len(analysis.pyro.idx) == spec.pyro.n_points
    assert analysis.pyro.idx[0] == 0 and analysis.pyro.idx[-1] == spec.pyro.n_points - 1
    assert set(analysis.pyro.channels) == {"FID", "CO", "CO2", "SO2"}
    # rampa: na posição do fim da rampa, a temperatura final do programa
    assert analysis.pyro.temp[spec.pyro.ramp_end] == pytest.approx(spec.pyro.final_temp, abs=0.2)
    # máximo do FID no centro do S2 (índice = segundos na rampa)
    fid = analysis.pyro.channels["FID"]
    peak_idx = fid.index(max(fid))
    assert peak_idx == pytest.approx(spec.s2_center_idx(spec.s2_peaks[0]), abs=2)
    assert max(fid) == pytest.approx(spec.fid_base + spec.s2_peaks[0].height(), rel=0.01)

    assert analysis.oxi is not None
    assert len(analysis.oxi.idx) == spec.oxi.n_points
    assert "FID" not in analysis.oxi.channels  # sem chama na oxidação

    fid_cursor = analysis.cursors_auto["pyro:FID"]
    assert fid_cursor.values == spec.fid_cursor
    assert fid_cursor.base == spec.fid_base
    assert analysis.cursors_manu["pyro:FID"].values == spec.fid_cursor
    assert set(analysis.cursors_auto) == {"pyro:FID", "pyro:CO", "pyro:CO2", "pyro:SO2", "oxi:CO", "oxi:CO2", "oxi:SO2"}

    assert analysis.baseline["pyro:FID"] == spec.fid_base
    assert analysis.gas_names["gas4"] == "NA"


def test_parse_mixture_has_two_s2_maxima(b00_source):
    from app.modules import postrun_b00

    spec = SPECS[T3]
    analysis = postrun_b00.read_full(b00_source / T3)
    assert analysis.header.sample == "MIXX"
    assert analysis.header.quantity_mg == spec.quant_mg
    fid = analysis.pyro.channels["FID"]
    for peak in spec.s2_peaks:
        i = round(spec.s2_center_idx(peak))
        window = fid[i - 15:i + 16]
        assert max(window) == max(fid[i - 40:i + 41])  # máximo local perto de cada centro


def test_generator_is_deterministic():
    spec = B00Spec(sample="X", quant_mg=1.0, date=datetime(2026, 1, 2, 3, 4, 5), s2_peaks=(Peak(450, 40, 1e6),), seed=5)
    assert b00_text(spec) == b00_text(spec)
    assert b00_text(spec) != b00_text(B00Spec(**{**spec.__dict__, "seed": 6}))
    assert "\r\n" in b00_text(spec) and b00_text(spec).isascii()


def test_list_analyses_excludes_backup_tilde_files(b00_source):
    from app.modules import postrun_b00

    found = postrun_b00.list_analyses(b00_source)
    names = {p.name for p in found}
    assert "RE7_MIXX_0_11052026.B00" in names
    assert ORPHAN_BACKUP.rsplit("/", 1)[1] not in names
    assert all(not n.endswith("~") for n in names)
    assert len(found) == 3


def test_parse_header_rejects_non_b00_text():
    from app.modules import postrun_b00

    with pytest.raises(postrun_b00.B00ParseError):
        postrun_b00.parse_header("isso não é um .B00")
