<p align="center">
  <img src=".github/assets/banner.svg" alt="Canopy: automatic exits for DeFi vaults. Every exit pays the position owner." width="100%">
</p>

# Canopy

Canopy watches the ERC-4626 vaults you hold. When an alarm you chose fires, such as a share-price drop, a vault drain or an exploit that independent watchers confirm, a keeper exits your position and sends the vault's asset to your own wallet.

The exit contract has no "send to" field. Every exit pays the position owner and nobody else. A faulty keeper or a false report can, at worst, take you out early.

Canopy runs on **Robinhood Chain** (chain 4663). Base is planned next.

> **Status:** live on Robinhood Chain mainnet since 2026-11-04. The contracts have **not had an external audit yet**. Use small amounts until one is published here.

## How it works

<p align="center">
  <img src=".github/assets/how-an-exit-works.svg" alt="How an exit works: an alarm fires, a keeper calls exit, the router pulls the shares you approved, the vault redeems them, and the asset goes to your wallet." width="100%">
</p>

1. **Check a wallet.** The web app reads your vault positions in your browser. It never asks for a seed phrase, a login or any ID.
2. **Pick alarms.** Each launch vault has presets: vault loss (share price down more than 0.5%), exploit confirmed (2 of 3 approved watchers), vault drain, and curator change.
3. **Arm once.** Approve your vault shares to the `ExitRouter` and arm the position.
4. **If an alarm fires,** a keeper calls the router, which redeems your shares and pays the asset to you.
5. **Exit Now and Disarm All** work at any time, and they're free.

### Alarms

<p align="center">
  <img src=".github/assets/what-fires-an-alarm.svg" alt="What can fire an alarm: a share-price drop is checked on-chain every second and anyone can poke it. A drain, a curator change or an exploit report needs 2 of 3 approved watchers to sign." width="100%">
</p>

### Contracts

| Contract | Role |
|---|---|
| `AlarmBook` | Registry of alarm detectors. Anyone can register one or `poke` it; a quorum alarm fires only on signatures from approved watchers. |
| `ExitRouter` | Holds armed positions and runs exits. It always pays the owner. |
| `ERC4626Adapter` | Redeems ERC-4626 vault shares for the router. |
| `Timelock` | The admin of `AlarmBook` and `ExitRouter`, controlled by a 2-of-3 Safe. |

### Admin limits

- The admin can't redirect any payout. A position keeps its adapter, and a feed or route change applies only when the owner re-arms.
- The router's admin powers end on **2027-11-04** (`ADMIN_EXPIRY`). After that, the router's settings can't change.
- A separate guardian Safe can pause **new arming only**. Exits always stay open.
- The `AlarmBook` admin manages the approved watcher list, and that role doesn't expire.

## Deployments

Robinhood Chain (4663), deployed at block 106087816:

| Contract | Address |
|---|---|
| Timelock | [`0xA37196aCb22146424C1984001c18F49877B10D9b`](https://robinhoodchain.blockscout.com/address/0xA37196aCb22146424C1984001c18F49877B10D9b) |
| AlarmBook | [`0x550cC2Ad4c2f095c37B8362bd19c475Ab7576e4d`](https://robinhoodchain.blockscout.com/address/0x550cC2Ad4c2f095c37B8362bd19c475Ab7576e4d) |
| ExitRouter | [`0xC867A4B38f7B9F7CCc121D61b2F8d200395a965C`](https://robinhoodchain.blockscout.com/address/0xC867A4B38f7B9F7CCc121D61b2F8d200395a965C) |
| ERC4626Adapter | [`0x14E6f3a2Cd259148f983E2b01Fe778c5002c98BC`](https://robinhoodchain.blockscout.com/address/0x14E6f3a2Cd259148f983E2b01Fe778c5002c98BC) |

The broadcast record is in `contracts/broadcast/`, and `services/deploy/verify.ts` checks that the deployed bytecode matches this source.

## Repository

| Folder | What it holds |
|---|---|
| `contracts/` | Solidity contracts, tests and the deploy script (Foundry, solc 0.8.28) |
| `services/` | Keeper, indexer, watcher, risk-card detector and Telegram bot (Bun, TypeScript, Postgres). One image runs every role. |
| `web/` | The web app and landing page, a static build |
| `tools/` | The reproducible web build and small helpers |
