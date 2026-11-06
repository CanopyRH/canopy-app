# Audit scope, 2026-11-05

Audited commit: `71c1fa0bd997bfa4504494789b99172123c295c2` in the public repo, tagged `audit-2026-11-05`. The report is [REPORT.md](REPORT.md).

In scope: every file below, read in full. The `web/` app was out of scope, except that `web/src/copy/docs.json` and `web/src/copy/whitepaper.json` were read as documentation.

## Contracts

- `contracts/src/AlarmBook.sol`
- `contracts/src/ExitRouter.sol`
- `contracts/src/Timelock.sol`
- `contracts/src/adapters/AdapterBase.sol`
- `contracts/src/adapters/ERC4626Adapter.sol`
- `contracts/src/interfaces/IAlarmBook.sol`
- `contracts/src/interfaces/IERC1271.sol`
- `contracts/src/interfaces/IExitAdapter.sol`
- `contracts/src/interfaces/IExternal.sol`
- `contracts/src/lib/FullMath.sol`
- `contracts/src/lib/ReentrancyGuard.sol`
- `contracts/src/lib/SafeTransferLib.sol`
- `contracts/src/lib/SignatureChecker.sol`

## Services

- `services/src/api/presets.ts`
- `services/src/api/server.ts`
- `services/src/billing/prepaid.ts`
- `services/src/bot/bot.ts`
- `services/src/chain/abi.ts`
- `services/src/chain/addresses.ts`
- `services/src/copy/alerts.ts`
- `services/src/detectors/index.ts`
- `services/src/detectors/scan.ts`
- `services/src/engine/classifier.ts`
- `services/src/engine/decide.ts`
- `services/src/engine/llmClassify.ts`
- `services/src/env.ts`
- `services/src/index.ts`
- `services/src/indexer/indexer.ts`
- `services/src/keeper/keeper.ts`
- `services/src/keeper/liquidity.ts`
- `services/src/keeper/ops.ts`
- `services/src/keeper/sender.ts`
- `services/src/keeper/simulate.ts`
- `services/src/risk/card.ts`
- `services/src/store/db.ts`
- `services/src/store/repo.ts`
- `services/src/store/schema.sql`
- `services/src/watcher/attest.ts`
- `services/src/watcher/feeds.ts`
- `services/src/watcher/watcher.ts`
