import { existsSync } from "node:fs";
import { join } from "node:path";

/** The repository root, from services/test. */
export const ROOT = join(import.meta.dir, "../..");
/** The compiled contracts the deploy tooling compares against. */
export const OUT = join(ROOT, "contracts/out");
const NEEDED = ["ExitRouter.sol/ExitRouter.json", "AlarmBook.sol/AlarmBook.json", "ERC4626Adapter.sol/ERC4626Adapter.json", "Timelock.sol/Timelock.json"];

let result: { ok: true } | { ok: false; why: string } | undefined;

const built = () => NEEDED.every((f) => existsSync(join(OUT, f)));

/**
 * Makes sure contracts/out holds what the deploy tests read, building it with forge when it does not. Never throws: a
 * machine without forge (or where the build fails) gets a reason, and the tests that need the build skip with that message.
 */
export function contractsBuilt(): { ok: true } | { ok: false; why: string } {
  if (result) return result;
  if (built()) return (result = { ok: true });
  const forge = [join(ROOT, ".tools/foundry/v1.8.6/forge"), Bun.which("forge")].find((p): p is string => !!p && existsSync(p));
  if (!forge) {
    result = { ok: false, why: "contracts/out is missing and forge was not found. Run `forge build` in contracts/ (or put forge on PATH) to run these tests." };
  } else {
    try {
      const run = Bun.spawnSync([forge, "build"], { cwd: join(ROOT, "contracts"), stdout: "ignore", stderr: "pipe" });
      result = run.exitCode === 0 && built() ? { ok: true } : { ok: false, why: `forge build did not produce contracts/out (exit ${run.exitCode}): ${run.stderr.toString().split("\n").slice(-3).join(" ").slice(0, 200)}` };
    } catch (e) {
      result = { ok: false, why: `forge build could not run: ${(e as Error).message}` };
    }
  }
  if (!result.ok) console.warn(`SKIPPED: ${result.why}`);
  return result;
}
