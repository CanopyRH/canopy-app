# Changelog

Every change that affects what runs, newest first. The contracts can't be upgraded, so every entry below is in the
services, the web app or the tooling unless it says otherwise.

## 2026-11-06

- **Web: "What Canopy can't do" page** (`limits.html`). Reads the router, Timelock and AlarmBook straight from the chain in
  the browser: the countdown to `ADMIN_EXPIRY`, what nobody can do (each tied to a line of the verified source), the adapters,
  guardian, arming pause, Timelock delay and proposer, and each watcher's start and end. A fact that can't be read is marked
  unread. The web config gains `deployBlock` (the event history starts there), and `web-base-config.ts` fills it from the deploy.

- **v2 contracts live on Robinhood Chain** at block 107737863: ExitRouter `0x1c3ca2B2f01C30B731909563Dad550062B340757`,
  AlarmBook `0x6A391f2c489dDFcb60Ad64eDddda5Ea0921584cf`, Timelock `0x4F656b09c4D3c859Dd2BB9919f384681e9ccb3f5`,
  ERC4626Adapter `0x32C39abF03a12303Cc3150be50eD7b0e03Ab9D38`. Exact matches on Sourcify, `verify.ts` 58 of 58, the 30 launch
  alarms registered. The services and web app switched to v2 the same day. v1 is retired (source at `v1-deployed`).
  - **Closed in the contracts:** no admin swap settings (the owner picks each swap leg), arming only on a clear alarm,
    resettable detectors, a vault drain that counts only as BOTH(DRAIN, QUORUM) with a one-day window, expiring and
    delayed watchers, gas-capped reads, payouts by balance change.
  - **Third internal review** ([report](.audit-grade/2026-11-06-v2/REPORT.md)): every finding fixed with a regression test,
    including a keeper High (attacker jobs in the listed fast lane) and the contract switch's races.
- **Indexer:** survives chain reorgs (rewind, undo, re-check), and checks each log's block hash.
- **API:** the read limit now applies on Railway (the caller is 2 entries from the end of X-Forwarded-For).
- **Your own alarm levels.** The app lets you pick the "Vault loss" level: 0.5%, 1%, 2%, 5% or 10% under the share
  price's high. A level is a plain SHARE_DROP key built like the preset, so the browser works out its key itself, and the
  app's rules are unchanged: it never arms a key that is going off, fired in the last day or can't be read. The keeper
  pokes, checkpoints and exits a paid position's level on a listed vault like a preset. There are only five level keys
  per vault, and every limit on unlisted and unpaid keys is as it was. No contract changed.
- **Second internal review.** The report is in [.audit-grade/2026-11-06](.audit-grade/2026-11-06/REPORT.md). Its fixes:
  - **Keeper.**
    - The exit queue keeps moving when an attacker fills it with jobs too big or too slow (A2-H1, A2-M1).
    - Listed vaults' exits go first and run in their own loop.
    - Every keeper transaction has a simulated gas limit.
    - Exits on unlisted contracts are capped and stop after repeated no-progress attempts (A2-H2).
    - Gas-burning and fake-tripped alarm keys are found and set aside (A2-M2, A2-M3).
  - **Detectors and watchers.**
    - Listed vaults are scanned first, follows are capped, and scan alerts go through the alert queue (A2-M4, A2-L1).
    - Watchers sign an exploit alarm only when the report names that vault, and a parked deposit can't fake a drain
      (A2-L3).
  - **API.** IPv6 callers are rate-limited per /64 (A2-L2). `/alarms/live` can be paged.
  - **Logs and data.** Every URL is scrubbed from logs, and old rows are pruned.
  - **App.** It never offers an alarm that is going off now, fired in the last day, or can't be read (A2-01).
  - **Docs.** SECURITY.md, INVARIANTS.md and the docs page now state the contracts' real limits.
- **Audit follow-ups.** The 2026-11-05 internal review, its PoCs and each finding's status are in
  [`.audit-grade/`](.audit-grade/2026-11-05/REPORT.md). Its scope is in
  [SCOPE.md](.audit-grade/2026-11-05/SCOPE.md), and the audited commit is tagged `audit-2026-11-05`.
- **Contract tests.**
  - A revert test for every error the router, alarm book and timelock can throw.
  - A stateful invariant suite for the router: 131,072 calls per CI run. See [contracts/INVARIANTS.md](contracts/INVARIANTS.md).
  - A fork test showing that no flash deposit or donation can set off a false "Vault loss" on any launch vault.
- **Static analysis.** Slither runs on the contracts in CI, with every medium-or-higher finding triaged and given a
  reason in `contracts/slither.db.json`. CodeQL scans the TypeScript.
- **Operator alerts** for every admin or guardian change (`AdapterSet`, `FeedSet`, `RouteSet`, `GuardianSet`,
  `ArmingPaused`, `WatcherSet`), and [INCIDENT.md](INCIDENT.md), a runbook for pausing and stopping.
- **Indexer.**
  - A log that fails to apply goes on a retry list with backoff instead of being skipped.
  - Plan payments count only after about 10 seconds of blocks (`CONFIRMATIONS`).
  - Each new arm is re-checked against the chain once its block is settled.
- **API.** Public reads are rate-limited per address (`RATE_LIMIT_PER_MIN`, default 120).
- **Database connections.** Each service holds at most 4 database connections by default (`DB_POOL`), so a full
  rollout stays under the database's limit.

## 2026-11-05

- **Keeper hardening (audit H-1, H-2).**
  - An armed contract that reports thousands of markets, or reads forever, can no longer stall the exit loop. The
    keeper caps markets at 32, runs each job on a time budget, handles listed vaults first, and sets aside jobs that
    time out.
  - A gas-burning alarm key can no longer hide the alarms checked with it. A failed batch falls back to checking each
    key alone, and failing keys are set aside for a while.
- **Audit Lows.**
  - The app warns when an alarm you arm with has already fired (L-1).
  - Telegram alerts go out from their own queue, with retries (L-2).
  - Watchers and the keeper act only on alarms for listed vaults or paid positions (L-3).
  - RPC URLs are removed from logs (L-4).
  - Secret tokens are compared in constant time.
- **SECURITY.md**, with every role, what it can and can't do, and the risks we accept. The admin wording in the README,
  docs and whitepaper is corrected.
- **CI.** Actions are pinned to commit SHAs, and gitleaks scans every push. The Bun version is pinned in each
  `package.json`, and Foundry's metadata settings are explicit (the bytecode is unchanged).
- **The mainnet fork test** picks the largest current holder, so it no longer fails when one holder withdraws.
- **Plug-ins.** Features can add API routes, bot commands, schema and web pages by adding files.
- **Web.** Docs, whitepaper and roadmap pages, WalletConnect for phone wallets, and the API at `api.canopyrh.com`.

## 2026-11-04

- **Live on Robinhood Chain mainnet (4663).** Contracts deployed at block 106087816 and verified with an exact match on
  Blockscout and Sourcify. The addresses are in the README.
