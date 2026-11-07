# Read-only alarm readers

These immutable readers implement `latestRoundData()` for the existing AlarmBook. They are prepared
source, not deployed addresses. Deploy and review a reader's exact constructor settings before offering
it in `Chain.lp.alarms` or another owner-facing preset. No default new alarm is armed.

- FeedHealthReader: answer 1 for stale/nonpositive/advisory-paused feeds, 2 otherwise. A broken read is
  unknown. Suitable for warnings/holding conversions; a feed-health alarm does not itself repay a loan.
- VaultLiquidityReader: redeemable-share coverage in bps **plus one**. Below 10001 means less than full
  coverage. Excludes Morpho V2, whose maxRedeem is unsupported. This is not an execution guarantee.
- PoolReserveReader: token reserve versus the pinned baseline, bps plus one. The preset builder always
  wraps it in BOTH(reader, QUORUM). Trades can change reserves; this is neither a rug verdict nor a TWAP.
- SessionReader: explicit UTC intervals, seconds-to-close plus one, 1 outside sessions. Outside the
  reviewed validity horizon it reverts. Holidays and DST require real intervals, not an assumed CET offset.

The optional service LP scan uses configured LP_POOLS, at least 30 prior observations and two low
observations separated by 60 seconds. It emits only a soft chain signal. A watcher still needs a report
naming the pool and the normal signing/approval rules. Creator clustering and a DEX TWAP price reader
are not implemented by a reserve-balance scan.
