// Cross-platform process control for agent CLIs.
//
// Three things every driver needs, and all three are POSIX-shaped by
// default:
//
//   1. SPAWNING. `claude` on Windows is `claude.cmd`, and since Node
//      20.12 / 18.20 (CVE-2024-27980) spawn() refuses a .cmd/.bat
//      without `shell: true`. We can't take that option: model names,
//      personas, and MCP config JSON travel through argv, and cmd.exe
//      metacharacter expansion on that is a live injection class. So
//      resolveCli() reads the shim instead and returns the JS entry it
//      would have run, to be spawned with process.execPath directly.
//
//   2. KILLING. `detached: true` + `process.kill(-pid)` is how a driver
//      reaps a CLI *and* the MCP servers it spawned. Windows has no
//      process groups and no negative pids — the equivalent is
//      `taskkill /T`. (`detached` also means "new console window" on
//      Windows, which would flash a black box at the user on every
//      turn, so it stays POSIX-only.)
//
//   3. IPC. The permission broker listens on a unix socket. Windows
//      needs a named pipe — same net.Server API, different path shape,
//      and no file to unlink afterwards.
import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

import { augmentedPath } from "./env-path.ts";

const isWindows = process.platform === "win32";

/** What to actually hand to spawn(): the real executable plus any args
 * that must come before the caller's own. */
export interface ResolvedCli {
  command: string;
  /** Prefix args — a JS entry path when we resolved through a shim. */
  args: string[];
}

// Node can exec these directly on Windows; everything else needs an
// interpreter in front of it.
const NATIVE_EXT = new Set([".exe", ".com"]);
const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const SHIM_EXT = new Set([".cmd", ".bat"]);

function extname(p: string): string {
  const dot = p.lastIndexOf(".");
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return dot > slash ? p.slice(dot).toLowerCase() : "";
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every candidate file `cli` could name, best first. A bare name is
 * searched across PATH; PATHEXT supplies the extensions Windows would
 * have tried implicitly.
 *
 * PATHEXT comes *before* the bare name, which is what cmd.exe does and
 * matters in practice: node ships both `npm` (a POSIX sh script) and
 * `npm.cmd` in the same directory, and only the latter is runnable
 * here. The extensionless candidate is a last resort — it only hits for
 * a path given explicitly. */
function candidates(cli: string): string[] {
  const exts = isWindows
    ? [
        ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
        "",
      ]
    : [""];
  const bases =
    cli.includes("/") || cli.includes("\\") || isAbsolute(cli)
      ? [resolvePath(cli)]
      : (augmentedPath().split(delimiter).filter(Boolean).map((dir) => join(dir, cli)));
  const out: string[] = [];
  for (const base of bases) {
    for (const ext of exts) {
      const p = base + ext;
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** The JS file a .cmd/.bat shim would have run.
 *
 * npm's cmd-shim, pnpm's, and node's bundled npm.cmd all differ in
 * layout but agree on one thing: the entry appears as a quoted token
 * containing the batch self-directory variable (`%~dp0` or `%dp0%`) and
 * ending in .js/.mjs/.cjs. Take the last such token that actually
 * exists on disk — npm.cmd names a helper (npm-prefix.js) before the
 * real entry (npm-cli.js), and shims that fall back to a bundled
 * node.exe list the same entry twice. */
function shimEntry(shimPath: string): string | null {
  let body: string;
  try {
    body = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = shimPath.slice(0, Math.max(shimPath.lastIndexOf(sep), shimPath.lastIndexOf("/")));
  const hits = body.match(/"[^"]*(?:%~dp0|%dp0%)[^"]*\.(?:js|mjs|cjs)"/gi) ?? [];
  let found: string | null = null;
  for (const hit of hits) {
    const rel = hit
      .slice(1, -1)
      // `SET "NPM_CLI_JS=%~dp0\…"` keeps the variable name inside the
      // quotes — that assignment prefix is not part of the path
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
      .replace(/%~dp0|%dp0%/gi, dir + sep)
      .replace(/[\\/]+/g, sep);
    const abs = resolvePath(rel);
    if (isFile(abs)) found = abs;
  }
  return found;
}

/** True when a file starts with `#!` — a shebang script, which Windows
 * cannot exec but Node can run when the interpreter is node itself. */
function shebang(file: string): string | null {
  try {
    const fd = readFileSync(file, "utf8").slice(0, 200);
    if (!fd.startsWith("#!")) return null;
    return fd.slice(2, fd.indexOf("\n") === -1 ? undefined : fd.indexOf("\n")).trim();
  } catch {
    return null;
  }
}

/**
 * Turn a configured `cli` into something spawn() can actually run.
 *
 * On POSIX this is the identity — the shell-less spawn of a binary or
 * shebang script already works, and PATH lookup is the OS's job.
 *
 * On Windows it resolves the name against PATH + PATHEXT and unwraps
 * whatever it finds:
 *   - `.exe`/`.com`     → spawn it directly
 *   - `.cmd`/`.bat`     → read the shim, spawn its JS entry under node
 *   - `.js`/`.ts`/…     → spawn under node
 *   - shebang + node    → spawn under node
 * Anything it can't unwrap comes back unchanged, so the caller still
 * gets a normal spawn ENOENT rather than a surprise from this module.
 */
export function resolveCli(cli: string): ResolvedCli {
  if (!isWindows) return { command: cli, args: [] };

  for (const candidate of candidates(cli)) {
    if (!isFile(candidate)) continue;
    const ext = extname(candidate);
    if (NATIVE_EXT.has(ext)) return { command: candidate, args: [] };
    if (SCRIPT_EXT.has(ext)) return { command: process.execPath, args: [candidate] };
    if (SHIM_EXT.has(ext)) {
      const entry = shimEntry(candidate);
      // an unparseable shim is left alone rather than run through
      // cmd.exe — spawn fails loudly and the driver reports it
      return entry ? { command: process.execPath, args: [entry] } : { command: candidate, args: [] };
    }
    // extensionless: a shebang script (how the test fakes ship)
    const hashbang = shebang(candidate);
    if (hashbang && /\bnode\b/.test(hashbang)) return { command: process.execPath, args: [candidate] };
    return { command: candidate, args: [] };
  }
  return { command: cli, args: [] };
}

/** Every driver spawns its CLI fully piped — keeping the concrete type
 * means callers still get non-null stdin/stdout/stderr. */
export type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * spawn() an agent CLI, resolved for this platform.
 *
 * `detached` is requested on POSIX only: the driver wants a process
 * group so killTree() can reap child MCP servers, but on Windows the
 * same flag opens a console window. killTree() covers the Windows side
 * with `taskkill /T` instead.
 */
export function spawnCli(
  cli: string,
  args: string[],
  options: Omit<SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">, "stdio" | "detached">,
): PipedChild {
  const resolved = resolveCli(cli);
  return spawn(resolved.command, [...resolved.args, ...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
    detached: !isWindows,
  });
}

/**
 * Kill a CLI and everything it spawned.
 *
 * POSIX: signal the whole process group (negative pid), falling back to
 * the child alone if it was never detached. Windows: `taskkill /T`
 * walks the child tree, with child.kill() as the fallback. Fire and
 * forget — callers treat stop() as synchronous, and the child's own
 * "close" event is what actually settles a turn.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (!pid) return;
  if (isWindows) {
    // /T tree, /F force — no shell, pid through argv
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
      // taskkill exits nonzero when the tree is already gone; the
      // fallback is harmless in that case too
      try {
        child.kill(signal);
      } catch {}
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * A net.Server address for local IPC between the harness and a proxy it
 * spawned. Unix sockets are filesystem paths; Windows uses named pipes,
 * which live in their own namespace and are never unlinked.
 *
 * `dir` is only consulted off Windows — kept in the signature so callers
 * keep their existing per-instance directory semantics.
 */
export function ipcEndpoint(dir: string, name: string): string {
  return isWindows ? `\\\\.\\pipe\\openmausbot-${name}` : join(dir, `${name}.sock`);
}

/** Remove a stale endpoint before listening. Named pipes disappear with
 * the process that owned them, so this is a POSIX-only concern. */
export function unlinkEndpoint(endpoint: string): void {
  if (isWindows || !existsSync(endpoint)) return;
  try {
    unlinkSync(endpoint);
  } catch {}
}
