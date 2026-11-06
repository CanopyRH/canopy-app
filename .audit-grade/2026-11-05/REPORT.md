# Canopy (canopy-app): Audit

**Repo:** https://github.com/CanopyRH/canopy-app · **Commit:** `71c1fa0bd997bfa4504494789b99172123c295c2` (2026-11-05) · **Mode:** full · **Rubric:** v2
Slither, Semgrep, osv-scanner and mutation testing weren't available here; `bun audit` and gitleaks stood in where possible. The Base-chain fork tests weren't run.
Everything the product does is in this repo. The `web/` frontend is out of scope by the skill's rules, except that its written docs (`web/src/copy/docs.json`, `whitepaper.json`) were read as documentation.

## Verdict

**Grade: 5.0 / 10.** The binding cap is two open Highs (5.0). One High (6.0) and a failing test (6.0) also apply. The weighted score before caps is 5.88.

The contracts are small, immutable and carefully written, and the live bytecode matches this commit exactly. The core promise holds in every path traced: an exit pays only the position owner, and nothing found here can move a user's funds anywhere else.

The serious problems are in the off-chain keeper. Arming and alarm registration are open to anyone, and two cheap tricks stop Canopy's own keeper from protecting anyone:
- **H-1:** a contract that sends the exit loop into an endless liquidity scan.
- **H-2:** a gas-burning alarm key that blinds the keeper's batched alarm check.

Owners can still exit themselves, and anyone could run a separate keeper, but the product's main promise, automatic exits, can be switched off for about $15.

Most important fix: H-1 and H-2, together with refreshing the stale fork-test holder. Doing all three lifts the grade to 7.1.

## Findings

### H-1. High: one armed "vault" contract can stop the keeper from sending any exit
- id: offchain-backend|services/src/keeper/liquidity.ts|unbounded-loop-dos
- location: `deallocateCalls` (services/src/keeper/liquidity.ts:26-53), called from `runExit` (keeper.ts:145) and the bundle path (keeper.ts:215)
- path:
  1. Anyone can arm a position on any contract: `ERC4626Adapter.positionAsset` accepts any target (ERC4626Adapter.sol:19-21), and the indexer stores every `Armed` event (indexer.ts:24-31).
  2. The attacker registers and fires an alarm on their own contract. With a plan (prepaid.ts:4-7), or against an open keeper, `onFired` queues the exit job (keeper.ts:110-118).
  3. `runExit` → `deallocateCalls` reads `liquidityAdapter()` from the target and `marketIdsLength()` from that adapter (liquidity.ts:28-31). The attacker returns penalty 0 and length 2^255.
  4. The loop makes 3 RPC reads per step (:33-38). Morpho returns zeros for unknown ids, so every step is a `continue` and nothing throws.
  5. `drainExits` runs jobs one after another (keeper.ts:277-286), and `every()` schedules the next pass only after the current one finishes (index.ts:38-48). The "exits" loop never runs again.
  6. The 24 h expiry is checked only once, at the start of `runExit` (keeper.ts:137). So the hang lasts until the process restarts, and it resumes after a restart while the alarm is under 24 h old. The attacker can re-fire daily.
- trigger: anyone, for the price of a plan plus gas. Free against `KEEPER_PAID_ONLY=false`.
- impact: Canopy's keeper sends no exits for any user. Owners can still exit on-chain themselves. An exploiter would set this up right before draining a real vault.
- evidence: `CANOPY-APP_POCS/services/poc-keeper-hang.test.ts`, re-run twice. After 3 s, about 6 million reads have been made and the victim's exit was never sent. The control (length 1) completes.
- fix:
  - Cap `marketIdsLength`, at 32 for example.
  - Deallocate only for listed vaults (`CARD_VAULTS`).
  - Give each job and each vault group a time budget.
  - Run listed vaults before unknown targets.
- regression test: the PoC, expecting `drainExits` to finish within the budget and the victim's exit to be sent.

### H-2. High: one gas-burning alarm key stops the keeper from poking every alarm in its batch
- id: offchain-backend|services/src/keeper/keeper.ts|multicall-gas-griefing
- location: `pokeTripped` (services/src/keeper/keeper.ts:52-78)
- path:
  1. Anyone registers a PAUSED detector on a contract whose fallback loops forever. Registration only checks that the target has code (AlarmBook.sol:104-126, :240-241).
  2. The attacker arms any target with up to 8 such keys (ExitRouter.sol:35, :169-210) and holds a plan, so `liveKeys` returns the keys (repo.ts:56-63).
  3. `pokeTripped` checks all live keys in one Multicall3 `eth_call`, 250 per chunk (`CHECKS_PER_CALL`), with no per-call gas limit (keeper.ts:56-61).
  4. `check` → `_tripped` calls the target with all remaining gas (AlarmBook.sol:139-144, :265-268). The burner eats 63/64 of it, and the whole chunk runs out of gas.
  5. viem marks every call in that chunk as failed. `pokeTripped` only counts `poke_fail` (:63-75), so no honest tripped key in the chunk is poked and nothing is queued (:80-86).
  6. The burner never trips, so it stays in the list for the whole plan.
- trigger: anyone, for a plan plus gas. Free against an open keeper.
- impact: the keeper never fires the Vault loss, Paused, or drain/curator-change alarms for keys in the poisoned chunk. The confirmed drain/curator-change alarms can't fire either, because their first part never fires. Quorum alarms and pokes by other callers still work, and owners can still exit.
- evidence:
  - `CANOPY-APP_POCS/contracts/IndepGasBurner.t.sol`, re-run here at a 50M gas limit. A burner first or in the middle of 250 keys leaves 0 calls succeeding at the top level; a burner last is harmless; the control sees all 249.
  - The independent reviewer's anvil end-to-end test (`CANOPY-APP_POCS/services/indep-poke-burner.e2e.ts`) used the real `pokeTripped`: with one burner, 0 of 120 keys were poked.
  - A single burner is survivable with fewer than about 50 keys, so an attacker arms 2 or more.
- fix:
  - Check each key in its own `eth_call` (a JSON-RPC batch works), or through a helper that calls with a fixed gas limit.
  - Set aside keys whose check fails or burns gas.
  - Check keys on listed vaults first.
- regression test: the anvil test, expecting 120/120 poked with burners present.

### M-1. Medium: an admin feed and route can take the value of Stable-harbour exits armed after the change
- id: evm|contracts/src/ExitRouter.sol|admin-swap-config
- location: `setFeed` / `setRoute` (ExitRouter.sol:319-336), `quoteMinOut` (:292-303), `_settle` / `_trySwap` (:410-416, :427-453)
- path:
  1. The admin is the Timelock (delay **0** on mainnet: `DELAY()` = 0), driven by the 2-of-3 Safe until 2027-11-04.
  2. It calls `setFeed(token, feedItControls, …)` and `setRoute(token, path)`. The route only has to start at `token` and end at USDG (:329-331), so it can pass through pools the admin seeded. `swapConfig` increments.
  3. A user arms with `harbour = STABLE` afterwards and stores the new `swapConfig` (:201).
  4. On exit, `quoteMinOut` prices the token with the admin's feed, so `minOut` ≈ 0 (:299-301). `_trySwap` swaps everything through the admin's route (:440-446).
- trigger: privileged (2 of 3 signers), with no delay. It reaches only Stable-harbour positions armed after the change.
- impact: up to the full value of each such exit. Today it is latent: no feed or route is set on mainnet (`swapConfig` = 0, no `FeedSet`/`RouteSet` events), and the app doesn't offer the swap.
- why it's a finding: the whitepaper says *"no admin change can reach funds or payouts"*, and README line 47 says *"The admin can't redirect any payout"*. README line 48 does describe part of the mechanism ("a feed or route change applies only when the owner re-arms"), but nothing says a new setting can strip an exit's value.
- evidence: `CANOPY-APP_POCS/contracts/AdminSwapConfig.t.sol`.
  - Exploit: an owner's $20,000 of TOK is paid out as $10.
  - Control: with an honest feed, the bad pool is skipped and the owner gets the raw token.
- fix, smallest first:
  1. Correct the README and whitepaper wording.
  2. List the risk as accepted in a SECURITY.md, with the reason: swap off in v1, `verify.ts` checks "no route", 2-of-3, expiry.
  3. Alert on `FeedSet`/`RouteSet`/`AdapterSet`.
  4. In a v2: have `arm` take the feed and route the user saw, or drop admin-set swap config.
- regression test: the PoC, inverted, once a v2 guard exists.

### Lows

| # | Finding | Location | Path / impact | Fix |
| --- | --- | --- | --- | --- |
| L-1 | A position armed while its alarm is already live waits up to 24 h for keeper protection | AlarmBook.sol:146-152, :229-231; ExitRouter.sol:358-359 | `_authorize` needs the fire to come after arming, and `poke` can't refire for `REFIRE_AFTER`. A keeper exit reverts `AlarmNotLive` at T+1h and works only at T+24h (`contracts/RefireGap.t.sol`, passes). The owner can still exit | Warn in the app ("already live: exit now"). v2: let hard kinds that still trip authorize |
| L-2 | Telegram alerts are sent inside the indexer loop, delaying later alarms (downgraded from Medium after the independent check) | index.ts:97-120; bot.ts:60-75 | Alerts go to followers one at a time, and 429s sleep inside `onLog`. The fired alarm's own exits are queued first (index.ts:106), but later `Fired` logs, including keeper-sent quorum fires (index.ts:137-150), wait behind the alerts. Seconds to minutes; it needs many chats or a popular vault (`services/poc-backend.test.ts` PoC-1). Raising it would take evidence of a loss for a position armed only with the later key | Queue alerts on their own rate-limited loop. Have the keeper queue exits for live armed keys it reads itself |
| L-3 | Watchers sign, and the keeper fires, QUORUM keys on any contract with no plan check | index.ts:225-227, :137-150; watcher.ts:39-43 | Anyone can register a QUORUM key on their own contract. A report naming "morpho" matches every key, and the soft signals can be self-made. The keeper then pays the gas and shares its sender with exits (PoC-2) | Attest and fire only listed-vault presets, or keys a paid position armed |
| L-4 | An RPC key in the URL path reaches logs | index.ts:44; keeper.ts:73,103,272,283 | viem removes only user:password from URLs. The example `RPC_URL` puts the key in the path (`services/poc-rpc-log.test.ts`) | Remove URLs from logged errors |

**Info (no deduction):**
- `ExitRouter.sol:43` comments `Timelock (48h)`, but the deployed delay is 0.
- `setFeed` takes `tokenDecimals` from the admin, and `heartbeat` has no upper bound.
- A position stays armed after an exit. While its alarm is live, new shares the owner approves can be exited again by anyone; the whitepaper describes this.
- The webhook secret and the `/health` token are compared with `!==` (api/server.ts:48, :79). Use `timingSafeEqual`.
- Checkpoint transactions for attacker-registered keys cost the keeper gas.

**Leads (no deduction):**
- `checkpoint` raises the SHARE_DROP high-water mark from a single reading (AlarmBook.sol:164-169), unlike DRAIN. If a launch vault's `convertToAssets` can be pushed up and back within one transaction, anyone could later fire "Vault loss" for that vault; a plain donation doesn't work. To settle it: a fork test per launch vault (flash deposit, donate, withdraw, then `checkpoint`).
- The indexer reads `state` at the log's block, and skips a log for good after 3 failures (indexer.ts:119-125). A pruned RPC node could drop an alarm's exits.
- Payments and `Armed` are applied at the chain tip, with no confirmation depth (indexer.ts:110-128).
- `/vaults` has no rate limit.
- `claimOwed` has no test. Two suggested tests are in `contracts/ClaimOwed.t.sol`, and both pass.

**Checked and fine:**
- Contracts:
  - Every outbound transfer goes to `p.owner`.
  - `exit` and `claimOwed` are `nonReentrant`.
  - Owed balances are excluded from exit deltas (`_free`).
  - Signatures use EIP-712 with the chain id and the contract address, low-s only, with deadlines shorter than the refire period.
  - The Timelock has a grace period, and the contracts can't be upgraded.
- Services:
  - SQL is parameterised.
  - The webhook requires the secret token, with a test.
  - `/watcher/attest` checks the allowlist, signature form and deadline.
  - LLM input is quoted as untrusted, and a label alone never fires.
  - Feeds require HTTPS and refuse redirects.
  - Every exit is simulated and refused if the router or keeper balance would move.
  - Payment credits are idempotent.
  - The Docker image runs as non-root.

**Accepted / documented:** the whitepaper's "Limits" section covers false alarms, vault-asset risk, the zero-delay launch and the permanent watcher list. There's no SECURITY.md, so nothing is formally "accepted".

## Verified this run

| Item | Result |
| --- | --- |
| Build | `forge build` OK (solc 0.8.28). `bunx tsc --noEmit` OK for services and web |
| Tests | Foundry: 133 passed (default suite). Mainnet fork suite (public RHC RPC): 6 passed, **1 failed** (`test_fork_realOwnerExit`, whose hard-coded holder has withdrawn; it fails its own precondition at Fork.t.sol:176). This is counted as a test failure for both C and the cap. Services: 215 passed with Postgres 18. Web: 40 passed. Banned-words check clean |
| Coverage | Contracts `src/`: 428/500 lines (85.6%, `forge coverage --ir-minimum`). Services `src/`: 1,097/1,219 loaded lines, plus `src/index.ts` (~182 lines, never loaded, counted as 0). Core is taken as contracts plus services: about 1,525/1,901, or **80%** |
| Invariants / fuzz | No stateful invariant tests. Fuzz: `exit` (any caller, any amount) and FullMath, 256 runs each, 0 failures |
| Secrets | Tree and full history (gitleaks, 329 commits): 5 hits, all false positives (Anvil default keys, the USDG address, a public-by-design wallet project ID) |
| Advisories | `bun audit --prod`: services clean. 2 High are in frontend-only dependencies, which are out of scope |
| CI | forge build/test, services and web tests with Postgres, tsc, a Docker start check and a repeatable web build. No static analysis, no secret scanner, Actions pinned by tag |
| Live check | **Matches.** `services/deploy/verify.ts` against a manifest rebuilt from public sources only: 25/25, including all 4 bytecodes. Sourcify exact match for all 4. Both Safes are 2-of-3. Timelock delay 0. Admin expiry 2027-11-04. No feeds or routes set |

## Score

| Cat | Score | Weight | Weighted | Why (each point with its evidence) |
| --- | --- | --- | --- | --- |
| A | 8.5 | 35% | 2.975 | 10 − M-1 (1.2) − L-1 (0.3). Every line of `contracts/src` (1,203 lines) read |
| B | 2.1 | 15% | 0.315 | 10 − H-1 (3.5) − H-2 (3.5) − L-2, L-3, L-4 (0.3 each) |
| C | 3.6 | 15% | 0.54 | Build/tests: 0.3 (1 fork test fails). Coverage 80%: 0.8. Negative tests on every function: 0 (`claimOwed`, unknown-key `poke`/`checkpoint`, `BadSignature`, `AlreadyLive` untested). Fuzz: 1.0. Stateful invariants: 0. Mutation: 0. Fork/integration: 1.0 (`Fork.t.sol` live vaults; services e2e with Postgres; both ran). Symbolic: 0. CI on push/PR: 0.5 |
| D | 6.5 | 10% | 0.65 | Privileged functions listed in README/SECURITY.md with holders: 0 (the full list is only in the docs page). Multisig/timelock admin: 1.5 (on-chain). Upgrade safety: 1.5 (immutable). Pause with exits open: 1.0 (`test_guardianCannotBlockExits`). Setters bounded: 0. Deploy scripts: 1.0 (`Deploy.s.sol`, broadcast committed). Post-deploy verification: 1.5 (`verify.ts`, 25/25 live). Monitoring/runbook: 0 (gas, lag and stuck-job alerts only) |
| E | 10.0 | 5% | 0.50 | Lockfiles + frozen installs 2.0. Exact pins 1.5. No reachable High/Critical advisories 2.5. Install scripts off + 14-day release age 1.5. FullMath names its source 1.0. No submodules 0.5. Toolchains clean 1.0 |
| F | 6.0 | 10% | 0.60 | No secrets 3.0. Env handling 0.5. CI tests 1.5. Static analysis 0. Actions hardening 0 (tag pins, no secret scanner). LICENSE 0.5, SECURITY.md 0. Deterministic toolchain 0 (`bytecode_hash` not explicit, no `packageManager`/`engines`). Dev-environment hygiene 0.5 |
| G | 3.0 | 10% | 0.30 | README with deploy steps 0. Architecture 1.5 (whitepaper). Invariants linked to tests 0. Threat model 1.5 (whitepaper "Limits"). Doc comments on every external function 0. Addresses + build hash 0 (links and Sourcify match, but no build-of-record hash written down). Audit history 0. Audit readiness 0 |
| **Total** | | | **5.88 → 5.8** | Caps: 2 open Highs → **5.0**; 1 High → 6.0; failing test → 6.0; open Medium → 8.9. **Final 5.0** |

Not applied: the 8.0 cap for "fund-holding vault/lending/perp/pool with no stateful invariant tests". ExitRouter is an exit router that holds only failed-delivery balances; its missing invariants already cost 2.0 in C.

**Independent check:** a fresh reviewer recomputed 5.88 → 5.0. They found H-2 (promoted here from a Lead, with the PoC re-run), cut M-2 to Low, and removed D's 1.5 for the privileged-functions list. All three corrections are adopted, so the two grades now agree.

## Path to 9+ (ranked by points per hour)

Items 1-3 lift caps that bind together, so they count as one block.

| # | Change | Size | Points | Projected |
| --- | --- | --- | --- | --- |
| 1 | Fix H-1: cap `marketIdsLength`, deallocate only for listed vaults, per-job time budget. Proof: the PoC as a passing regression test | M | block +2.1 | — |
| 2 | Fix H-2: one `eth_call` per key (JSON-RPC batch) or a fixed-gas helper, and set aside failing keys. Proof: the anvil test with burners, all honest keys poked | M | (block) | — |
| 3 | Refresh the holder list in `Fork.t.sol` so the mainnet fork suite passes | S | (block) | 7.1 |
| 4 | SECURITY.md: disclosure contact, every privileged function with its holder, and an accepted-risk list (M-1, L-1, with reasons). Correct "can't redirect any payout" in README and the whitepaper | S | +0.55 | 7.6 |
| 5 | Pin every `uses:` to a full SHA, set `persist-credentials: false`, add a gitleaks step | S | +0.15 | 7.8 |
| 6 | README: deploy-from-fresh-clone section (Deploy.s.sol env, plan.ts, Safe batches, verify.ts) | S | +0.15 | 7.9 |
| 7 | `foundry.toml`: explicit `bytecode_hash = "ipfs"` (no bytecode change). `package.json`: `"packageManager": "bun@1.4.4"` | S | +0.10 | 8.0 |
| 8 | README Deployments: audited commit and each contract's metadata hash | S | +0.10 | 8.1 |
| 9 | Commit this report under `.audit-grade/`; start a CHANGELOG | S | +0.10 | 8.2 |
| 10 | Tag the audited commit; add a scope file list | S | +0.05 | 8.3 |
| 11 | docs/INVARIANTS.md: each hard rule in ExitRouter's header, linked to its test | M | +0.20 | 8.5 |
| 12 | Fix L-4 (remove URLs from logged errors) | S | +0.05 | 8.5 |
| 13 | Fix L-3 (attest and fire only listed-vault presets or paid-armed keys) | S | +0.05 | 8.6 |
| 14 | Negative tests for every external function and route (start with `ClaimOwed.t.sol`) | M | +0.15 | 8.7 |
| 15 | Slither and Semgrep/CodeQL in CI | M | +0.10 | 8.8 |
| 16 | Alerts on admin events (`AdapterSet`, `FeedSet`, `RouteSet`, `GuardianSet`, `ArmingPaused`, `WatcherSet`) + a pause runbook in the repo | M | +0.10 | 8.9 |
| 17 | Foundry invariant suite for ExitRouter (owner-only payout, `totalOwed` = Σ`owed` ≤ balance, no free balance left after an exit), ≥100k calls | L | +0.30 | 9.2 |
| 18 | Fix L-2 (alerts on their own loop) | M | +0.05 | 9.2 |

Later:
- Halmos on `quoteMinOut`/FullMath (+0.08).
- Mutation testing ≥60% (+0.08).
- `index.ts` tests to lift coverage past 85% (+0.06).

Two items need a v2 contract, because the deployed sources can't change: bounded admin setters, and NatSpec on every external function. About 9.5 is reachable without a redeploy.

## Paste-ready prompt for the dev

```
Read CANOPY-APP_AUDIT_REPORT.md. Fix H-1 (services/src/keeper/liquidity.ts, drainExits) and H-2
(pokeTripped in services/src/keeper/keeper.ts) first, turning the PoCs in CANOPY-APP_POCS into regression
tests. Refresh the holder list in contracts/test/Fork.t.sol so the mainnet fork suite passes. Add SECURITY.md
(disclosure contact, privileged functions and holders, accepted risks M-1 and L-1 with reasons) and correct the
"admin can't redirect any payout" lines in README.md and web/src/copy/whitepaper.json. Do not edit any file
under contracts/src: it must stay byte-identical to the deployed source. Then implement Path items 5-18 in order
on branch `audit-fixes`, one commit each, each with the test or file the report names as proof. Never touch
private keys or send mainnet transactions; tests run on local forks or mocks only. Push and confirm CI is green.
```

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.
