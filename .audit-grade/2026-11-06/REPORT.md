# Canopy (canopy-app): second internal review

**Commit reviewed:** private `87fb25f`, public `1fec06e` (2026-11-06). **Mode:** full, two independent lanes (contracts;
off-chain services). **Rubric:** the same as [the 2026-11-05 review](../2026-11-05/REPORT.md).

This review was done by the same team that builds Canopy, so it is not an external audit. Every finding below came
with a test that passed on the reviewed commit and showed the problem. Each fix turns that test into a regression test
that asserts the safe behaviour.

## Verdict

- **As found: 5.0 / 10.** Two new Highs in the keeper set the cap.
- **After the fixes in this report: about 8.3 / 10.** This is our own estimate, and it hasn't been checked by an
  independent re-review.

The contracts held. The reviewer found no way for funds to reach anyone but the position owner. It also found no way
for anyone but the owner to exit without a live armed alarm. Mutation testing (83 mutants) found one test gap, the
EIP-712 chain id, which is now covered.

The serious problems were again in the keeper's liveness and gas spending. An attacker who buys one plan could stop
the keeper's exit queue for everyone, or drain its gas. Owners could always exit themselves throughout.

## Fixes from the 2026-11-05 review

| Finding | Holds? | Evidence |
| --- | --- | --- |
| H-1 hostile vault stalls the keeper | Yes, but A2-H1 and A2-M1 reached the same outcome another way | The original PoC re-run: the victim's exit is sent in under 100 reads |
| H-2 gas-burning alarm key | Against the original burner. Two bypasses found (A2-M2, A2-M3) | Control test: a burner that fails alone is set aside after one pass |
| L-2 alerts in the indexer loop | For the indexer. The detector still sent inline (part of A2-M4) | |
| L-3 quorum keys with no plan check | Yes, by design: buying a plan brings a key into scope | |
| L-4 RPC key in logs | For http(s) and ws(s) URLs. Other schemes and logged objects closed in this round | |

## Findings

### Off-chain services

| # | Sev | Finding | Status | Proof (regression test) |
| --- | --- | --- | --- | --- |
| A2-H1 | High | 32 attacker exit jobs too big for one bundle stay first in the queue forever, so no other exit is ever sent | Fixed `c9bca36` | `services/test/keeper-queue.test.ts` |
| A2-H2 | High | The keeper pays without a gas cap for an attacker's exits (retried every 30 s), checkpoints and owed claims | Fixed `7508afd` | `services/test/keeper-gas.test.ts` |
| A2-M1 | Medium | Slow attacker jobs delay honest exits by whole passes | Fixed `c9bca36` | `keeper-queue.test.ts` |
| A2-M2 | Medium | H-2 bypass: a key that burns gas only inside the shared check is never set aside | Fixed `b93748c` | `services/test/keeper-poke.test.ts` |
| A2-M3 | Medium | A key that reads as tripped but doesn't fire is poked every second | Fixed `b93748c` | `keeper-poke.test.ts` |
| A2-M4 | Medium | Followed contracts are scanned before listed vaults, with inline Telegram sends | Fixed `63e2ffd` | `services/test/role-loops.test.ts`, `detector-loop.test.ts` |
| A2-L1 | Low | The watcher reruns the live-keys query once per quorum detector | Fixed `63e2ffd` | `role-loops.test.ts` |
| A2-L2 | Low | The read limit counts each IPv6 address on its own | Fixed `920a312` | `services/test/ratelimit-ipv6.test.ts` |
| A2-L3 | Low | Watchers sign "Exploit confirmed" for a vault from any report naming its platform, plus a drain a parked deposit can fake | Fixed `000f2da` | `services/test/false-quorum.test.ts` |

Leads closed in `4257a73` and `c9bca36`:
- a job past its time budget could still send late;
- non-HTTP URLs and logged objects weren't scrubbed;
- tables only grew;
- `/alarms/live` had no paging;
- the alarm queue rescanned a whole day every 2 seconds.

All are covered by `services/test/regressions.test.ts` and `keeper-queue.test.ts`.

### Contracts

The contracts can't change, so each mitigation is in the app, the keeper or the docs.

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| A2-01 | Low | A tripped detector never resets: after a lasting loss, a share-drop key refires every 24 h, and a curator-change key stays tripped. A later arming is exited at the next refire | Mitigated: the app refuses to arm any key that is tripped, fired in the last 24 h, or can't be read (`web/src/alarms.ts`). Accepted risk in SECURITY.md |
| A2-02 | Low | DRAIN trusts single low readings, and accepts 1–2 s windows | Mitigated: the app offers DRAIN only with a watcher quorum and refuses windows under 1,200 s. Accepted risk in SECURITY.md |
| A2-03 | Info | A quorum signature with a far-future deadline becomes usable by anyone in its last hour | Watchers cap deadlines at 10–30 minutes |
| A2-04 | Low (doc) | The watcher list never expires, so the admin plus 2 watcher keys can fire any quorum key | Documented in SECURITY.md. Funds still go only to owners |
| A2-05 | Info | "Fired after you armed" is really "at or after" | Docs corrected. The app refuses alarms that fired in the last 24 h |
| A2-06 | Info | A token returning 1 byte is paid and also booked as owed | Not reachable with launch assets. Documented in `RouterEdges.t.sol` |
| A2-07 | Low | An admin gas-burning feed makes Stable-harbour exits cost about 20× the gas | Same admin trust as M-1. Accepted risk in SECURITY.md |

The PoCs are kept as tests named for the behaviour they document: `contracts/test/AlarmLimits.t.sol` and
`contracts/test/RouterEdges.t.sol`.

Also fixed:
- Slither triage reasons corrected.
- INVARIANTS.md, SECURITY.md and the docs page corrected wherever they said more than the code does.
- The invariant suite now has an independent model of when an alarm may fire, plus the admin expiry, the swap minimum
  and the keeper's 1% slip cap.

## Open leads

- **Reorgs below the indexer cursor.** A log re-included at a lower height isn't re-read, and `Fired` and `Disarmed`
  apply at the tip. New arms are re-checked on chain once settled, and the keeper simulates every exit.
- **First-registrant baseline** on a thin vault, for a share-drop key nobody has registered. This couldn't be built
  for the launch vaults.
- **DRAIN goes stale** when nobody checkpoints for longer than its window. The keeper samples listed vaults each period.
- **Real-node timing** for the queue and poke fixes is untested. The tests use mocks with stand-in delays.

## Score

| Cat | Weight | As found | After fixes | Why |
| --- | --- | --- | --- | --- |
| A Contracts | 35% | 7.3 | 7.3 | 10 − M-1 (1.2) − five Lows (0.3 each: L-1, A2-01, A2-02, A2-04, A2-07). They're accepted and mitigated off-chain, but they're still in the deployed code |
| B Off-chain | 15% | 0 | 9.0 | As found: 2 Highs and 4 Mediums. After fixes: the open leads above |
| C Testing | 15% | 7.5 | 8.0 | 251 contract tests, 8 fork tests, 131k-call invariant suite with 12 invariants, a revert test per error, 343 services tests (93% line coverage), 61 web tests, CI on every push. No symbolic or automated mutation runs |
| D Operations | 10% | 9.0 | 9.0 | Roles in SECURITY.md, 2-of-3 Safes, immutable, pause leaves exits open, verify.ts, admin-event alerts and INCIDENT.md. Setters unbounded (needs v2) |
| E Supply chain | 5% | 10 | 10 | Unchanged |
| F Repo hygiene | 10% | 9.5 | 9.5 | Gitleaks, Slither and CodeQL in CI, actions pinned, SECURITY.md. Slither's own pip dependencies aren't hash-pinned |
| G Docs | 10% | 9.0 | 9.0 | Fresh-clone deploy guide, invariants linked to tests, threat model, build hashes, audit history and CHANGELOG. No NatSpec on every function (needs v2) |
| **Total** | | **5.0** (cap: 2 Highs) | **≈ 8.3** | The open Medium (M-1, accepted) caps at 8.9, which doesn't bind |
