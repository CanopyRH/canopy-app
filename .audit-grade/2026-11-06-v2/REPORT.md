# Canopy v2: third internal review

**Reviewed:** the v2 contracts, services and web app, from private `774743b` (contracts) and `4f620a0` (services) to the
deployed `3b2c71f` (2026-11-06). **Mode:** full, two independent lanes (contracts; off-chain services and the web
app's arming code), each followed by verification rounds on the fixes. **Rubric:** the same as
[the 2026-11-05 review](../2026-11-05/REPORT.md).

This review was done by the same team that builds Canopy, so it is not an external audit. Every finding came with a
test that passed on the reviewed commit and showed the problem. Each fix turns that test into a regression test that
asserts the safe behaviour. The tests are in `contracts/test/review/`, `services/test/review/` and `web/test/review/`.

## What v2 is

v1's contracts can't change, so v2 is a fresh deployment. It closes the contract findings of the two earlier reviews:

| Earlier finding | How v2 closes it |
| --- | --- |
| M-1 admin feed and route could take Stable-harbour exits | No admin swap settings at all. The owner chooses each swap leg when arming, and the router checks the leg's decimals against the token |
| L-1, A2-01, A2-05 arming on a live or tripped alarm | `arm` refuses any key that isn't clear (`armable`). A tripped detector can be rebased 7 days into its episode |
| A2-02 DRAIN trusts single readings and tiny windows | Windows of at least 1,200 s, a fire needs two sightings a minute apart, the reference is the lower of the last two period lows, and a DRAIN can only be armed as BOTH(DRAIN, QUORUM) with a one-day window |
| A2-04 the watcher list never expires | New watchers wait 2 days; every approval expires within a year |
| A2-06 a 1-byte-return token paid and booked as owed | Payouts follow the router's own balance change |
| A2-07 a gas-burning admin feed | No admin feed; every feed and target read is gas-capped |

## Findings and fixes

### Contracts

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| V3-01 | Low | One flash-deposit sample in an unsampled period could become the DRAIN reference and fire with no loss | Fixed: the lower of two period lows, then (after verification found a persistence path) DRAIN may only be armed inside BOTH with a QUORUM |
| V3-02 | Launch blocker | The keeper's gas limits were below AlarmBook's per-read floor | Fixed in the keeper (1.6M floor, 3M cap); all 60 preset pokes and checkpoints measured on a mainnet copy, heaviest 294k |
| V3-03 | Info | A swap leg's decimals weren't checked against the token | Fixed: checked at arm under a gas cap |
| V3-04 | Info | A DRAIN sighting from before an arming counted toward a fire after it | Fixed: `armable` is false while a sighting is pending |
| V3B-01 | Low | BOTH(DRAIN, anything but a QUORUM) and nested BOTH keys bypassed the DRAIN rule | Fixed: `arm` reads both parts and refuses (`DrainNeedsQuorum`, `NestedBoth`) |
| V3C-01 | Info | A long BOTH(DRAIN, QUORUM) window let old watcher signatures count | Fixed: the window must be exactly one day |

Mutation testing: 118 hand-written mutants over ExitRouter and AlarmBook (see
`contracts/test/review/mutation/mutants.results.tsv` for the exact counts); the survivors are equivalent or low-value
and listed there. Symbolic checks (halmos): three properties hold, including "an exit pays only the owner" and "a
stranger's exit needs an armed key that fired", and both produce counterexamples on a copy with the checks removed.

### Off-chain services and web app

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| V3-S02 | High | Attacker jobs on a listed vault's position got the listed vault's fast lane and no strikes | Fixed: only a vault's own presets are listed; stale jobs end; strikes; 32 open jobs per owner |
| V3-S01 | Medium | Processes on old addresses could race or undo the database switch to v2 | Fixed: operator-authorised (`CONTRACT_SWITCH`), fenced, cursors named by contract address |
| V3-S03 | Medium | An over-cap poke was never set aside | Fixed |
| V3-S04 | Medium | An old DRAIN sighting counted as progress | Fixed |
| V3-S05 | Low | The app's arming check missed a pending DRAIN part | Fixed |
| V3-S06 | Low | A stop mid-rewind could retry a parked payment from a dropped block | Fixed |
| V3V-01 | Low | The switch deleted the old code's cursor, so an old indexer in the deploy overlap could replay v1 | Fixed: the old names are parked past any chain head |
| Lead | — | A failing listed exit with owner swap legs retried with no strikes | Fixed: such exits earn strikes |

Also closed: per-log block-hash checks against load-balanced nodes, explicit gas on every simulation, verifier
failure-case tests, and a keeper test against the real v2 contracts on a local chain.

## Deployment

v2 was deployed on 2026-11-06 at block 107737863 after a full rehearsal on a mainnet copy (deploy, plan, `verify.ts`,
alarm registration, and the whole stack end to end, 42 of 42 checks in both process layouts). On mainnet:
`verify.ts` passes 58 of 58 ([output](verify-mainnet.txt)), all four contracts are exact matches on Sourcify,
and the 30 launch alarms are registered. The services switched with one logged, authorised switch; plans and payments
were kept.

## Score

| Cat | Weight | Score | Why |
| --- | --- | --- | --- |
| A Contracts | 35% | 10.0 | The verifier's final score. Remaining items are Info: the DRAIN whale limit can no longer exit anyone without same-day watcher signatures |
| B Off-chain | 15% | 9.7 | The services verifier's score: 10 − V3V-01, which is now fixed but not yet re-verified |
| C Testing | 15% | 8.0 | The services verifier's score. Proofs are regression tests, two against real AlarmBook bytecode; mutation and symbolic runs are committed |
| D Operations | 10% | 10.0 | Self-estimate: v2 has no unbounded setters, `verify.ts` passes on mainnet, admin-event alerts and INCIDENT.md |
| E Supply chain | 5% | 10.0 | Unchanged |
| F Repo hygiene | 10% | 9.5 | Unchanged |
| G Docs | 10% | 10.0 | Self-estimate: NatSpec on every external function in v2, invariants linked to tests, findings ledger |
| **Total** | | **≈ 9.6** | No cap: no open Critical, High or Medium. D and G are our own estimates |

An outside grade of the public repo at `d4a33a2` (before V3B-01's fix and the deploy) gave 8.4 under a stricter rubric,
with a path to 9.4+ through the v2 deploy and a few small items (an advisory scan and halmos in CI, an outflow alert,
incident contacts, v1 event alerts, a committed `verify.ts` run). Those small items are in progress.
