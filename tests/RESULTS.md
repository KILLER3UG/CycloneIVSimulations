# QA results

Generated: 2026-11-18 00:46:32
GHDL: GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]
Wall time: 0.3s
Jobs: 8
Cache: 0 hits, 1 misses, 0 fallbacks
Units: skipped (--skip-units/--filter)
Total: 1  PASS: 1  FAIL: 0

| ID | Description | Lang | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| SPEC-07 | LM75 answers on its own bus (FPGA_SCL/SDA = 112/113) at 0x48 | VHDL | temperature register reads 0x1900 (25.0 C, 9-bit 0.5 C LSB); EEPROM address NACKs on this bus | LM75 read 0x1900 on pins 112/113; EEPROM absent from this bus | PASS |
