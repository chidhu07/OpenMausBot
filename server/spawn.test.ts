// Cross-platform process control. The Windows half is the interesting
// one — the shim fixtures below are verbatim copies of what npm's
// cmd-shim, pnpm, and node's bundled npm.cmd actually write, because
// "resolve the .cmd to its JS entry" is only as good as the parser.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetPathCacheForTests } from "./env-path.ts";
import { ipcEndpoint, killTree, resolveCli, spawnCli, unlinkEndpoint } from "./spawn.ts";

const isWindows = process.platform === "win32";
const windowsIt = it.skipIf(!isWindows);
const posixIt = it.skipIf(isWindows);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-spawn-test-"));
  resetPathCacheForTests();
});

afterEach(() => {
  delete process.env.OMB_EXTRA_PATH;
  resetPathCacheForTests();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Put `dir` on the PATH augmentedPath() builds, so a bare CLI name
 * resolves to the fixtures below. */
const onPath = () => {
  process.env.OMB_EXTRA_PATH = dir;
  resetPathCacheForTests();
};

// ── the three shim layouts that exist in the wild ───────────────────────

/** npm's cmd-shim (what `npm i -g @anthropic-ai/claude-code` writes).
 * Note `%dp0%`, set by a :find_dp0 label, not `%~dp0`. */
const NPM_CMD_SHIM = (entry: string) => `@ECHO off
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*
`;

/** pnpm's shim — `%~dp0`, and the entry appears twice (bundled-node
 * branch and PATH-node branch). */
const PNPM_CMD_SHIM = (entry: string) => `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${entry}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\${entry}" %*
)
`;

/** node's bundled npm.cmd — names a helper .js BEFORE the real entry, so
 * "first match wins" would pick the wrong one. */
const NPM_BUNDLED_CMD = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;

const writeEntry = (rel: string) => {
  const abs = join(dir, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "process.stdout.write('entry ran');\n");
  return abs;
};

describe("resolveCli", () => {
  posixIt("is the identity on POSIX — spawn already handles binaries and shebangs", () => {
    expect(resolveCli("claude")).toEqual({ command: "claude", args: [] });
    expect(resolveCli("/usr/local/bin/codex")).toEqual({ command: "/usr/local/bin/codex", args: [] });
  });

  windowsIt("unwraps the npm cmd-shim (%dp0%) to its JS entry under node", () => {
    const entry = writeEntry("node_modules/@anthropic-ai/claude-code/cli.js");
    writeFileSync(join(dir, "claude.cmd"), NPM_CMD_SHIM("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
    onPath();

    expect(resolveCli("claude")).toEqual({ command: process.execPath, args: [entry] });
  });

  windowsIt("unwraps the pnpm shim (%~dp0, entry named twice)", () => {
    const entry = writeEntry("node_modules/codex/bin/codex.js");
    writeFileSync(join(dir, "codex.CMD"), PNPM_CMD_SHIM("node_modules\\codex\\bin\\codex.js"));
    onPath();

    expect(resolveCli("codex")).toEqual({ command: process.execPath, args: [entry] });
  });

  windowsIt("picks the real entry, not the helper, when a shim names several", () => {
    // only npm-cli.js exists on disk; npm-prefix.js is named first and
    // must lose
    const entry = writeEntry("node_modules/npm/bin/npm-cli.js");
    writeFileSync(join(dir, "npm.cmd"), NPM_BUNDLED_CMD);
    onPath();

    expect(resolveCli("npm")).toEqual({ command: process.execPath, args: [entry] });
  });

  windowsIt("prefers the .cmd over an extensionless POSIX script beside it", () => {
    // node ships both `npm` (a #!/bin/sh script) and `npm.cmd` in the
    // same directory. Picking the bare name gets us a shell script
    // Windows cannot run, so PATHEXT has to win.
    const entry = writeEntry("node_modules/npm/bin/npm-cli.js");
    writeFileSync(join(dir, "npm"), "#!/usr/bin/env sh\nexec node cli.js\n");
    writeFileSync(join(dir, "npm.cmd"), NPM_BUNDLED_CMD);
    onPath();

    expect(resolveCli("npm")).toEqual({ command: process.execPath, args: [entry] });
  });

  windowsIt("runs an .exe directly", () => {
    const exe = join(dir, "grok.exe");
    writeFileSync(exe, "MZ");
    onPath();

    expect(resolveCli("grok")).toEqual({ command: exe, args: [] });
  });

  windowsIt("runs a shebang script under node — how the test fakes ship", () => {
    const script = join(dir, "fake-cli");
    writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");
    onPath();

    expect(resolveCli("fake-cli")).toEqual({ command: process.execPath, args: [script] });
  });

  windowsIt("leaves an unparseable shim alone rather than reaching for cmd.exe", () => {
    // no JS entry to find — the caller gets a normal spawn failure, not a
    // shell invocation
    const shim = join(dir, "weird.cmd");
    writeFileSync(shim, "@echo off\r\necho nothing to see here\r\n");
    onPath();

    expect(resolveCli("weird")).toEqual({ command: shim, args: [] });
  });

  windowsIt("a shim pointing at a JS entry that does not exist is left alone", () => {
    writeFileSync(join(dir, "stale.cmd"), NPM_CMD_SHIM("node_modules\\gone\\cli.js"));
    onPath();

    expect(resolveCli("stale")).toEqual({ command: join(dir, "stale.cmd"), args: [] });
  });

  windowsIt("an unresolvable name comes back untouched, so spawn still ENOENTs", () => {
    onPath();
    expect(resolveCli("definitely-not-installed")).toEqual({ command: "definitely-not-installed", args: [] });
  });

  windowsIt("resolves an absolute path without consulting PATH", () => {
    const script = join(dir, "direct.js");
    writeFileSync(script, "process.exit(0);\n");

    expect(resolveCli(script)).toEqual({ command: process.execPath, args: [script] });
  });
});

// These spawn for real on both platforms, so they name the script by
// absolute path: resolveCli() is the identity on POSIX, where PATH
// lookup belongs to the OS and would not see the fixture directory.
describe("spawnCli", () => {
  it("runs a resolved CLI and pipes its output", async () => {
    const script = join(dir, "hello");
    writeFileSync(script, "#!/usr/bin/env node\nprocess.stdout.write('hi ' + process.argv[2]);\n");
    chmodSync(script, 0o755);

    const child = spawnCli(script, ["there"], { env: process.env });
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.on("close", () => resolve(buf));
    });
    expect(out).toBe("hi there");
  });

  it("never asks for a shell — argv metacharacters stay literal", async () => {
    const script = join(dir, "echoer");
    writeFileSync(script, "#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]);\n");
    chmodSync(script, 0o755);

    // if this ever went through cmd.exe, & and > would be operators
    const hostile = 'a & echo pwned > out.txt & "';
    const child = spawnCli(script, [hostile], { env: process.env });
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.on("close", () => resolve(buf));
    });
    expect(out).toBe(hostile);
  });
});

describe("killTree", () => {
  it("kills a CLI that would otherwise run forever", async () => {
    const script = join(dir, "forever");
    writeFileSync(script, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\nprocess.stdout.write('up');\n");
    chmodSync(script, 0o755);

    const child = spawnCli(script, [], { env: process.env });
    await new Promise<void>((resolve) => child.stdout.on("data", () => resolve()));

    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
    killTree(child);
    await exited;
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("is a no-op on a child that already exited", async () => {
    const script = join(dir, "quick");
    writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(script, 0o755);

    const child = spawnCli(script, [], { env: process.env });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(() => killTree(child)).not.toThrow();
  });
});

describe("ipcEndpoint", () => {
  it("is a socket file on POSIX and a named pipe on Windows", () => {
    const endpoint = ipcEndpoint(dir, "perm-abc123");
    if (isWindows) {
      expect(endpoint).toBe("\\\\.\\pipe\\openmausbot-perm-abc123");
    } else {
      expect(endpoint).toBe(join(dir, "perm-abc123.sock"));
    }
  });

  it("unlinkEndpoint tolerates an endpoint that was never created", () => {
    expect(() => unlinkEndpoint(ipcEndpoint(dir, "never-listened"))).not.toThrow();
  });

  posixIt("unlinkEndpoint removes a stale socket file", () => {
    const endpoint = ipcEndpoint(dir, "stale");
    writeFileSync(endpoint, "");
    unlinkEndpoint(endpoint);
    expect(() => unlinkEndpoint(endpoint)).not.toThrow();
  });
});
