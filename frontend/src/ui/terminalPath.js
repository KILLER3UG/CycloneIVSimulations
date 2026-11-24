// Helpers for mapping the active editor file to a terminal working directory
// and building shell-safe cd commands across PowerShell, cmd.exe, and Git Bash.

/** Normalize a directory path cleanly while preserving root slashes and UNC prefixes. */
export function normalizeDir(dir) {
    const raw = String(dir ?? "").trim();
    if (!raw) return "";
    const isUnc = raw.startsWith("\\\\");
    const body = (isUnc ? raw.slice(2) : raw).replace(/([\\/])[\\/]+/g, "$1");
    let out = (isUnc ? "\\\\" : "") + body;
    if (out === "/" || /^[A-Za-z]:[\\/]$/.test(out)) return out;
    if (/^[A-Za-z]:$/.test(out)) return `${out}\\`;
    return out.replace(/[\\/]+$/, "");
}

/** Compare two directory paths, normalizing separators and Windows drive case. */
export function sameDir(a, b) {
    const na = normalizeDir(a);
    const nb = normalizeDir(b);
    if (!na || !nb) return na === nb;
    const ua = na.replace(/\\/g, "/");
    const ub = nb.replace(/\\/g, "/");
    const isWin = /^[A-Za-z]:/.test(na) || /^[A-Za-z]:/.test(nb) || na.includes("\\") || nb.includes("\\");
    return isWin ? ua.toLowerCase() === ub.toLowerCase() : ua === ub;
}

/**
 * Resolve the target terminal directory for the active file, or "" (Home)
 * when no file is selected/open or no workspace path backs it.
 */
export function resolveFileDir(workspaceDir, activeFileName) {
    const file = String(activeFileName ?? "").trim();
    if (!file) return "";

    if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") || file.startsWith("/")) {
        const idx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
        if (idx < 0) return "";
        if (idx === 0 && file.startsWith("/")) return "/";
        const parent = file.slice(0, idx);
        if (/^[A-Za-z]:$/.test(parent)) return `${parent}${file[idx]}`;
        return normalizeDir(parent);
    }

    const ws = normalizeDir(workspaceDir);
    if (!ws) return "";

    const parts = file.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) return ws;

    const sep = ws.includes("\\") ? "\\" : "/";
    const base = ws.endsWith(sep) ? ws.slice(0, -1) : ws;
    return `${base}${sep}${parts.slice(0, -1).join(sep)}`;
}

/** Build a cd command tailored to the active shell (Home if targetDir is empty). */
export function buildCdCommand(targetDir, shellId = "powershell") {
    const dir = normalizeDir(targetDir);
    const sh = String(shellId || "powershell").trim().toLowerCase();

    if (sh === "cmd" || sh === "cmd.exe") {
        if (!dir) return 'cd /d "%USERPROFILE%"';
        return `cd /d "${dir.replace(/"/g, "")}"`;
    }

    if (sh === "gitbash" || sh === "git-bash" || sh === "bash" || sh === "default") {
        if (!dir) return "cd ~";
        const posix = dir.replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `cd '${posix}'`;
    }

    if (!dir) return "cd ~";
    return `cd -LiteralPath '${dir.replace(/'/g, "''")}'`;
}
