# Invariants

The hard rules of the Canopy contracts, each in one sentence, with the tests that prove it. A test is named by its
file (a link) and its function. Run everything from `contracts/`.

The rules come from two places: the header comment of `ExitRouter` (rules R1 to R5, numbered as in the comment)
and the header and inline comments of `AlarmBook` (rules A1 to A10). The accounting rules the invariant suite
checks, which the comments imply but do not number, are R6 to R9. Timelock and the adapter have a few rules of their own at the end.

## How to run the tests

| What | Command | Notes |
| --- | --- | --- |
| Default suite | `forge test` | Fast. Includes a short smoke pass of the invariant suite (4 runs of 50 calls). |
| Invariant suite | `FOUNDRY_PROFILE=invariant forge test --match-path test/RouterInvariant.t.sol` | 512 runs of 256 calls, 131,072 calls in all. About a minute. |
| Mainnet fork suite | `forge test --match-contract '^(ForkTest|ForkCheckpointTest)$' -vv --fork-url https://rpc.mainnet.chain.robinhood.com` | Needs network access. Without a fork URL these tests return early and pass. |

The invariant profile is `[profile.invariant.invariant]` in [foundry.toml](foundry.toml). The suite is
[RouterInvariant.t.sol](test/RouterInvariant.t.sol): a handler contract arms, disarms, disarms all, pokes alarms,
exits as the owner, a keeper and strangers, blocks owners from receiving tokens so a payout is booked as owed,
claims, moves vault liquidity and prices, turns swap knobs, donates tokens to the router and moves time, across three
owners, four vaults and seven tokens. One of the vaults has its own share token as its asset. `test_handlerReachesTheInterestingStates` in the same file replays a fixed
sequence to show each of those paths is reachable.

---

## ExitRouter rules

### R1. Funds go to the position owner and nowhere else

`exit` has no recipient parameter, and every transfer out of the router is addressed to the position owner (the one
exception is the swap router, which pulls the input token of a swap the router asked for).

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_exitAbiHasNoRecipient`: the `exit` ABI has no address argument.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `testFuzz_anyCallerAnyAmount_onlyOwnerGains`: any caller and any amount, only the owner gains.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_keeperExit_onLiveKey`: a keeper exit pays the owner and the keeper gets nothing.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_evilAdapter_cannotTouchVictimApproval` and `test_evilVault_cannotReenterOrReachOwedFunds`: a hostile adapter or vault cannot redirect value.
- [Reverts.t.sol](test/Reverts.t.sol) `test_claimOwed_NothingOwed_ethOwnerStillRefuses_thenPays`: a stranger who triggers a claim gets nothing, the owner is paid.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_onlyTheOwnerIsEverPaid`: every token transfer out of the router, over 131,072 random calls, went to the owner of the position being exited (or the owner named in a claim).
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_nobodyElseHoldsAnyToken`: the keeper, strangers and the adapter never end up holding any of the seven tokens.
- [Fork.t.sol](test/Fork.t.sol) `test_fork_keeperExitPaysOwnerOnly` and `test_fork_everyLaunchVaultKeeperExit`: the same on the live launch vaults.

### R2. Only the owner, or anyone while an alarm the owner armed is live

A third party can exit a position only if the position is armed, the alarm key was armed on that position, and that
alarm fired after the arming and within the last 24 hours. A disarmed position is closed to everyone but its owner.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_keeperExit_rejectedWithNoAlarm`, `test_keeperExit_rejectedWithUnarmedKey`, `test_keeperExit_rejectedAfterTtl`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_alarmFiredBeforeArming_doesntAuthorizeAThirdParty`: an alarm that fired before the arming does not count.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_poisonedShareMark_cantExitALaterUser`: a poisoned alarm cannot exit a user who armed later.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_unknownPosition_reverts`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_exit_NotArmed_unknownPositionByStranger`, `test_exit_NotArmed_afterDisarm`, `test_exit_NotArmed_afterDisarmAll`, `test_exit_NotAuthorized_keyNotArmedForThisPosition`, `test_exit_AlarmNotLive_neverFired`, `test_exit_AlarmNotLive_firedBeforeArming`, `test_exit_AlarmNotLive_firedLongAgo`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm`: in every random sequence, each successful non-owner exit was on a position the model says is armed, with an armed key, with that alarm live since the arming.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_disarmedPositionsCantBeExitedByAStranger`: no non-owner exit ever succeeds on a disarmed position.

### R3. Exits are never gated by a pause, fee, plan check or oracle

Nothing but the position's own state can block an exit. The optional swap is skipped, and the raw token delivered,
whenever the oracle is stale, the stablecoin is off its peg, no route is set or the pool cannot fill at the
oracle-bounded minimum. A payout the owner cannot receive is booked as owed instead of reverting the exit.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_swap_noRouteDeliversRaw`, `test_swap_staleFeedDeliversRaw`, `test_swap_stableBelowFloorDeliversRaw`, `test_swap_brokenPoolDeliversRaw`, `test_swap_ownerBelowTenPercentCeilingDeliversRaw`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_badFeed_deliversRaw_forNoCodeAndOverflow`, `test_aFeedChangeAlone_turnsOffSwapsUntilReArm`, `test_aRouteChangeAlone_turnsOffSwapsUntilReArm`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_guardianCannotBlockExits`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_disarmedOwner_canStillExit_whileArmingIsPaused`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_blockedOwner_booksOwedThenClaims`, `test_owed_cannotBeBookedTwice`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_reentrancy_exitAndClaimAreBlockedDuringExit`; [Reverts.t.sol](test/Reverts.t.sol) `test_exit_Reentrancy_exitAndClaimInsideAnExit`.
- The reverts an exit can still hit are all facts about the position or its vault (never the admin, a fee or a service): [Reverts.t.sol](test/Reverts.t.sol) `test_exit_NothingToExit_ownerHoldsNoShares`, `test_exit_NothingToExit_noApproval`, `test_exit_NothingWithdrawn_vaultHasNoLiquidity`, `test_exit_TransferFromFailed_adapterRefusesShares`, `test_exit_NftNotReturned`, `test_exit_NothingWithdrawn_nftReturnedButNothingPaid`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_noFreeBalanceBeyondDonations`: after any exit, with payouts failing, swaps skipped or vaults only partly liquid, the router holds nothing free.

### R4. The owner can revoke instantly

`disarm`, `disarmAll` and revoking the token approval each stop every third-party exit at once, and only the owner
can call them for a position.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_disarm_stopsThirdParties`, `test_disarmAll_stopsEveryPosition`, `test_disarmAll_blocksExitsUntilRearmed`, `test_revokedApproval_movesNothing`, `test_disarm_onlyOwner`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_afterDisarmAll_ownerExits_butNoThirdParty`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_disarm_NotOwner_stranger`, `test_disarm_NotOwner_unknownPosition`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_onlyTheOwnerCanDisarm`: no non-owner disarm ever succeeds. `invariant_disarmedPositionsCantBeExitedByAStranger` covers that a revoke sticks.

### R5. Admin can only set adapters, feeds and routes, only until expiry; the guardian can only pause new arming; nobody can upgrade

The admin (a Timelock) has no power over funds or exits, loses even that power at `ADMIN_EXPIRY`, and disabling an
adapter never affects a position already armed. The guardian can pause only new arming, and only until expiry.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_admin_onlyAdminCanConfigure`, `test_expiry_endsAdminAndGuardian`, `test_expiry_pausedRouterAcceptsArmingAgain`, `test_disablingAdapter_doesNotBlockExistingPositions`, `test_guardianCannotBlockExits`, `test_setRoute_mustEndInStable`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_feedChangeAfterArming_cantReachAnArmedPosition`: a feed change cannot reach a position that is already armed.
- [Reverts.t.sol](test/Reverts.t.sol) `test_setAdapter_NotAdmin`, `test_setFeed_NotAdmin`, `test_setRoute_NotAdmin`, `test_setGuardian_NotAdmin`, `test_adminFunctions_NotAdmin_afterExpiry`, `test_setArmingPaused_NotGuardian_stranger`, `test_setArmingPaused_NotGuardian_afterExpiry`, `test_setGuardian_replacedGuardianLosesThePower`, `test_setFeed_BadFeed_noCode`, `test_setFeed_BadFeed_decimalsAboveMax`, `test_setRoute_BadRoute_tooShort`, `test_setRoute_BadRoute_misalignedLength`, `test_setRoute_BadRoute_startsAtAnotherToken`, `test_setRoute_BadRoute_endsAtAnotherToken`, `test_arm_ArmingIsPaused`.
- Not upgradable: the contract has no proxy, `delegatecall` or `selfdestruct`, and the admin and guardian are immutable or settable only by the admin. A test cannot prove an absence, so this one is a property of the source. `services/deploy/verify.ts` checks that the live bytecode is exactly this source.
- Known limit: the admin can set a feed or route that applies to positions armed afterwards, which is listed as an accepted risk in [SECURITY.md](../SECURITY.md).

### R6. Owed balances add up and are always backed

For each token, `totalOwed` equals the sum of every owner's `owed`, and never exceeds what the router holds.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_totalOwedIsTheSumOfOwedAndIsBacked`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_exitPreservesOwedOfOthers`, `test_owed_cannotBeBookedTwice`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_claimOwed_TransferFailed_ownerStillBlocked`: a failed claim changes nothing.

### R7. After an exit or claim, no free balance is left beyond what is owed

The exit pays out exactly what the unwind produced, so the router's balance of every token equals what it owes
plus anything strangers sent it directly. Direct gifts are never swept and never mistaken for exit proceeds.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_noFreeBalanceBeyondDonations`: balance minus `totalOwed` equals the tokens donated to the router, for all seven tokens, and the handler's per-call check saw no exit or claim change the free balance.

### R8. `claimOwed` pays only the named owner, and anyone may trigger it

- [Reverts.t.sol](test/Reverts.t.sol) `test_claimOwed_NothingOwed_nothingBooked`, `test_claimOwed_NothingOwed_wrongOwnerOrToken`, `test_claimOwed_NothingOwed_secondClaimAfterPaying`, `test_claimOwed_TransferFailed_ownerStillBlocked`, `test_claimOwed_NothingOwed_ethOwnerStillRefuses_thenPays`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_blockedOwner_booksOwedThenClaims`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_claimOwedClearsTheNamedOwnersBalance` and `invariant_onlyTheOwnerIsEverPaid`.

### R9. Only the caller can arm for themselves, within bounds

`arm` always arms for the caller, only through an allowed adapter, with a known harbour, a slippage cap of at most
10%, at most 8 keys, a token id only for NFTs, and an NFT only by its holder.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_arm_rejectsUnlistedAdapter`, `test_arm_rejectsSlipAboveCap`, `test_arm_rejectsTooManyKeys`, `test_arm_rejectsBadHarbour`, `test_arm_rejectsWhilePaused`, `test_arm_isBoundToCaller`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_arm_NotSupported_unlistedAdapter`, `test_arm_NotSupported_afterAdapterDisabled`, `test_arm_BadHarbour`, `test_arm_SlipTooHigh`, `test_arm_TooManyKeys`, `test_arm_NotOwner_nftHeldBySomeoneElse`, `test_arm_BadTokenId_erc20WithTokenId`.

---

## AlarmBook rules

### A1. An alarm can never move funds

An alarm only changes who may call `ExitRouter.exit`, and that call pays the owner only. `AlarmBook` holds no tokens,
takes no value and has no transfer path, so this rests on R1 and R2: a fired alarm, however it is made to fire, cannot
make a payout go anywhere else.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_onlyTheOwnerIsEverPaid` and `invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm`, with the handler firing alarms by `PAUSED` and `SHARE_DROP` pokes at random.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_poisonedShareMark_cantExitALaterUser`.

### A2. Anyone can register and poke, and registering is checked

Registration is open, idempotent for an existing key, and refuses a detector that could never work (no code, zero
threshold, a missing or empty reading, a bad quorum size, a `BOTH` whose parts do not exist or whose window is too short).

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_register_isIdempotentAndValidates`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_register_BadDetector_priceBelow`, `test_register_BadDetector_shareDrop`, `test_register_BadDetector_paused`, `test_register_BadDetector_addressChange`, `test_register_BadDetector_drain`, `test_register_BadDetector_quorum`, `test_register_BadDetector_both`, `test_register_existingKeyIsNotRevalidated`.

### A3. A detector fires only while its on-chain condition holds

`PRICE_BELOW`, `SHARE_DROP`, `PAUSED`, `ADDRESS_CHANGE`, `DRAIN`, `QUORUM` and `BOTH` fire only on their own condition. `poke` returns false, and does not revert, when the condition does not hold or the alarm is already live.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_priceBelow`, `test_priceBelow_ignoresStaleAnswer`, `test_shareDrop_andHighWaterMark`, `test_paused`, `test_addressChange`, `test_drain_andCheckpointRules`, `test_both_needsBothInsideWindow`, `test_quorum_pokeNeverFires`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_poke_aliveOrUntrippedReturnsFalseInsteadOfReverting`, `test_check_unknownKeyIsFalseNotRevert`.

### A4. The SHARE_DROP high-water mark only rises, and cannot be left stuck high

`checkpoint` moves the mark up, never down. The audit lead asked whether anyone can raise it with a one-transaction
price spike (flash deposit, donation, withdrawal) and so fire a false "Vault loss" later.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_shareDrop_markNeverFalls`, `test_shareDrop_smallDipDoesNotLowerMark`.
- [ForkCheckpoint.t.sol](test/ForkCheckpoint.t.sol) `test_fork_shareDropCheckpoint_everyLaunchVault`: on all five launch vaults, four spike attempts each, on the live state and after 180 idle days. None leaves the mark above the settled price, and none can fire the alarm.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_poisonedShareMark_cantExitALaterUser`: for a vault where the attack would work (a naive one that counts donations), the poison cannot exit a user who arms after it.

### A5. DRAIN never trusts one reading

A single `totalAssets` reading, such as one taken inside a flash deposit, never becomes a baseline. The lowest sample
of a whole period does, and nothing rolls while the detector is tripped, so a drain cannot be reset away.

- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_flashDeposit_cantRaiseTheBaseline`, `test_flashDeposit_onANewDetector_cantFire`, `test_flashSample_isPulledDownByTheNextHonestSample`, `test_midDrainCheckpoint_cantHideADrain`, `test_midDrainRoll_cantHideADrain`, `test_flashDeposit_cantResetATrippedDrain`, `test_samplesDuringATrippedDrain_cantLowerTheNextBaseline`, `test_quietVault_baselineFollowsRealGrowth`.
- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_drain_snapshotCannotResetAfterWindowWhileTripped`, `test_drain_snapshotExpires`, `test_drain_andCheckpointRules`.

### A6. An alarm cannot refire for 24 hours

After a fire, `poke` and `fireByQuorum` cannot fire the same key again until `REFIRE_AFTER` has passed.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_refireAfter24h`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_fireByQuorum_AlreadyLive`, `test_poke_aliveOrUntrippedReturnsFalseInsteadOfReverting`.

### A7. A quorum alarm needs k distinct, approved watchers with valid, fresh, low-s signatures

Signers must be sorted ascending and distinct, every one on the watcher list, each signing this chain's and this
contract's EIP-712 digest for this key. A signature lives at most one hour, shorter than the refire delay, so it
cannot fire twice. Malleable, wrong-length and rejected contract-wallet signatures fail.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_quorum_twoOfThreeFires`, `test_quorum_oneSignerFails`, `test_quorum_duplicateAndUnsortedFail`, `test_quorum_nonWatcherFails`, `test_quorum_removedWatcherFails`, `test_quorum_expiredFails`, `test_quorum_badSignatureFails`, `test_quorum_cannotFireAnotherKey`, `test_quorumAlarm_endToEndExit`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_reusedSignatures_cantOutliveTheRefireDelay`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_fireByQuorum_NotQuorumKind`, `test_fireByQuorum_Expired`, `test_fireByQuorum_deadlineEqualToNowIsStillValid`, `test_fireByQuorum_DeadlineTooFar`, `test_fireByQuorum_BadSigners_belowThreshold`, `test_fireByQuorum_BadSigners_noSigners`, `test_fireByQuorum_BadSigners_lengthMismatch`, `test_fireByQuorum_BadSigners_unsortedOrDuplicate`, `test_fireByQuorum_BadSigners_zeroAddressFirst`, `test_fireByQuorum_NotWatcher_neverApproved`, `test_fireByQuorum_NotWatcher_removed`, `test_fireByQuorum_BadSignature_signedAnotherDigest`, `test_fireByQuorum_BadSignature_signedByTheOtherWatcher`, `test_fireByQuorum_BadSignature_highS`, `test_fireByQuorum_BadSignature_wrongLengthOrEmpty`, `test_fireByQuorum_BadSignature_badRecoveryId`, `test_fireByQuorum_BadSignature_contractWatcherSaysNo`, `test_fireByQuorum_aFailedAttemptLeavesNothingFired`.

### A8. A BOTH alarm fires only when both of its parts fired within its window

Its window is at least the refire delay, so neither part can be stale by design, and a flash deposit cannot raise a part into firing it.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_both_needsBothInsideWindow`, `test_both_windowCantBeShorterThanTheRefireDelay`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_flashDeposit_cantRaiseAQuorumFiredBoth`, `test_preburnedDrain_stillLetsARealHackFireBoth`, `test_lateConfirmation_stillFiresBoth`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_register_BadDetector_both`.

### A9. Only the admin edits the watcher list

The list stays with the Timelock, so a bad watcher can always be removed.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_setWatcher_onlyAdmin`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_setWatcher_NotAdmin`.

### A10. Unknown keys are rejected

`poke`, `checkpoint` and `fireByQuorum` revert with `Unknown` for a key nobody registered; `check` and `isLive` answer false.

- [Reverts.t.sol](test/Reverts.t.sol) `test_poke_Unknown`, `test_checkpoint_Unknown`, `test_fireByQuorum_Unknown`, `test_check_unknownKeyIsFalseNotRevert`.

---

## Timelock and adapter

### T1. Changes wait out the delay, expire after a grace period, and only the proposer acts

The delay is capped at 30 days, a scheduled change lapses 14 days after it is ready, a failed change reports the inner error, and a cancelled or already-run change cannot run.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) (contract `TimelockTest`) `test_delayCeiling`, `test_zeroDelayAppliesInOneBatch`, `test_noChangeBefore48h`, `test_changeAfter48h`, `test_aScheduledChangeLapses`, `test_onlyProposer`, `test_cancel`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_constructor_DelayTooLong`, `test_schedule_NotProposer`, `test_cancel_NotProposer`, `test_execute_NotProposer`, `test_schedule_AlreadyScheduled`, `test_execute_NotReady_neverScheduled`, `test_execute_NotReady_beforeTheDelay`, `test_execute_NotReady_afterCancel`, `test_execute_NotReady_secondExecution`, `test_execute_Lapsed`, `test_execute_lastSecondOfTheGraceWindowStillWorks`, `test_execute_CallFailed_carriesTheInnerError`.

### D1. An adapter acts only for its router

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_adapter_onlyRouterCanUnwind`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_adapter_unwind_OnlyRouter`.

---

## Errors with no test, because no call can reach them

`AdapterBase.WrongTarget` and `SafeTransferLib.ApproveFailed` are declared and never thrown. Every other custom error
in `contracts/src` has a test in [Reverts.t.sol](test/Reverts.t.sol) that triggers it.
