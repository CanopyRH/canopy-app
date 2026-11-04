<p align="center">
  <img src=".github/assets/banner.svg" alt="Canopy: automatic exits for DeFi vaults. Every exit pays the position owner." width="100%">
</p>

# Canopy

Canopy watches the ERC-4626 vaults you hold. When an alarm you chose fires, such as a share-price drop, a vault drain or an exploit that independent watchers confirm, a keeper exits your position and sends the vault's asset to your own wallet.

The exit contract has no "send to" field. Every exit pays the position owner and nobody else. A faulty keeper or a false report can, at worst, take you out early.

Canopy runs on **Robinhood Chain** (chain 4663). Base is planned next.

> **Status:** live on Robinhood Chain mainnet since 2026-11-04. The contracts have **not had an external audit yet**. Use small amounts until one is published here.

## How it works

1. **Check a wallet.** The web app reads your vault positions in your browser. It never asks for a seed phrase, a login or any ID.
2. **Pick alarms.** Each launch vault has presets: vault loss (share price down more than 0.5%), exploit confirmed (2 of 3 approved watchers), vault drain, and curator change.
3. **Arm once.** Approve your vault shares to the `ExitRouter` and arm the position.
4. **If an alarm fires,** a keeper calls the router, which redeems your shares and pays the asset to you.
5. **Exit Now and Disarm All** work at any time, and they're free.

### Alarms

### Contracts

| Contract | Role |
|---|---|
| `AlarmBook` | Registry of alarm detectors. Anyone can register one or `poke` it; a quorum alarm fires only on signatures from approved watchers. |
| `ExitRouter` | Holds armed positions and runs exits. It always pays the owner. |
| `ERC4626Adapter` | Redeems ERC-4626 vault shares for the router. |
| `Timelock` | The admin of `AlarmBook` and `ExitRouter`, controlled by a 2-of-3 Safe. |
