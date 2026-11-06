# Security

## Reporting a problem

Please report anything that could put funds at risk or stop exits privately, through
[GitHub private vulnerability reporting](https://github.com/CanopyRH/canopy-app/security/advisories/new). Don't open a
public issue for it. Include what you found, how to reproduce it, and what it affects. We aim to answer within two days.

## Scope

- The contracts in `contracts/src`. v1 is deployed on Robinhood Chain (4663), with its source tagged `v1-deployed`;
  addresses are in the README. v2 (this branch) is not deployed yet.
- The services in `services/`: the keeper, indexer, detectors, watchers, API and Telegram bot.
- The web app in `web/`.

The deployed contracts can't be upgraded, so a contract bug is fixed by deploying new contracts that people choose to
move to, never by changing the ones in use. v2 is that new deployment: it closes the contract findings of the two
internal reviews (M-1, L-1, A2-01, A2-02, A2-04, A2-05, A2-06, A2-07) and the third review's V3-01, V3-03 and V3-04. Until a user moves, their position is on v1, and
v1's accepted risks (listed in this file at the `v1-deployed` tag) still apply to it.

## Who holds which power (v2)

| Role | Held by | Can | Can't | Ends |
| --- | --- | --- | --- | --- |
| Router admin | A Timelock run by a 2-of-3 admin Safe. The Timelock delay is a deploy setting (`TIMELOCK_DELAY`, default 0) | Allow or disallow adapters for new positions (`setAdapter`), change the guardian, pause and unpause new arming (`setArmingPaused`) | Move funds, change who is paid, disarm a position, block an exit, change an armed position's alarms, or set any swap feed or route: there are no admin swap settings in v2 | `ADMIN_EXPIRY`, a deploy setting between 180 and 730 days after deployment |
| AlarmBook admin (watcher list) | The same Timelock | Approve a watcher (`setWatcher`) for at most 365 days; a new approval starts 2 days after the call (`WATCHER_DELAY`). Extend an active watcher (at once). Remove a watcher (at once) | Fire an alarm alone; every watcher alarm needs 2 active watchers' signatures. Make a new watcher sign sooner than 2 days. Approve anyone for more than a year at a time. Move funds | Never: the list stays with the Timelock so a bad watcher can always be removed. The watchers named at deployment are active at once, for 365 days |
| Guardian | A 2-of-3 guardian Safe | Pause new arming | Pause exits, disarming or claims | `ADMIN_EXPIRY` |
| Payments | A 2-of-3 payments Safe | Receive plan payments | Anything in any contract | n/a |
| Keeper | Canopy's keeper key (gas only) | Send exits that a fired alarm allows, paying the owner. The keeper picks the amount, the timing within the 24 hours the alarm is live, and the gas | Choose who is paid, or lower the swap minimum below the owner's limit or 1% under the oracle | n/a; anyone can run a keeper |
| Anyone | | Register detectors, poke and checkpoint them, rebase a key that has been tripped for a week, claim owed tokens for their owner | Arm for someone else, exit someone else without a live armed alarm | n/a |

So the worst the admin plus two watcher keys can do is fire a QUORUM key with watchers approved at least two days
earlier, which exits the positions armed on it early, to their owners. Each `WatcherSet` event shows the approval's
start, so an owner who distrusts a new watcher has two days to disarm.

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
  before it can't be armed.
- **A2-02 and V3-01 (DRAIN).** Windows under 1,200 seconds are refused. A drop fires only when two pokes at least 60
  seconds apart both see it, within the window. A poke that sees the vault whole in between doesn't cancel the first
  sighting (it only lapses after the window), so a flash deposit can't hold a real drain off. The reference is the
  lower of the lows of the last two sampling periods, so one flash-inflated sample in a period nobody else sampled can't
  fire the key: that takes two consecutive periods with no honest sample.
- **V3-04 (DRAIN sighting before arming).** A DRAIN key with a pending sighting can't be armed, so both sightings of any
  fire that exits a position come after its arming.
- **V3-03 (swap leg decimals).** `arm` reads each leg token's own `decimals()` (gas-capped) and refuses a leg that
  states other decimals, which would have shrunk the oracle minimum by a power of ten.
- **A2-04 (watchers).** Approvals wait 2 days, last at most a year, and lapse unless extended.
- **A2-06 (1-byte token returns).** When a token's transfer returns 1 to 31 bytes, the router checks its own balance:
  tokens that moved are paid, tokens that didn't are booked as owed.

## Risks we accept (v2)

- **DRAIN still trusts the vault's own readings.** A holder of a quarter or more of a vault can withdraw, poke and
  redeposit twice, a minute apart and within the window, and fire a DRAIN key with no loss. Because a whole reading
  never cancels a sighting, an honest poke between the two dips doesn't stop that either. Anyone who is the only one
  to sample a vault for two consecutive periods can inflate its reference with flash deposits and fire with no loss.
  Low samples taken by `checkpoint` lower the reference, so a real loss can later go unseen. The keeper samples listed
  vaults every period, and the app offers DRAIN only inside BOTH with a watcher quorum, so a DRAIN fire alone exits no
  one.
- **A PAUSED detector on a target without the view never fires.** If the view reverts, the key reads "not paused".
  None of the five launch vaults has a `paused()` view, so the "Paused" preset can't fire on them.
- **No admin delay by default.** The admin can't move funds, change who is paid or touch an armed position's alarms or
  swaps, and owners can disarm in one transaction. The delay is a deploy setting.
- **A quorum signature with a far deadline** becomes usable by anyone in its last hour (it still can't fire twice).
  Watchers cap their own deadlines at 10 to 30 minutes.
- **The sender of an exit controls its gas.** A sender who supplies too little gas for the optional swap makes it skip,
  and the owner gets the raw token instead of the stablecoin. The amount is never less than what the vault paid out.
- **A position stays armed after an exit**, with nothing left in it. That's harmless once the alarm's 24 hours are
  over: if the owner deposits into the same vault again before then, a keeper can exit the new shares on the same
  firing. Disarm it to tidy up.

## Audit status

The contracts haven't had an external audit. They have unit, fuzz, invariant and mainnet fork tests, Slither runs in
CI, and v1's source is verified on Blockscout and Sourcify with an exact match.

Internal reviews are in [`.audit-grade/`](.audit-grade/) and [`contracts/test/review/`](contracts/test/review/):

- **2026-11-05.** Found two High issues in the keeper service, both fixed: a vault built to make the keeper read
  forever, and an alarm key built to burn the gas of the alarms checked with it.
- **2026-11-06.** Found two more High issues in the keeper, both fixed: attacker exit jobs that could freeze the queue,
  and attacker positions that could spend the keeper's gas without a cap.

- **Third, of v2.** Found a flash-loan path to fire DRAIN with no loss (V3-01), keeper gas limits below AlarmBook's read
  floor (V3-02, fixed in the keeper), unchecked swap-leg decimals (V3-03) and a DRAIN sighting from before an arming
  counting toward a fire after it (V3-04). All fixed; its proofs of concept are regression tests in
  `contracts/test/review/`, with its symbolic checks and mutation campaign.

No review found a way for anyone to send a user's funds anywhere but the owner. v2 has not had an external audit.
