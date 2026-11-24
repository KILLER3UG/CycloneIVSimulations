import { describe, it, expect } from "vitest";
import { normalizeDir, sameDir, resolveFileDir, buildCdCommand } from "./terminalPath.js";

describe("terminalPath", () => {
    it("normalizes trailing separators and preserves roots", () => {
        expect(normalizeDir("")).toBe("");
        expect(normalizeDir("  C:\\Users\\rober\\proj\\  ")).toBe("C:\\Users\\rober\\proj");
        expect(normalizeDir("C:\\\\Users\\\\rober//proj///")).toBe("C:\\Users\\rober/proj");
        expect(normalizeDir("\\\\server\\share\\dir\\")).toBe("\\\\server\\share\\dir");
        expect(normalizeDir("C:\\")).toBe("C:\\");
        expect(normalizeDir("C:")).toBe("C:\\");
        expect(normalizeDir("/")).toBe("/");
    });

    it("compares directories case-insensitively on Windows and across slash styles", () => {
        expect(sameDir("C:\\Projects\\BuzzB\\", "c:/projects/buzzb")).toBe(true);
        expect(sameDir("C:\\Projects\\BuzzB", "C:\\Projects\\Other")).toBe(false);
        expect(sameDir("/home/user/fpga/", "/home/user/fpga")).toBe(true);
        expect(sameDir("/home/User/fpga", "/home/user/fpga")).toBe(false);
        expect(sameDir("", "")).toBe(true);
        expect(sameDir("", "C:\\Projects")).toBe(false);
    });

    it("resolves directory for root, nested, absolute, and empty file states", () => {
        expect(resolveFileDir("C:\\ws\\buzzb", "")).toBe("");
        expect(resolveFileDir("", "buzzb.vhd")).toBe("");
        expect(resolveFileDir("C:\\ws\\buzzb\\", "buzzb.vhd")).toBe("C:\\ws\\buzzb");
        expect(resolveFileDir("C:\\ws\\buzzb", "sub/a/led.vhd")).toBe("C:\\ws\\buzzb\\sub\\a");
        expect(resolveFileDir("/home/dev/proj/", "sub\\a\\led.vhd")).toBe("/home/dev/proj/sub/a");
        expect(resolveFileDir("", "C:\\other\\dir\\top.v")).toBe("C:\\other\\dir");
    });

    it("builds shell-safe cd commands for PowerShell, cmd, and Git Bash", () => {
        expect(buildCdCommand("", "powershell")).toBe("cd ~");
        expect(buildCdCommand("C:\\My [Proj]\\it's\\src", "powershell"))
            .toBe("cd -LiteralPath 'C:\\My [Proj]\\it''s\\src'");

        expect(buildCdCommand("", "cmd")).toBe('cd /d "%USERPROFILE%"');
        expect(buildCdCommand('C:\\My Proj\\src\\', "cmd")).toBe('cd /d "C:\\My Proj\\src"');

        expect(buildCdCommand("", "gitbash")).toBe("cd ~");
        expect(buildCdCommand("C:\\My 'Proj'\\src", "gitbash"))
            .toBe("cd 'C:/My '\\''Proj'\\''/src'");
    });
});
