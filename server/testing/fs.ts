// Test-teardown filesystem helpers.
import { rmSync } from "node:fs";

/**
 * rm -rf a throwaway directory, tolerating Windows' brief refusal.
 *
 * A driver spawns its CLI with `cwd` inside the test home, and on
 * Windows a directory cannot be removed while any live process has it
 * as a working directory. killTree() there is `taskkill /T`, which is
 * asynchronous by nature — the handle is released once the kernel reaps
 * the tree, shortly after the turn has already settled. Measured window
 * is ~300ms for the ACP suite; most suites succeed first try.
 *
 * This is not a sleep-to-pass: nothing is being waited *for*, we retry
 * an operation the OS is momentarily refusing. (rmSync's own maxRetries
 * does not cover this error.) On POSIX the first attempt always wins.
 */
export async function rmTestDir(dir: string, attempts = 20): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
