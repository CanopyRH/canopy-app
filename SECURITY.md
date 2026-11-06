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
| Router and AlarmBook admin | Timelock, 0 delay, run by a 2-of-3 admin Safe | Allow or disallow adapters, set price feeds and swap routes, change the guardian | Move funds, change who is paid, disarm a position, block an exit, change an armed position's alarms | Router: 2027-11-04 00:00 UTC (`ADMIN_EXPIRY`) |
| Watcher list | The same Timelock | Approve and remove watchers | Fire an alarm alone; every watcher alarm needs 2 approved signatures | Never, so a bad watcher can always be removed |
| Guardian | A 2-of-3 guardian Safe | Pause new arming | Pause exits, disarming or claims | 2027-11-04 |
| Payments | A 2-of-3 payments Safe | Receive plan payments | Anything in any contract | n/a |
| Keeper | Canopy's keeper key (gas only) | Send exits that a fired alarm allows, paying the owner | Choose who is paid | n/a; anyone can run a keeper |

Every admin change is a public transaction from the admin Safe through the Timelock.

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
  exit you on that firing; the next firing can. Use Exit Now instead. The app warns about this.
- **Feed settings come from the admin.** `setFeed` takes the token's decimals from the admin, and the staleness limit
  has no upper bound. Both are covered by the trust in the first point.
- **A position stays armed after an exit**, with nothing left in it. That's harmless; disarm it to tidy up.

## Audit status

The contracts haven't had an external audit. They have unit, fuzz and mainnet fork tests, and their source is verified
on Blockscout and Sourcify with an exact match.

An internal review on 2026-11-05 found two High issues in the keeper service, both now fixed: a vault built to make
the keeper read forever, and an alarm key built to burn the gas of the alarms checked with it. It found no way for
anyone to send a user's funds anywhere but the owner.
