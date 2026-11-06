# Changelog

Every change that affects what runs, newest first. The contracts can't be upgraded, so every entry below is in the
services, the web app or the tooling unless it says otherwise.

## 2026-11-06

- **Audit follow-ups.** The 2026-11-05 internal review, its PoCs and each finding's status are in
  [`.audit-grade/`](.audit-grade/2026-11-05/REPORT.md). Its scope is in
  [SCOPE.md](.audit-grade/2026-11-05/SCOPE.md), and the audited commit is tagged `audit-2026-11-05`.
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
