# Security

## Reporting a problem

Please report anything that could put funds at risk or stop exits privately, through
[GitHub private vulnerability reporting](https://github.com/CanopyRH/canopy-app/security/advisories/new). Don't open a
public issue for it. Include what you found, how to reproduce it, and what it affects. We aim to answer within two days.

## Scope

- The contracts in `contracts/src`, deployed on Robinhood Chain (4663). Addresses are in the README.
- The services in `services/`: the keeper, indexer, detectors, watchers, API and Telegram bot.
- The web app in `web/`.

The deployed contracts can't be upgraded, so a contract bug is fixed by deploying new contracts that people choose to
move to, never by changing the ones in use.

## Who holds which power

| Role | Held by | Can | Can't | Ends |
| --- | --- | --- | --- | --- |
| Router admin | Timelock, 0 delay, run by a 2-of-3 admin Safe | Allow or disallow adapters, set price feeds and swap routes, change the guardian, pause and unpause new arming (`setArmingPaused`) | Move funds, change who is paid, disarm a position, block an exit, change an armed position's alarms | Router: 2027-11-04 00:00 UTC (`ADMIN_EXPIRY`) |
| AlarmBook admin (watcher list) | The same Timelock | Approve (`setWatcher`) and remove watchers | Fire an alarm alone; every watcher alarm needs 2 approved signatures. Move funds | Never. The watcher list does not expire with `ADMIN_EXPIRY`, so a bad watcher can always be removed, and the admin plus 2 watcher keys can fire any QUORUM key. Funds still go only to owners, so the worst case is an early exit |
| Guardian | A 2-of-3 guardian Safe | Pause new arming | Pause exits, disarming or claims | 2027-11-04 |
| Payments | A 2-of-3 payments Safe | Receive plan payments | Anything in any contract | n/a |
| Keeper | Canopy's keeper key (gas only) | Send exits that a fired alarm allows, paying the owner. The keeper picks the amount and the timing within the 24 hours the alarm is live | Choose who is paid | n/a; anyone can run a keeper |

Every admin change is a public transaction from the admin Safe through the Timelock. The operator chat gets an alert for
each `AdapterSet`, `FeedSet`, `RouteSet`, `GuardianSet`, `ArmingPaused` and `WatcherSet` event. To pause arming, react to
an alert nobody expected, or stop a keeper or watcher, follow [INCIDENT.md](INCIDENT.md).

## Risks we accept

- **The optional exit to stablecoin trusts the admin's feed and route.** A position armed with the swap uses the price
  feed and route set before it was armed. A wrong feed or route could make that swap pay far less than fair value. A
  change after arming doesn't apply: the position pays the vault's own asset until its owner arms again. No feed or
  route is set today, and the app doesn't offer the swap. Before it does, Canopy will alert on every `FeedSet`,
  `RouteSet` and `AdapterSet` event.
- **No admin delay.** The team chose 0 delay because the admin can't move funds or change who is paid, and owners can
  disarm in one transaction. The comment at the top of `ExitRouter.sol` still says "Timelock (48h)". The delay is 0;
  the source can't change because it must match the deployed bytecode exactly.
- **An alarm that already fired.** If you arm a position with an alarm that fired in the last 24 hours, a keeper can't
  exit you on that firing; the next firing can. Use Exit Now instead. The app doesn't offer such an alarm.
- **A tripped alarm never resets (A2-01).** After a lasting loss in the share price, a SHARE_DROP key's high-water mark
  stays where it was, so the key stays tripped and fires again every 24 hours. An ADDRESS_CHANGE key stays tripped for
  good after one curator change. Anyone who arms such a key is exited at the next refire. Mitigation: the app reads
  `check` and the last firing time of every key before arming, and doesn't offer one that is tripped now or fired in
  the last 24 hours, and the arming call reads them again before it sends anything. The "Vault loss" preset is a bare
  SHARE_DROP key, so a lasting loss makes it unavailable for that vault. Someone who arms by hand can still do it.
- **DRAIN trusts single low readings (A2-02).** A holder of about 40% of a vault can withdraw, poke and redeposit in one
  transaction and fire a DRAIN key with no loss. Low samples taken by checkpoint lower the reference, so a real loss can
  later go unseen. A window of 1 or 2 seconds is accepted by the contract. Mitigation: the app offers DRAIN only inside
  BOTH with a watcher quorum, so a false fire alone exits no one, and it refuses to register a DRAIN window under 1,200
  seconds.
- **A hostile feed can make a Stable-harbour exit cost about 20 times the gas (A2-07).** A feed that burns all the gas
  it is given makes the optional swap exit need several million gas. It can't stop the exit, because a sender who
  supplies enough gas gets the raw token paid to the owner. It rests on the same admin trust as the first point, and
  the app doesn't offer the swap today. Mitigation: Canopy will alert on every `FeedSet`, `RouteSet` and `AdapterSet`
  event before the swap is offered.
- **Feed settings come from the admin.** `setFeed` takes the token's decimals from the admin, and the staleness limit
  has no upper bound. Both are covered by the trust in the first point.
- **A position stays armed after an exit**, with nothing left in it. That's harmless once the alarm's 24 hours are
  over: if the owner deposits into the same vault again before then, a keeper can exit the new shares on the same
  firing. Disarm it to tidy up.

## Audit status

The contracts haven't had an external audit. They have unit, fuzz and mainnet fork tests, and their source is verified
on Blockscout and Sourcify with an exact match.

An internal review on 2026-11-05 found two High issues in the keeper service, both now fixed: a vault built to make
the keeper read forever, and an alarm key built to burn the gas of the alarms checked with it. It found no way for
anyone to send a user's funds anywhere but the owner.
