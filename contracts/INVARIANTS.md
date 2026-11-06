# Invariants

The hard rules of the Canopy v2 contracts, each in one sentence, with the tests that prove it. A test is named by its
file (a link) and its function. Run everything from `contracts/`.

The rules come from two places: the header comment of `ExitRouter` (rules R1 to R5, numbered as in the comment)
and the header and inline comments of `AlarmBook` (rules A1 to A13). The accounting rules the invariant suite
checks, which the comments imply but do not number, are R6 to R9. R10 is the cap on slippage when a third party runs the
exit, and R11 the owner's swap legs. Timelock, the adapter and the deploy script have a few rules of their own at the end.

## How to run the tests

| What | Command | Notes |
| --- | --- | --- |
| Default suite | `forge test` | Fast. Includes a short smoke pass of the invariant suite (4 runs of 50 calls). Fork tests return early. |
| Invariant suite | `FOUNDRY_PROFILE=invariant forge test --match-contract RouterInvariant` | 512 runs of 256 calls, 131,072 calls in all. A minute or two. |
| Mainnet fork suite | `forge test --match-contract '^(ForkTest\|ForkCheckpointTest\|ForkPresetsTest)$' -vv --fork-url https://rpc.mainnet.chain.robinhood.com` | Needs network access. Without a fork URL these tests return early and pass. |

The invariant profile is `[profile.invariant.invariant]` in [foundry.toml](foundry.toml). The suite is
[RouterInvariant.t.sol](test/RouterInvariant.t.sol): a handler contract arms (with the owner's swap legs on the stable
harbour), disarms, disarms all, pokes, checkpoints and rebases alarms, fires a quorum key with two of three watchers,
approves, extends and removes watchers, exits as the owner, a keeper and strangers, blocks owners from receiving tokens
so a payout is booked as owed, claims, moves vault liquidity and prices up and down, crashes a vault, turns swap knobs,
donates tokens to the router and moves time (sometimes past `ADMIN_EXPIRY`, sometimes through a week of daily pokes),
across three owners, four vaults, seven tokens and five alarm keys (two `PAUSED`, a `SHARE_DROP` and a `DRAIN` on the
same vault, and a `QUORUM`). One of the vaults has its own share token as its asset. The handler keeps its own model of
every alarm, written from the rules: when each key fired and when its episode began, the share-drop mark, DRAIN's
sampling and confirmation, and each watcher's term. `test_handlerReachesTheInterestingStates` and
`test_handlerReachesTheAlarmStates` in the same file replay fixed sequences to show each path is reachable.

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
- [Fork.t.sol](test/Fork.t.sol) `test_fork_keeperExitPaysOwnerOnly` and `test_fork_everyLaunchVaultKeeperExit`: the same on the live launch vaults, with v2 deployed by `Deploy.s.sol`.

### R2. Only the owner, or anyone while an alarm the owner armed is live

A third party can exit a position only if the position is armed, the alarm key was armed on that position, and that
alarm fired at or after the arming and within the last 24 hours. "At or after" includes a fire in the arming's own
second, but only one that comes after the arming transaction: a key that has fired in the last 24 hours can't be armed
at all (A11). A disarmed position is closed to everyone but its owner.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_keeperExit_rejectedWithNoAlarm`, `test_keeperExit_rejectedWithUnarmedKey`, `test_keeperExit_rejectedAfterTtl`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_alarmFiredBeforeArming_doesntAuthorizeAThirdParty`: a key that fired an hour ago can't be armed, and once it can, the old fire doesn't count.
- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_alarmFiredInTheSameSecondAsArmingAuthorizesAKeeper` and `test_alarmFiredBeforeArmingInTheSameSecondIsRefusedAtArming` pin both sides of the same-second line (A2-05).
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_poisonedShareMark_cantExitALaterUser`: a poisoned key can't be armed.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_unknownPosition_reverts`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_exit_NotArmed_unknownPositionByStranger`, `test_exit_NotArmed_afterDisarm`, `test_exit_NotArmed_afterDisarmAll`, `test_exit_NotAuthorized_keyNotArmedForThisPosition`, `test_exit_AlarmNotLive_neverFired`, `test_exit_AlarmNotLive_firedBeforeArming`, `test_exit_AlarmNotLive_firedLongAgo`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm` and `invariant_theRouterAgreesWithTheIndependentAlarmModel`: the handler's model of when an alarm may exit someone (the position is armed, this key was armed on it, the key fired at or after the arming, and no more than 24 hours ago) is built from the fire times the model itself predicted, never from `AlarmBook.isLive`. Every successful non-owner exit must be allowed by the model, and an exit the model allows must never be refused for an alarm reason.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_disarmedPositionsCantBeExitedByAStranger`: no non-owner exit ever succeeds on a disarmed position.

### R3. Exits are never gated by a pause, fee, plan check or oracle

Nothing but the position's own state can block an exit. The optional swap is skipped, and the raw token delivered,
whenever the oracle is stale or unreadable, the stablecoin is off its peg, the owner named no leg for that token, or the
pool cannot fill at the oracle-bounded minimum. A payout the owner cannot receive is booked as owed instead of reverting
the exit.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_swap_noLegDeliversRaw`, `test_swap_staleFeedDeliversRaw`, `test_swap_stableBelowFloorDeliversRaw`, `test_swap_brokenPoolDeliversRaw`, `test_swap_ownerBelowTenPercentCeilingDeliversRaw`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_aStaleLegFeed_deliversRaw`, `test_badFeed_rejectedAtArm_andOverflowDeliversRaw`.
- [RouterEdges.t.sol](test/RouterEdges.t.sol) `test_gasBurningFeed_costsBoundedGas_andTheRawTokenIsPaid`, `test_feedBurningGasInDecimals_isCappedToo`, `test_returnBombFeed_isNotCopied`: a hostile feed costs at most one capped read more than an honest one (A2-07).
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

### R5. Admin can only set adapters and the guardian, and pause new arming, only until expiry; the guardian can only pause new arming; nobody can upgrade

The admin (a Timelock) has no power over funds, exits or swaps, loses even that power at `ADMIN_EXPIRY`, and disabling
an adapter never affects a position already armed. v2 has no admin swap settings (M-1, A2-07). The guardian can pause
only new arming, and only until expiry.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_admin_onlyAdminCanConfigure`, `test_expiry_endsAdminAndGuardian`, `test_expiry_pausedRouterAcceptsArmingAgain`, `test_disablingAdapter_doesNotBlockExistingPositions`, `test_guardianCannotBlockExits`.
- [AdminSwapConfig.t.sol](test/AdminSwapConfig.t.sol) `test_adminHasNoSwapSettings`, `test_v1Exploit_adminFeedAndRoute_cantReachAStableHarbourExit` and `test_control_ownersHonestLeg_swapsAtAFairPool`: the M-1 proof of concept, inverted.
- [Reverts.t.sol](test/Reverts.t.sol) `test_noAdminSwapSettingsExist`: `setFeed`, `setRoute` and `swapConfig` are gone.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_adminAndGuardianCallsRevertAfterExpiry`: the handler jumps past `ADMIN_EXPIRY` and then calls `setAdapter`, `setGuardian` and `setArmingPaused` as the admin and the guardian. None ever succeeds. `test_adminCallsRevertFromTheExpirySecondOn` pins the first second.
- [Reverts.t.sol](test/Reverts.t.sol) `test_setAdapter_NotAdmin`, `test_setGuardian_NotAdmin`, `test_adminFunctions_NotAdmin_afterExpiry`, `test_setArmingPaused_NotGuardian_stranger`, `test_setArmingPaused_NotGuardian_afterExpiry`, `test_setGuardian_replacedGuardianLosesThePower`, `test_arm_ArmingIsPaused`.
- Not upgradable: the contract has no proxy, `delegatecall` or `selfdestruct`, and the admin and guardian are immutable or settable only by the admin. A test cannot prove an absence, so this one is a property of the source.

### R6. Owed balances add up and are always backed

For each token, `totalOwed` equals the sum of every owner's `owed`, and never exceeds what the router holds.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_totalOwedIsTheSumOfOwedAndIsBacked`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_exitPreservesOwedOfOthers`, `test_owed_cannotBeBookedTwice`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_claimOwed_TransferFailed_ownerStillBlocked`: a failed claim changes nothing.
- [RouterEdges.t.sol](test/RouterEdges.t.sol) `test_oneByteReturnToken_thatMovesIsPaidOnce_andNotBookedAsOwed` and `test_oneByteReturnToken_thatDoesntMoveIsBookedAsOwed_andClaimable`: a token returning 1 byte is judged by the router's balance, so a payout that moved is never also owed, and one that didn't is owed and backed (A2-06).

### R7. After an exit or claim, no free balance is left beyond what is owed

The exit pays out exactly what the unwind produced, so the router's balance of every token equals what it owes
plus anything strangers sent it directly. Direct gifts are never swept and never mistaken for exit proceeds.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_noFreeBalanceBeyondDonations`: balance minus `totalOwed` equals the tokens donated to the router, for all seven tokens, and the handler's per-call check saw no exit or claim change the free balance.

### R8. `claimOwed` pays only the named owner, and anyone may trigger it

- [Reverts.t.sol](test/Reverts.t.sol) `test_claimOwed_NothingOwed_nothingBooked`, `test_claimOwed_NothingOwed_wrongOwnerOrToken`, `test_claimOwed_NothingOwed_secondClaimAfterPaying`, `test_claimOwed_TransferFailed_ownerStillBlocked`, `test_claimOwed_NothingOwed_ethOwnerStillRefuses_thenPays`.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_blockedOwner_booksOwedThenClaims`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_claimOwedClearsTheNamedOwnersBalance` and `invariant_onlyTheOwnerIsEverPaid`.

### R9. Only the caller can arm for themselves, within bounds, and only on clear alarms

`arm` always arms for the caller, only through an allowed adapter, with a known harbour, a slippage cap of at most
10%, at most 8 keys each armable in AlarmBook (A11), valid swap legs (R11), a token id only for NFTs, and an NFT only by
its holder.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_arm_rejectsUnlistedAdapter`, `test_arm_rejectsSlipAboveCap`, `test_arm_rejectsTooManyKeys`, `test_arm_rejectsBadHarbour`, `test_arm_rejectsWhilePaused`, `test_arm_isBoundToCaller`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_arm_NotSupported_unlistedAdapter`, `test_arm_NotSupported_afterAdapterDisabled`, `test_arm_BadHarbour`, `test_arm_SlipTooHigh`, `test_arm_TooManyKeys`, `test_arm_NotOwner_nftHeldBySomeoneElse`, `test_arm_BadTokenId_erc20WithTokenId`, `test_arm_AlarmNotClear_unknownKey`, `test_arm_AlarmNotClear_trippedKey`, `test_arm_AlarmNotClear_firedInTheLastDay`, `test_arm_AlarmNotClear_unreadableKeyFailsClosed`, `test_arm_AlarmNotClear_oneBadKeyAmongGoodOnes`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_armingNeedsEveryKeyClear`: `arm` succeeded exactly when the model said every key was armable (and the other arguments were valid), and refused with `AlarmNotClear` when one wasn't.

### R10. A third party's swap never pays below 99% of the oracle price

When anyone but the owner runs the exit, the slippage allowed on the optional stablecoin swap is the smaller of the
owner's `maxSlipBps` and `THIRD_PARTY_SLIP_CAP_BPS` (1%). A wider limit, up to the owner's own 10% ceiling, applies
only to exits the owner sends. If the pool cannot fill within the cap, the swap is skipped and the raw token is paid.

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_swap_thirdPartyCappedAtOnePercent`: at 5% under the oracle, inside the owner's 10% limit, a keeper exit skips the swap.
- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_swap_thirdPartyInsideOnePercent` and `test_swap_userLimitBelowCapStillApplies`: a swap at the cap goes through, and a tighter limit set by the owner still applies.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_aThirdPartyExitNeverSwapsBeyondTheOnePercentCap`: in every random sequence, each swap leg of an exit run by a keeper or stranger was paid at no less than 99% of the oracle value, which the handler works out itself from the feeds.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_aSwapNeverPaysBelowTheOracleMinimum`: the same for every swap, owner exits included, against the oracle value less the slippage the position allows (rounding of 1 unit of the stablecoin is allowed).

### R11. Swap legs are the owner's, validated, and per position

Swap legs are allowed only with the stable harbour, at most 4, one per token, each with a feed that has code, a
staleness limit of 1 second to 2 days, at most 36 token decimals, and a well-formed Uniswap path from the token to the
stablecoin. They are stored per position, replaced on re-arm, announced by one `SwapLegSet` each, and an exit uses only
the position's own leg for a token (no leg: raw).

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_arm_storesLegsAndEmitsOnePerLeg`, `test_reArm_replacesTheLegs`, `test_legOfAnotherPositionIsNeverUsed`, `test_arm_legMustEndInStable`, `test_quoteMinOut_isAPublicViewOverTheLegsInputs`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_arm_SwapsNeedStableHarbour`, `test_arm_TooManySwaps`, `test_arm_DuplicateSwap`, `test_arm_BadFeed_noCode`, `test_arm_BadFeed_heartbeatOutOfRange`, `test_arm_BadFeed_decimalsAboveMax`, `test_arm_BadRoute_empty`, `test_arm_BadRoute_tooShort`, `test_arm_BadRoute_misalignedLength`, `test_arm_BadRoute_startsAtAnotherToken`, `test_arm_BadRoute_endsAtAnotherToken`, `test_arm_validMultiHopPathIsAccepted`.

---

## AlarmBook rules

### A1. An alarm can never move funds

An alarm only changes who may call `ExitRouter.exit`, and that call pays the owner only. `AlarmBook` holds no tokens,
takes no value and has no transfer path, so this rests on R1 and R2: a fired alarm, however it is made to fire, cannot
make a payout go anywhere else.

- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_onlyTheOwnerIsEverPaid` and `invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm`, with the handler firing alarms by `PAUSED`, `SHARE_DROP`, `DRAIN` and `QUORUM`.

### A2. Anyone can register and poke, and registering is checked

Registration is open, idempotent for an existing key, and refuses a detector that could never work (no code, zero
threshold, a missing or empty reading, a DRAIN window under 1,200 seconds, a bad quorum size, a `BOTH` whose parts do not
exist or whose window is too short).

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_register_isIdempotentAndValidates`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_register_BadDetector_priceBelow`, `test_register_BadDetector_shareDrop`, `test_register_BadDetector_paused`, `test_register_BadDetector_addressChange`, `test_register_BadDetector_drain`, `test_register_BadDetector_quorum`, `test_register_BadDetector_both`, `test_register_existingKeyIsNotRevalidated`.

### A3. A detector fires only while its on-chain condition holds

`PRICE_BELOW`, `SHARE_DROP`, `PAUSED`, `ADDRESS_CHANGE`, `DRAIN`, `QUORUM` and `BOTH` fire only on their own condition. `poke` returns false, and does not revert, when the condition does not hold or the alarm is already live.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_priceBelow`, `test_priceBelow_ignoresStaleAnswer`, `test_shareDrop_andHighWaterMark`, `test_paused`, `test_addressChange`, `test_drain_andCheckpointRules`, `test_both_needsBothInsideWindow`, `test_quorum_pokeNeverFires`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_poke_aliveOrUntrippedReturnsFalseInsteadOfReverting`, `test_check_unknownKeyIsFalseNotRevert`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_pokesFireExactlyWhenTheModelSays`: every random poke fired exactly when the handler's model predicted.

### A4. The SHARE_DROP high-water mark only rises, except by a rebase

`checkpoint` moves the mark up, never down, and only while the key reads clear. The audit lead asked whether anyone can
raise it with a one-transaction price spike (flash deposit, donation, withdrawal) and so fire a false "Vault loss" later.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_shareDrop_markNeverFalls`, `test_shareDrop_smallDipDoesNotLowerMark`.
- [ForkCheckpoint.t.sol](test/ForkCheckpoint.t.sol) `test_fork_shareDropCheckpoint_everyLaunchVault`: on all five launch vaults, four spike attempts each, on the live state and after 180 idle days. None leaves the mark above the settled price, and none can fire the alarm.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_poisonedShareMark_cantExitALaterUser`: for a vault where the attack would work (a naive one that counts donations), the poisoned key can't be armed.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_theAlarmBookMatchesTheIndependentModel`: after every call the stored mark equals the model's.

### A5. DRAIN never trusts one high reading, and needs a drop seen twice

A single high `totalAssets` reading, such as one taken inside a flash deposit, never becomes a reference: the lowest
sample of a whole period does, and nothing rolls while the detector is tripped, so a drain cannot be reset away. A
drop fires only when a poke sees it, and a later poke at least 60 seconds after it (and within the window) still sees
it. A poke that sees the vault whole, or can't read it, never cancels a sighting: a sighting only lapses once it is
older than the window, so a flash deposit between the two sightings can't hold a real drain off. Windows under 1,200
seconds are refused.

What stays (documented limits): a whale who dips twice a minute apart, within the window, can still fire; and low
samples taken by `checkpoint` lower the next reference. The app offers DRAIN only inside `BOTH` with a watcher quorum.

- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_flashDeposit_cantRaiseTheBaseline`, `test_flashDeposit_onANewDetector_cantFire`, `test_flashSample_isPulledDownByTheNextHonestSample`, `test_midDrainCheckpoint_cantHideADrain`, `test_midDrainRoll_cantHideADrain`, `test_flashDeposit_cantResetATrippedDrain`, `test_samplesDuringATrippedDrain_cantLowerTheNextBaseline`, `test_quietVault_baselineFollowsRealGrowth`.
- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_drain_snapshotCannotResetAfterWindowWhileTripped`, `test_drain_snapshotExpires`, `test_drain_andCheckpointRules`.
- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_drainIgnoresASingleLowReadingFromAFlashWithdrawal`, `test_drainFiresWhenTheDropIsSeenTwiceAMinuteApart`, `test_drainConfirmationLapsesAfterTheWindow`, `test_flashDepositBetweenSightingsCantHoldOffARealDrain`, `test_drainWindowsUnder1200sAreRefused_andTwoSamplesInOneFlashCantFire` (A2-02 fixed); `test_drainWhaleDippingTwiceAMinuteApartStillFires_documentedLimit` and `test_drainReferenceFollowsLowSamplesSoALaterRealLossCanGoUnseen` (the documented limits).
- [ForkPresets.t.sol](test/ForkPresets.t.sol) `test_fork_flashDepositAndDonationCantFireAnyPreset`: on all five launch vaults, a flash deposit and a donation fire no preset and start no confirmation.
- [AlarmReads.t.sol](test/AlarmReads.t.sol) `test_aDrainConfirmationSurvivesAnUnreadablePoke`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_pokesFireExactlyWhenTheModelSays` and `invariant_theAlarmBookMatchesTheIndependentModel`: the model's DRAIN sampling, pending time and confirmation match AlarmBook after every call, with the handler's `flashPokeDrain` poking inside flash deposits between sightings.

### A6. An alarm cannot refire for 24 hours

After a fire, `poke` and `fireByQuorum` cannot fire the same key again until `REFIRE_AFTER` has passed.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_refireAfter24h`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_fireByQuorum_AlreadyLive`, `test_poke_aliveOrUntrippedReturnsFalseInsteadOfReverting`.

### A7. A quorum alarm needs k distinct, active watchers with valid, fresh, low-s signatures

Signers must be sorted ascending and distinct, every one an active watcher (approval started, not ended), each signing
this chain's and this contract's EIP-712 digest (domain version "2") for this key. The one-hour limit is measured at
fire time, not at signing time, so a signature made with a far deadline can be fired by anyone in its last hour (it
still cannot fire twice). Malleable, wrong-length and rejected contract-wallet signatures fail.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_quorum_twoOfThreeFires`, `test_quorum_oneSignerFails`, `test_quorum_duplicateAndUnsortedFail`, `test_quorum_nonWatcherFails`, `test_quorum_removedWatcherFails`, `test_quorum_expiredFails`, `test_quorum_badSignatureFails`, `test_quorum_cannotFireAnotherKey`, `test_quorumAlarm_endToEndExit`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_reusedSignatures_cantOutliveTheRefireDelay`.
- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_farDeadlineQuorumSignatureCanFireByAnyoneInItsLastHour` (A2-03, kept), `test_contractWatcherThatApprovesCanSignViaErc1271`, `test_eoaWithCodeFallsBackToEcdsa`, `test_signatureForAnotherDeploymentIsRejected`, `test_domainSeparatorBindsTheChainIdAndTheContract`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_fireByQuorum_NotQuorumKind`, `test_fireByQuorum_Expired`, `test_fireByQuorum_deadlineEqualToNowIsStillValid`, `test_fireByQuorum_DeadlineTooFar`, `test_fireByQuorum_BadSigners_belowThreshold`, `test_fireByQuorum_BadSigners_noSigners`, `test_fireByQuorum_BadSigners_lengthMismatch`, `test_fireByQuorum_BadSigners_unsortedOrDuplicate`, `test_fireByQuorum_BadSigners_zeroAddressFirst`, `test_fireByQuorum_NotWatcher_neverApproved`, `test_fireByQuorum_NotWatcher_removed`, `test_fireByQuorum_NotWatcher_approvedButNotYetActive`, `test_fireByQuorum_NotWatcher_expired`, `test_fireByQuorum_BadSignature_signedAnotherDigest`, `test_fireByQuorum_BadSignature_signedByTheOtherWatcher`, `test_fireByQuorum_BadSignature_highS`, `test_fireByQuorum_BadSignature_wrongLengthOrEmpty`, `test_fireByQuorum_BadSignature_badRecoveryId`, `test_fireByQuorum_BadSignature_contractWatcherSaysNo`, `test_fireByQuorum_aFailedAttemptLeavesNothingFired`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_quorumNeedsActiveWatchers`: every random quorum fire succeeded exactly when the model said both signers were active and the key was not live.

### A8. A BOTH alarm fires only when both of its parts fired within its window

Its window is at least the refire delay, so neither part can be stale by design, and a flash deposit cannot raise a part into firing it.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_both_needsBothInsideWindow`, `test_both_windowCantBeShorterThanTheRefireDelay`.
- [AlarmAttacks.t.sol](test/AlarmAttacks.t.sol) `test_flashDeposit_cantRaiseAQuorumFiredBoth`, `test_preburnedDrain_stillLetsARealHackFireBoth`, `test_lateConfirmation_stillFiresBoth`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_register_BadDetector_both`.

### A9. Only the admin edits the watcher list; approvals wait two days and last at most a year

`setWatcher(w, until)`: `until == 0` removes at once; otherwise `until` is at most 365 days away, a watcher not active
now starts 2 days later, and extending (or shortening) an active watcher applies at once. The constructor's watchers
are active at once for 365 days. The list never leaves the admin, so a bad watcher can always be removed (A2-04).

- [AlarmBook.t.sol](test/AlarmBook.t.sol) `test_setWatcher_onlyAdmin`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_setWatcher_NotAdmin`, `test_setWatcher_BadWatcherTerm`, `test_setWatcher_removeIsImmediate`.
- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_newWatchersWaitTwoDays_evenAfterTheRouterAdminExpired` and `test_watcherApprovalsExpire_andExtendingAnActiveOneIsImmediate`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_quorumNeedsActiveWatchers` and `invariant_theAlarmBookMatchesTheIndependentModel` (`isWatcher` matches the model's terms after every call).

### A10. Unknown keys are rejected

`poke`, `checkpoint`, `rebase` and `fireByQuorum` revert with `Unknown` for a key nobody registered; `check`, `armable` and `isLive` answer false.

- [Reverts.t.sol](test/Reverts.t.sol) `test_poke_Unknown`, `test_checkpoint_Unknown`, `test_rebase_Unknown`, `test_fireByQuorum_Unknown`, `test_check_unknownKeyIsFalseNotRevert`, `test_arm_AlarmNotClear_unknownKey`.

### A11. A key is armable only when it exists, reads clear, and has not fired in the last 24 hours

A read that fails (reverts, runs out of its gas, or returns too little) means the key is not armable, except a `PAUSED`
view that reverts outright, which reads "not paused" (L-1, A2-01).

- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_armingOnALiveAlarmIsRefusedInsteadOfWaiting24h` (the RefireGap proof of concept, inverted), `test_aKeyThatFiredInTheLastDayIsNotArmable_evenIfClearNow`.
- [AlarmReads.t.sol](test/AlarmReads.t.sol) `test_failedReads_neverFire_andAreNeverArmable` and `test_pausedViewThatReverts_readsNotPaused_butOneThatBurnsGasIsNotArmable`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_armingNeedsEveryKeyClear` and `invariant_theAlarmBookMatchesTheIndependentModel` (`armable` and `check` match the model for every key after every call).

### A12. A key tripped for a week can be rebased, by anyone

`rebase` works only for `SHARE_DROP`, `ADDRESS_CHANGE` and `DRAIN`, only while the key reads tripped, and only once its
current episode (a run of fires each within 2 days of the last) began at least 7 days ago. It sets the baseline to the
current reading and ends the episode.

- [AlarmLimits.t.sol](test/AlarmLimits.t.sol) `test_shareDropKeyTrippedByALastingLossCantBeArmed_andRebasesAfterAWeek`, `test_addressChangeKeyRebasesToTheNewCuratorAfterAWeek`, `test_aGapOfMoreThanTwoDaysStartsANewEpisode`, `test_poisonedShareMarkCantBeArmed_andIsRebasedAway`, `test_rebaseRefusesKindsThatClearOnTheirOwn`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_rebase_Unknown`, `test_rebase_NotRebasable`, `test_rebase_EpisodeTooShort`, `test_rebase_NotTripped`, `test_rebase_NotTripped_unreadableTarget`.
- [RouterInvariant.t.sol](test/RouterInvariant.t.sol) `invariant_rebaseOnlyAfterAWeekLongEpisodeWhileTripped`.

### A13. Every target read gets exactly TARGET_READ_GAS, and a failed read never fires

Reads of a detector's target are capped at `TARGET_READ_GAS` (1,000,000) and copy at most five return words, and a
call with less gas left than the cap needs reverts `NotEnoughGas`, so a reading depends on the target and never on the
caller's gas. A failed read is "not tripped" for firing and "not clear" for arming.

- [AlarmReads.t.sol](test/AlarmReads.t.sol) `test_failedReads_neverFire_andAreNeverArmable`, `test_gasBurningTarget_costsAtMostTheCap`, `test_returnBombTarget_isNotCopied`, `test_aDrainConfirmationSurvivesAnUnreadablePoke`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_poke_NotEnoughGas`, `test_armable_NotEnoughGas_neverReadsClear`.
- [ForkPresets.t.sol](test/ForkPresets.t.sol) `test_fork_presetReadGas_everyLaunchVault`: on the five launch vaults every preset reading, measured cold, takes at most 248,221 gas (Steakhouse USDG, `convertToAssets`), about a quarter of the cap; the test fails if the headroom ever drops under 3x.

---

## Timelock, adapter and deployment

### T1. Changes wait out the delay, expire after a grace period, and only the proposer acts

The delay is capped at 30 days, a scheduled change lapses 14 days after it is ready, a failed change reports the inner error, and a cancelled or already-run change cannot run.

- [AlarmBook.t.sol](test/AlarmBook.t.sol) (contract `TimelockTest`) `test_delayCeiling`, `test_zeroDelayAppliesInOneBatch`, `test_noChangeBefore48h`, `test_changeAfter48h`, `test_aScheduledChangeLapses`, `test_onlyProposer`, `test_cancel`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_constructor_DelayTooLong`, `test_schedule_NotProposer`, `test_cancel_NotProposer`, `test_execute_NotProposer`, `test_schedule_AlreadyScheduled`, `test_execute_NotReady_neverScheduled`, `test_execute_NotReady_beforeTheDelay`, `test_execute_NotReady_afterCancel`, `test_execute_NotReady_secondExecution`, `test_execute_Lapsed`, `test_execute_lastSecondOfTheGraceWindowStillWorks`, `test_execute_CallFailed_carriesTheInnerError`.

### D1. An adapter acts only for its router

- [ExitRouter.t.sol](test/ExitRouter.t.sol) `test_adapter_onlyRouterCanUnwind`.
- [Reverts.t.sol](test/Reverts.t.sol) `test_adapter_unwind_OnlyRouter`.

### D2. The deploy needs no admin batch, and checks every wiring fact

`Deploy.s.sol` creates the Timelock, the AlarmBook with the `WATCHERS` active, the adapter pointing at the router's
address predicted from the deployer's nonce, and the router with that adapter allowed; `check` proves the prediction,
the admin, guardian, expiry, tokens, feed, domain and each watcher's term.

- [Deploy.t.sol](test/Deploy.t.sol) `test_validConfigDeploysAndWires`, `test_deployTwiceFromTheSameAccount_predictsEachRouter`, `test_checkCatchesAnAdapterPointingElsewhere`, `test_checkCatchesAMissingWatcher`, `test_rejectsBadWatcherLists`, and the v1 checks that remain (`test_rejectsPersonalWalletAdminByDefault`, `test_eoaOverrideNeverWorksOnMainnet`, `test_eoaOverrideNeverWorksOnRobinhood`, `test_delayIsASetting`, `test_rejectsSameProposerAndGuardian`, `test_rejectsZeroAdmins`, `test_rejectsMissingContracts`, `test_rejectsWrongDecimalStable`, `test_rejectsBadOrStaleFeed`, `test_rejectsBadHeartbeat`, `test_rejectsExpiryOutsideRange`, `test_checkCatchesWrongWiring`).
- [Fork.t.sol](test/Fork.t.sol), [ForkPresets.t.sol](test/ForkPresets.t.sol): every fork test deploys v2 with `Deploy.s.sol`'s own `validate`, `deploy` and `check`.

---

## Every error has a test

Every custom error declared in `contracts/src` has a test in [Reverts.t.sol](test/Reverts.t.sol) that triggers it
(`SafeTransferLib.TransferFromFailed` and `TransferFailed` included). v2 removed the two errors v1 declared and never
threw (`AdapterBase.WrongTarget`, `SafeTransferLib.ApproveFailed`).
