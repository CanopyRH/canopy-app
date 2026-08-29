# Canopy

Canopy watches the ERC-4626 vaults you hold. When an alarm you chose fires, such as a share-price drop, a vault drain or an exploit that independent watchers confirm, a keeper exits your position and sends the vault's asset to your own wallet.

The exit contract has no "send to" field. Every exit pays the position owner and nobody else. A faulty keeper or a false report can, at worst, take you out early.

Canopy runs on **Robinhood Chain** (chain 4663). Base is planned next.

> **Status:** live on Robinhood Chain mainnet since 2026-11-04. The contracts have **not had an external audit yet**. Use small amounts until one is published here.
