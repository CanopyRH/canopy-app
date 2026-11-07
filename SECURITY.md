# Security

## Reporting a problem

Please report anything that could put funds at risk or stop exits privately, through
[GitHub private vulnerability reporting](https://github.com/CanopyRH/canopy-app/security/advisories/new). Don't open a
public issue for it. Include what you found, how to reproduce it, and what it affects. We aim to answer within two days.

## Scope

- The contracts in `contracts/src`. v2 is live on Robinhood Chain (4663) since 2026-11-06, at block 107737863; its addresses
  are in the README. v1 is retired, with its source tagged `v1-deployed`.
- The services in `services/`: the keeper, indexer, detectors, watchers, API and Telegram bot.
- The web app in `web/`.
- The keyless SDK in `sdk/` and local MCP server in `mcp/`. They read the chain and prepare unsigned transactions;
  they cannot sign or submit them. Their `tighten` check is a proposal-time check, not an on-chain permission policy.

The deployed contracts can't be upgraded, so a contract bug is fixed by deploying new contracts that people choose to
move to, never by changing the ones in use. v2 is that new deployment, live since 2026-11-06 at block 107737863: it closes the contract findings of the two
internal reviews (M-1, L-1, A2-01, A2-02, A2-04, A2-05, A2-06, A2-07) and the third review's V3-01 and V3-03. V3-04 is only mitigated by the quorum requirement; see the remaining BOTH limitation below. Canopy's services and app
now run on v2 only. v1 is retired: the only position ever armed on it was our own test, which holds nothing. v1's accepted
risks are listed in this file at the `v1-deployed` tag.

## Who holds which power (v2)

| Role | Held by | Can | Can't | Ends |
| --- | --- | --- | --- | --- |
| Router admin | A Timelock run by a 2-of-3 admin Safe. The Timelock delay is a deploy setting (live Robinhood v2: 0 seconds; new mainnet deployment tooling requires at least 7 days) | Allow or disallow adapters for new positions (`setAdapter`), change the guardian, pause and unpause new arming (`setArmingPaused`) | Directly call a transfer from a user, change an existing position's adapter or payout recipient, disarm a position, block an exit, or change its alarms. Allowing a hostile adapter creates risk for users who later arm with it | `ADMIN_EXPIRY`, a deploy setting between 180 and 730 days after deployment |
| AlarmBook admin (watcher list) | The same Timelock | Approve a watcher (`setWatcher`) for at most 365 days; a new approval starts 2 days after the call (`WATCHER_DELAY`). Extend an active watcher (at once). Remove a watcher (at once) | Fire an alarm alone; every watcher alarm needs 2 active watchers' signatures. Make a new watcher sign sooner than 2 days. Approve anyone for more than a year at a time. Move funds | Never: the list stays with the Timelock so a bad watcher can always be removed. The watchers named at deployment are active at once, for 365 days |
| Guardian | A 2-of-3 guardian Safe | Pause new arming | Pause exits, disarming or claims | `ADMIN_EXPIRY` |
| Payments | A 2-of-3 payments Safe | Receive plan payments | Anything in any contract | n/a |
| Keeper | Canopy's keeper key (gas only) | Send exits that a fired alarm allows, paying the owner. The keeper picks the amount, the timing within the 24 hours the alarm is live, and the gas | Choose who is paid, or lower the swap minimum below the owner's limit or 1% under the oracle | n/a; anyone can run a keeper |
| Anyone | | Register detectors, poke and checkpoint them, rebase a key that has been tripped for a week, claim owed tokens for their owner | Arm for someone else, exit someone else without a live armed alarm | n/a |

The live admin, guardian and payments Safes currently have the same three owner addresses. Separate Safe addresses do not establish separate control. Operator rotation is required; source changes cannot rotate them. New deployments require disjoint admin/guardian owner sets and thresholds of at least two; the read-only governance preflight also checks the payments Safe.

The router pays its measured outputs only to the position owner, but an adapter receives that owner's shares before unwinding. A hostile newly allowed adapter can misuse those shares for users who subsequently arm with it. Existing positions retain their chosen adapter. Review adapter code and runtime hashes before admission; do not infer safety from router payout restrictions alone. The current zero-delay Timelock is immutable and needs a separately reviewed migration to add an enforced delay. The admission helper refuses new mainnet adapters without at least seven days of enforced delay and a current reviewed runtime hash.

A watcher quorum can cause an early owner-directed exit through an honest adapter. Each `WatcherSet` event shows the approval's start; a new signer waits two days, while active signer extensions are immediate. Watcher-list authority does not expire with router administration. Signer count does not establish operator, model or source independence.

Every admin change is a public transaction from the admin Safe through the Timelock. The operator chat gets an alert for
each `AdapterSet`, `GuardianSet`, `ArmingPaused` and `WatcherSet` event. To pause arming, react to an alert nobody
expected, or stop a keeper or watcher, follow [INCIDENT.md](INCIDENT.md).

## How v2 closes the review findings

- **M-1 and A2-07 (admin swap settings).** The owner chooses every swap leg when arming: the token, its price feed and
  staleness limit (at most 2 days), its decimals and the Uniswap path, which must end in the stablecoin. Legs are stored
  per position and replaced only when the owner arms again. Every feed read gets at most 100,000 gas, and the whole
  oracle quote at most 500,000, so a feed that burns gas costs bounded gas and the exit pays the raw token.
- **L-1, A2-01 and A2-05 (arming on a live or tripped alarm).** `arm` refuses (`AlarmNotClear`) any key that is
  unknown, reads tripped, can't be read, or fired in the last 24 hours. A key that has been tripped for at least 7 days
  of daily fires can be rebased by anyone: a share-drop key takes today's share price as its mark, a curator-change key
  takes today's address, and a drain key restarts its sampling. A third party may exit only on a fire at or after the
  arming; a fire in the same second counts only if it comes after the arming transaction, because a key that fired
  before it can't be armed. For BOTH, this applies to the root key only; its parts have the limitation below.
- **A2-02 and V3-01 (DRAIN).** Windows under 1,200 seconds are refused. A drop fires only when two pokes at least 60
  seconds apart both see it, within the window. A poke that sees the vault whole in between doesn't cancel the first
  sighting (it only lapses after the window), so a flash deposit can't hold a real drain off. The reference is the
  lower of the lows of the last two sampling periods, so one flash-inflated sample in a period nobody else sampled can't
  fire the key: that takes two consecutive periods with no honest sample.
- **V3-04, V3V-01, V3B-01 and V3C-01 (DRAIN without a recent quorum).** `arm` accepts a DRAIN key only as a part of a
  BOTH key whose other part is a QUORUM key and whose window is exactly one day (`REFIRE_AFTER`, the app preset's value).
  It refuses a bare DRAIN key, a BOTH key with a DRAIN part and any other non-QUORUM part (two DRAIN parts included), and a
  DRAIN BOTH key with any other window (`DrainNeedsQuorum`), and a BOTH key with a BOTH part (`NestedBoth`). Such a BOTH
  key fires only when its DRAIN part and its QUORUM part each fired within the 24 hours before that BOTH fire, and an exit
  can use the BOTH fire for 24 hours after it. So a DRAIN fire exits someone only if two active watchers signed no more
  than 24 hours before the BOTH key fired (at most 48 hours before the exit). AlarmBook also reads a DRAIN key with a
  pending sighting as not armable. **Remaining contract limitation:** v2 `arm` checks `armable` on the chosen BOTH key, not its parts. A pre-arming drain sighting or recent quorum part can still contribute later. The app, SDK and hosted API check the parts and drain readiness before preparing an arm. Direct contract callers can bypass these off-chain checks. Fully enforcing component checks requires a new router deployment.
- **V3-03 (swap leg decimals).** `arm` reads each leg token's own `decimals()` (gas-capped) and refuses a leg that
  states other decimals, which would have shrunk the oracle minimum by a power of ten.
- **A2-04 (watchers).** Approvals wait 2 days, last at most a year, and lapse unless extended.
- **A2-06 (1-byte token returns).** When a token's transfer returns 1 to 31 bytes, the router checks its own balance:
  tokens that moved are paid, tokens that didn't are booked as owed.

## Risks we accept (v2)

- **DRAIN still trusts the vault's own readings.** A holder of a quarter or more of a vault can withdraw, poke and
  redeposit twice, a minute apart and within the window, and fire a DRAIN key with no loss. Because a whole reading
  never cancels a sighting, an honest poke between the two dips doesn't stop that either. Anyone who is the only one
  to sample a vault for two consecutive periods can inflate its reference with flash deposits, and by then taking every
  roll with a flash deposit keep the key tripped and refiring daily even while a keeper samples each period. Low samples
  taken by `checkpoint` lower the reference, so a real loss can later go unseen. None of this can force an exit without
  a watcher quorum: the router arms a DRAIN key only inside a one-day BOTH(DRAIN, QUORUM), which fires only if its QUORUM
  part (two active watchers' signatures) also fired within the 24 hours before it. What the attacker gains is a DRAIN
  part that is already "fired", so a quorum signed for any reason within 24 hours of a DRAIN fire would complete the BOTH
  key.
- **A PAUSED detector on a target without the view never fires.** If the view reverts, the key reads "not paused".
  None of the five launch vaults has a `paused()` view, so the "Paused" preset can't fire on them.
- **The live deployment has no admin delay and overlapping Safe signers.** The new deployment defaults do not change existing contracts. Use the governance preflight and migration checklist in [the hardening runbook](docs/operational-hardening.md).
- **Watcher correlation and authority.** Multiple keys can run the same pipeline. Hosted quorum assembly requires reviewed diversity profiles by default, but labels cannot establish independence and direct on-chain submissions are not governed by this host policy. Operators must actually separate control, models and primary sources. Watcher-list administration persists indefinitely.
- **Cold or stale drain references cannot detect a drain.** Listed DRAIN and SHARE_DROP presets are maintained independently of payment or active positions. A new drain reference needs two period rolls with nonzero readings; an old unmaintained registration may need less than an hour after its first checkpoint. The app, SDK and hosted API block arming cold or stale references. This does not make already armed positions covered while maintenance is unavailable.
- **Report attribution requires human review.** Feed confirmations bind exact report bytes, HTTPS source, chain and vault addresses to a short-lived operator approval. Brand names and depeg reports cannot authorize exploit confirmations. An attributed exploit report still requires a separate vault-specific on-chain soft signal. Approval mistakes remain an operator risk; missing approvals disable feed signing.
- **A quorum signature with a far deadline** becomes usable by anyone in its last hour (it still can't fire twice).
  Watchers cap their own deadlines at 10 to 30 minutes.
- **The sender of an exit controls its gas.** A sender who supplies too little gas for the optional swap makes it skip,
  and the owner gets the raw token instead of the stablecoin. The amount is never less than what the vault paid out.
- **Alarm levels are plain SHARE_DROP keys.** The app offers five "Vault loss" levels per vault (0.5%, 1%, 2%, 5% and 10%). Each
  is armed only if the contract calls it armable, so a level that is tripped, or fired in the last 24 hours, is not
  offered, and a lasting loss makes it unavailable until it is rebased. The keeper gives a listed vault's levels the
  same treatment as its presets, and only those five keys: any other threshold is an ordinary key.
- **An exit leaves the position armed and approvals in place.** Later deposits can be exited on a still-live alarm or a subsequent valid firing. Disarm and revoke approval if automatic exits are no longer wanted. Disarm All does not revoke approvals. The app's Plan and controls page offers per-vault disarm followed by `approve(router, 0)`, even at zero balance; these are separate owner-approved transactions, and partial failures are reported. Arming still requests an unlimited share allowance. Other adapters and routers need their own approval cleanup.

## Risks accepted on v1 (added after the `v1-deployed` tag)

A tag can't change, so a v1 risk found later is listed here, next to the ones in the file at the tag.

- **A flash deposit at a DRAIN period roll can become v1's reference and fire with no real loss.** v1's AlarmBook
  `checkpoint` takes the roll sample, so a deposit made just before a roll and withdrawn after it can inflate the
  reference a DRAIN key measures against, and the key then fires although no real loss happened. The app offers DRAIN only
  inside BOTH with a watcher quorum, so a false fire alone exits no one. Fixed in v2, where a roll never trusts one
  reading (see the DRAIN item under "Risks we accept (v2)" for what remains).

## Audit status

The contracts haven't had an external audit. They have unit, fuzz, invariant and mainnet fork tests, Slither runs in
CI, and both v1's and v2's sources are exact matches on Sourcify.

Internal reviews are in [`.audit-grade/`](.audit-grade/) and [`contracts/test/review/`](contracts/test/review/):

- **2026-11-05.** Found two High issues in the keeper service, both fixed: a vault built to make the keeper read
  forever, and an alarm key built to burn the gas of the alarms checked with it.
- **2026-11-06.** Found two more High issues in the keeper, both fixed: attacker exit jobs that could freeze the queue,
  and attacker positions that could spend the keeper's gas without a cap.

- **Third, of v2.** Found a flash-loan path to fire DRAIN with no loss (V3-01), keeper gas limits below AlarmBook's read
  floor (V3-02, fixed in the keeper), unchecked swap-leg decimals (V3-03) and a DRAIN sighting from before an arming
  counting toward a fire after it (V3-04). The first three are fixed; V3-04 is mitigated by the required quorum, with the remaining BOTH arm-time limitation documented above. Its proofs of concept are regression tests in
  `contracts/test/review/`, with its symbolic checks and mutation campaign.

The router's recipient restriction does not establish safety of a newly allowed adapter. v2 has not had an external audit.
