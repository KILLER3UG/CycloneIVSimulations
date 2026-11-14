# Mutation testing results

Generated: 2026-11-14 00:51:11
Mutations: 22  Killed: 22  Survived: 0

| ID | Injected bug | Result | Evidence |
| --- | --- | --- | --- |
| M01 | LED polarity flipped | KILLED | rc=1 1.0s FAILED tests/test_audit_units.py::test_board_profile_polarity_matches_spec - ... |
| M02 | LED1/LED2 pins swapped | KILLED | rc=1 1.2s FAILED tests/test_audit_units.py::test_structured_pins_match_pin_map - Assert... |
| M03 | SEG bit map a:0 -> a:3 (collides with d) | KILLED | rc=1 0.9s FAILED tests/test_audit_units.py::test_seg_bit_map_matches_schematic - Assert... |
| M04 | EEPROM address 0x50 -> 0x51 | KILLED | rc=1 0.8s FAILED tests/test_audit_units.py::test_eeprom_write_protect_is_modelled - ass... |
| M05 | cross-port duplicate-pin check disabled | KILLED | rc=1 1.0s FAILED tests/test_audit_units.py::test_qsf_duplicate_pin_is_an_error - Assert... |
| M06 | UART bit order reversed (MSB first) | KILLED | rc=1 0.8s FAILED tests/test_audit_units.py::test_decode_uart_lsb_first_and_baud - Asser... |
| M07 | buzzer frequency formula halved | KILLED | rc=1 0.9s FAILED tests/test_audit_units.py::test_decode_buzzer_frequency_and_silence - ... |
| M08 | AT24C08 read bit order reversed | KILLED | rc=1 1.4s FAILED: OD-04 |
| M09 | NEC lead burst 9 ms -> 8 ms | KILLED | rc=1 13.4s FAILED: PR-06 |
| M10 | PS/2 parity inverted (even instead of odd) | KILLED | rc=1 3.9s FAILED: PR-03 |
| M11 | reset never released in the auto testbench | KILLED | rc=1 1.1s FAILED: SPEC-01 |
| M13 | reset pulse generation dropped from the auto testbench | KILLED | rc=1 1.2s FAILED: SPEC-01 |
| M14 | LED polarity handling inverted in the backend board map | KILLED | rc=1 1.3s FAILED: POL-01 |
| M15 | segBitMap shifted by one bit (every segment index +1 mod 8) | KILLED | rc=1 1.0s FAILED tests/test_audit_units.py::test_seg_bit_map_matches_schematic - Assert... |
| M16 | UART bit time interpretation halved (baud formula wrong) | KILLED | rc=1 0.9s FAILED tests/test_audit_units.py::test_decode_uart_lsb_first_and_baud - Asser... |
| M17 | inline comment stripping removed (audit M5 regression) | KILLED | rc=1 0.9s FAILED: QE-01 |
| M12 | buzzer polarity flipped | KILLED | rc=1 0.9s FAILED tests/test_audit_units.py::test_board_profile_polarity_matches_spec - ... |
| M18 | ENG-07 textio absolute-path pre-scan disabled (scans nothing) | KILLED | rc=1 1.7s FAILED: RB-05 |
| M19 | PLL-count warning removed (estimator reports 0 ALTPLLs) | KILLED | rc=1 1.1s FAILED: BLK-03 |
| M20 | session per-run generation guards removed (stale-run hijack restored) | KILLED | rc=1 2.5s FAILED tests/test_session.py::test_replaced_run_never_streams_stale_results |
| M21 | waveform value_at bisect broken (always returns the initial value) | KILLED | rc=1 1.0s FAILED tests/test_audit_units.py::test_waveform_value_at_matches_linear_reference_on_random_times |
| M22 | to_dict transition cap removed (every transition serialized) | KILLED | rc=1 1.1s FAILED tests/test_audit_units.py::test_waveform_to_dict_respects_the_transition_cap_and_is_determini |

A KILLED mutation means at least one test fails when the bug is present, so the behaviour is actually covered. A SURVIVED mutation is a missing test.
