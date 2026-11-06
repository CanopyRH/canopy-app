# Incident runbook: pausing and stopping

This page is for the people who hold a Safe signer key or the hosting dashboard. It covers the four things you may need
in a hurry: pausing new arming, reacting to an admin alert nobody expected, and stopping a keeper or a watcher. The
roles and who holds them are in [SECURITY.md](SECURITY.md).

The short version: **a pause only stops new arming.** Nobody's money is held by the pause, and nobody is locked in.

## Who can pause, and what a pause does

Only the guardian can pause arming, and the guardian is a **2-of-3 guardian Safe**. Two of its three signers must
approve. (The admin Timelock can also call the same function, but use the guardian Safe first: it has no delay and no
schedule step.) The power ends on 2027-11-04 (`ADMIN_EXPIRY`); after that date nobody can pause.

| While arming is paused | Still works |
| --- | --- |
| Nobody can arm a new position. `arm` reverts with `ArmingIsPaused`. | **Exits**, by an alarm or by the owner (Exit Now) |
| | **Disarming**, one position or all of them |
| | **Claims** of anything owed (`claimOwed`) |
| | Positions already armed, which still exit when their alarm fires |

A pause does not touch the keeper, the watchers, the indexer or the alerts. They carry on as before. It cannot move
funds, change who is paid or block an exit, so it is safe to use on a suspicion. Pausing costs only that new users
can't arm until it is lifted.

## Pause arming through the guardian Safe

You need the ExitRouter address (in the README's deployment list, and the `ROUTER` setting the services run with) and
two guardian signers.

1. Signer 1 opens the guardian Safe in the Safe web app, on Robinhood Chain (4663).
2. Choose **New transaction**, then **Transaction Builder**.
3. Enter the ExitRouter address. The Safe reads the interface from the verified source. If it can't, paste the
   ExitRouter ABI.
4. Pick the function `setArmingPaused`, set `paused` to `true`, and add it. As raw data this is
   `0x044768d80000000000000000000000000000000000000000000000000000000000000001` sent to the ExitRouter with value 0.
5. Create the batch, sign it, and send it to the queue.
6. Signer 2 opens the queue and checks what they are signing: the **To** address is the ExitRouter, the method is
   `setArmingPaused`, and `paused` is `true`. If anything differs, reject it and tell the others. Then confirm.
7. Once two have signed, either signer presses **Execute** and pays the gas.
8. Check it worked. On the ExitRouter's page on the block explorer, open **Read contract** and read `armingPaused`. It
   must say `true`. The operator chat also gets an `ArmingPaused` alert with `paused=true`.

## Unpause

Do this only when the reason is understood and fixed.

1. Repeat the steps above with `paused` set to `false`. The raw data ends in `...0000`, that is
   `0x044768d80000000000000000000000000000000000000000000000000000000000000000`.
2. Signer 2 checks the same things: To is the ExitRouter, the method is `setArmingPaused`, `paused` is `false`.
3. After execution, read `armingPaused` on the explorer. It must say `false`, and the operator chat shows the matching
   alert.
4. Tell users arming is open again.

## An admin alert fires that nobody expected

The operator chat gets a message for every `AdapterSet`, `FeedSet`, `RouteSet`, `GuardianSet`, `ArmingPaused` and
`WatcherSet` event, with the arguments and a link to the transaction. Every one of these should match a change the
admin Safe signers know about. If one does not:

1. **Ask first, for a few minutes.** Post in the signers' private channel: "Did anyone propose this?" Compare it with
   the Safe's transaction history. A planned change always has a Safe transaction behind it.
2. **Open the transaction link.** A real admin change is a call from the admin Safe into the Timelock, which then calls
   the ExitRouter or AlarmBook. A pause or guardian change comes from the guardian Safe. A change from any other address
   means a key or a contract is compromised: go straight to step 3.
3. **Pause arming** with the guardian Safe, as above, unless the unexpected event is itself a pause you wanted. This
   stops new positions from being armed under settings nobody approved. If the guardian has been replaced by an address
   that isn't ours (`GuardianSet`), the admin Safe can pause through the Timelock instead, and can set the guardian back.
4. **Undo the change** through the admin Safe and the Timelock. With a 0 delay, one batch schedules and executes:
   - `AdapterSet(adapter, true)`: set it back to `false`. An unreviewed adapter must not be armed against.
   - `AdapterSet(adapter, false)`: harmless to armed positions, since it only blocks new arming. Re-enable it if it was
     ours.
   - `FeedSet` or `RouteSet`: no feed or route is set today and the app doesn't offer the swap exit, so any such event is
     unexpected. Positions already armed are not affected, because a position uses the feed and route set before it was
     armed. Clear or restore the setting before the swap is ever offered.
   - `GuardianSet`: set the guardian back to the guardian Safe.
   - `WatcherSet(watcher, true)` for a watcher we don't run: call `setWatcher(watcher, false)` on the AlarmBook. An
     alarm needs 2 approved watcher signatures, so one bad watcher can't fire an alarm alone, but remove it anyway.
   - `ArmingPaused(true)` nobody asked for: find who called it. If it was the guardian Safe, ask the guardian signers. If
     the Timelock, treat it as an admin compromise.
5. **Tell users** if arming was paused or an adapter was involved: they can disarm at any time, and exits stay open. The
   admin can't move funds, change who is paid or block an exit, so nobody has to rush.
6. **Write it down**: what fired, what you found, what you changed, and the transaction links. Rotate the signer key
   that was involved.

## Stop the keeper

The keeper holds gas only and no user funds. Stopping it does not stop anyone's exit: anyone can run a keeper, and an
owner can always exit from the app. Stop it if it is sending bad transactions or its key is exposed.

1. In the hosting dashboard (Railway), open the `keeper` service.
2. Remove its latest deployment, or use **Settings, Remove deployment**. The service stops within seconds.
3. To keep it from starting again on the next deploy, delete the `KEEPER_PRIVATE_KEY` variable. Without a key, the
   service has nothing to send with and does nothing.
4. If the key may be exposed, move its remaining gas to a new address (it holds nothing else), and put a fresh key in
   when you restart.
5. Check the alerts: with the keeper off, exits wait for a keeper, so restart one soon or tell users to use Exit Now.

## Stop a watcher

A watcher signs alarms from public reports. One watcher alone can't fire an alarm: the contract needs 2 approved
signatures.

1. Stop the host. In the hosting dashboard, remove the latest deployment of that `watcher` service. To keep it down,
   delete its `WATCHER_PRIVATE_KEY` variable.
2. If its key may be exposed or it signed something wrong, **remove it from the allowed list**: the admin Safe sends,
   through the Timelock, `setWatcher(watcher, false)` on the AlarmBook. The `WatcherSet` alert confirms it.
3. Take its address out of the `WATCHERS` setting on every service, and out of the `WATCHER_PEERS` list on the other
   watchers, then redeploy them.
4. A watcher that signed something wrong may have started a quorum. Read the AlarmBook for the key's state and check
   the `Fired` events. A fired alarm can't be undone, but it only lets keepers return funds to their owners.
5. When a replacement is ready, add it with `setWatcher(newWatcher, true)` and set its address in `WATCHERS`.

## Who to tell

The signers of the affected Safe, then the rest of the team. If you suspect funds can reach anyone but an owner, stop
and report it privately as SECURITY.md describes before you say anything in public.
