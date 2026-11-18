"""Outros métodos do Rock-Eval 7S (18/11/2026): `.M00` (multi-heating
rates), `.O00` (pure oil), `.Q00` (coal)… — mesmo formato do `.B00`, outra
extensão e outra pasta de método. Entram na lista do job, abrem como um
`.B00`, renomeiam com o backup `~` junto; o multi-heating rates tem o
programa do forno em vários trechos."""

from datetime import datetime

from app.modules import analysis_rename as ar
from app.modules import postrun_b00, postrun_timebase
from tests.b00_factory import B00Spec, Peak, b00_text

MULTI = "Mix X/MULTI-HEATING RATES/2026-06-11_CHARUTO_1.M00"
OIL = "Mix X/PURE OIL/2026-06-12_OLEO_1.O00"


def _multi_text(spec: B00Spec) -> str:
    """O `[Cycle Pyro]` em trechos, como o equipamento grava no `.M00`:
    15 °C/min até 250 °C, depois 25 °C/min até 650 °C."""
    text = b00_text(spec)
    head, rest = text.split("[Cycle Pyro]", 1)
    _old, tail = rest.split("[", 1)
    block = "\r\n".join([
        "", "InitT=200", "InitIso=5", "Rate1=15.000000", "Temp1=250", "Iso1=0", "Rate2=25.000000", "Temp2=650",
        "Iso2=0", "Rate3=0.000000", "Temp3=0", "Iso3=0", "Purge=3", "NumberOfCycle=2", "", "",
    ])
    return head + "[Cycle Pyro]" + block + "[" + tail


def _add(jobs):
    spec = B00Spec(sample="CHARUTO", quant_mg=9.6, date=datetime(2026, 6, 11, 10, 0), method_folder="MULTI-HEATING RATES",
                   s2_peaks=(Peak(450.0, 40.0, 50000.0),), seed=31)
    (jobs / MULTI).parent.mkdir(parents=True, exist_ok=True)
    (jobs / MULTI).write_text(_multi_text(spec), encoding="utf-8", newline="")
    (jobs / (MULTI + "~")).write_text(_multi_text(spec), encoding="utf-8", newline="")  # backup: fica de fora
    oil = B00Spec(sample="OLEO", quant_mg=40.0, date=datetime(2026, 6, 12, 10, 0), method_folder="PURE OIL",
                  s2_peaks=(Peak(420.0, 45.0, 80000.0),), seed=32)
    (jobs / OIL).parent.mkdir(parents=True, exist_ok=True)
    (jobs / OIL).write_text(b00_text(oil), encoding="utf-8", newline="")


def test_extension_rule():
    for ok in ("a.B00", "a.M00", "a.O00", "a.q00", "x/y/2026_A_1.Q00"):
        assert postrun_b00.is_analysis_file(ok), ok
    for no in ("a.B00~", "a.M00~", "a.100", "a.B01", "a.xml", "a.B000"):
        assert not postrun_b00.is_analysis_file(no), no
    assert postrun_b00.analysis_stem("2026-06-11_X_1.M00") == "2026-06-11_X_1"


def test_multi_step_program_and_time_base(jobs):
    _add(jobs)
    a = postrun_b00.read_full(jobs / MULTI)
    prog = a.header.cycle_pyro
    assert prog is not None and prog.steps == ((15.0, 250.0, 0.0), (25.0, 650.0, 0.0))
    assert prog.rate == 25.0 and prog.final_temp == 650.0  # a rampa mais longa
    assert "15 °C/min → 250 °C" in prog.label and "25 °C/min → 650 °C" in prog.label
    assert prog.key != "200/5/25/650/0"  # não se confunde com um ciclo de uma rampa só
    # o programa de uma rampa só continua com a mesma chave de antes (curvas salvas)
    single = postrun_b00.read_full(next(jobs.rglob("*.B00"))).header.cycle_pyro
    assert single.steps == () and single.key.count("/") == 4
    assert postrun_timebase.time_base(a.pyro, prog).seconds_per_point == 1.0


def test_list_and_open_other_methods(user_client, jobs):
    _add(jobs)
    tokens = {a["token"]: a for a in user_client.get("/api/postrun/analyses", params={"job": "Mix X"}).json()}
    assert MULTI in tokens and OIL in tokens and MULTI + "~" not in tokens
    assert tokens[MULTI]["method_folder"] == "MULTI-HEATING RATES" and tokens[OIL]["method_folder"] == "PURE OIL"
    assert tokens[MULTI]["sample"] == "CHARUTO"
    r = user_client.get("/api/postrun/analyses/detail", params={"token": MULTI})
    assert r.status_code == 200, r.text


def test_rename_keeps_the_method_extension_and_backup():
    path = ar.split_token(MULTI)
    assert path.suffix == ".M00" and path.name == "2026-06-11_CHARUTO_1"
    target, moves = ar.plan(path, new_name="2026-06-11_CHARUTO_2", new_job=None)
    assert target.token == "Mix X/MULTI-HEATING RATES/2026-06-11_CHARUTO_2.M00"
    assert moves[1] == {"from": MULTI + "~", "to": target.token + "~", "optional": True}
