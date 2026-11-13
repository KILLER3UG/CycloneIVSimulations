import pytest

from backend.vcd_parser import parse_vcd_text


SAMPLE = """$date
  today
$end
$timescale
  1 fs
$end
$scope module tb_counter $end
$var reg 1 ! clk $end
$var reg 8 # data[7:0] $end
$var reg 1 $ sim_done $end
$scope module uut $end
$var reg 1 % clk $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
0!
b00000000 #
0$
0%
#5000000
1!
b00000001 #
#10000000
0!
b00000010 #
1$
"""


def test_timescale_and_duration():
    data = parse_vcd_text(SAMPLE)
    assert data.timescale_ns == pytest.approx(1e-6)
    assert data.duration_ns == pytest.approx(10.0)


def test_scalar_and_vector_values():
    data = parse_vcd_text(SAMPLE)
    clk = next(s for s in data.signals if s.name == "clk" and s.scope == "tb_counter")
    assert clk.transitions == [(0.0, "0"), (5.0, "1"), (10.0, "0")]
    payload = next(s for s in data.signals if s.name == "data")
    assert payload.width == 8
    assert payload.transitions[-1] == (10.0, 2)
    assert payload.value_at(6.0) == 1


def test_bit_range_stripped_from_name():
    data = parse_vcd_text(SAMPLE)
    payload = next(s for s in data.signals if s.name == "data")
    assert payload.name == "data"
    assert payload.path == "tb_counter.data"


def test_unknown_ids_are_ignored():
    text = SAMPLE + "#15000000\n1?\n"
    data = parse_vcd_text(text)
    assert data.duration_ns == 15.0