# Backend coverage

Measured with `python -m pytest tests/ -q --cov=backend --cov-report=term-missing`
(pytest runs in the main thread, so coverage records it; the QA harness uses a
worker-thread pool, which coverage does not record without
`concurrency=thread`, so harness-only paths are under-reported there).

**Total: 72%** (3256 statements, 917 missed). Up from 71% before the
re-audit fixes: the new session regression test lifted `session.py`
83%→87%, the waveform bisect/cap and textio pre-scan tests lifted
`waveform.py` 89%→90% and `simulator.py` 50%→52%, and deleting the dead
`default_stimuli` lifted `testbench_gen.py` 69%→71%.

| Module | Stmts | Miss | Cover | Notes |
| --- | ---: | ---: | ---: | --- |
| `qsf_parser.py` | 115 | 4 | 97% | untested: a few malformed-token branches |
| `waveform.py` | 262 | 26 | 90% | untested: exotic VCD timescale/scope paths; bisect + decimation + textio scan covered by unit tests |
| `device.py` | 112 | 14 | 88% | untested: error branches for corrupt board.json |
| `session.py` | 318 | 40 | 87% | untested: WebSocket edge cases; per-run generation guards covered by the N1 regression test |
| `server.py` | 238 | 39 | 84% | untested: several HTTP error/edge routes |
| `vhdl_parser.py` | 359 | 60 | 83% | untested: rare syntax/attribute branches |
| `vcd_parser.py` | 157 | 27 | 83% | untested: malformed-VCD defensive branches |
| `board_detect.py` | 61 | 12 | 80% | untested: generic-SCL/SDA fallback branches |
| `peripherals.py` | 153 | 32 | 79% | untested: UART framing-error/VGA edge branches |
| `ghdl_tool.py` | 141 | 39 | 72% | untested: tool-discovery/error branches |
| `testbench_gen.py` | 415 | 119 | 71% | untested: stimulus kinds, generate loops; dead `default_stimuli` removed |
| `simulator.py` | 800 | 382 | 52% | the GHDL run path is exercised by the QA harness, not pytest; textio pre-scan + PLL estimator covered by unit tests |
| `__main__.py` | 123 | 123 | 0% | CLI entry point, not imported by tests |

Untested branches are mostly defensive error paths (corrupt input, missing
tool, malformed VCD) and the CLI. The behavioural core (parsers, decoders,
profile, testbench generation) is above 71%.
