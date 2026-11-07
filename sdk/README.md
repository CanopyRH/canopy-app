# Canopy TypeScript SDK

Read listed vault positions, inspect app alarm presets and prepare unsigned owner transactions. There is no signer,
private-key input, disarm method or broadcast method. This first version supports the app's listed ERC-4626 vaults
on configured live deployments. Base remains unavailable until its deployment configuration is filled in.

This is a repository-source SDK, not a published npm package. It imports the existing app's configuration, calldata
builders, alarm checks, receipt reader and the services' generated contract ABIs. Those modules remain the source
of truth; LP and stable-exit integrations can extend them without a second set of presets or routes.

From the repository root, with Bun 1.4.4 on PATH:

```sh
cd web && bun install --frozen-lockfile && cd ..
cd services && bun install --frozen-lockfile && cd ..
cd sdk && bun install --frozen-lockfile && bun test && bun run typecheck
```

From a TypeScript program in this repository:

```ts
import { createCanopy, toJson } from "./sdk/src/index";

const canopy = createCanopy({ chainId: 4663 });
const wallet = await canopy.checkWallet("0xYourWalletAddress");
console.log(toJson(wallet)); // bigint values become decimal strings

// An owner chooses keys from listAlarms(vault), reviews the terms and reviews the plan.
const alarms = await canopy.listAlarms("0xListedVaultAddress");
// await canopy.armPosition(owner, vault, ownerChosenKeys);
// await canopy.tighten(owner, vault, additionalOwnerChosenKeys);
// await canopy.exitNow(owner, vault);
// await canopy.exitReceipt(transactionHash);
```

Addresses above are placeholders. Pass real EVM addresses. `rpcUrl` can override the RPC locally; the SDK checks
its chain ID before every operation. Wallet reads go to that RPC, never to Canopy's API. There is no telemetry or
database. The RPC operator can see the addresses queried, as can an agent host receiving the results.

## Methods

| Method | Result |
| --- | --- |
| `checkWallet(owner)` | Shares, asset amounts, armed keys, liquidity indication and explicit per-vault read failures. Includes tiny positions and armed positions with no shares. Coverage is listed vaults only. |
| `explainPosition(owner, vault)` | Plain factual explanation with block references, owner/curator addresses, alarm options and explicit unknowns. No generated safety score or automatic alarm selection. |
| `listAlarms(vault)` | Existing app presets and clear / going-off / unreadable status, including quorum dependencies. |
| `armPosition(owner, vault, keys)` | Ordered unsigned registrations, share approval if needed, and raw-asset arming. Refuses to replace an already armed position. |
| `tighten(owner, vault, additionalKeys)` | Adds preset keys, preserves every old key, harbour, slippage limit and swap leg. Refuses active alarms, unreadable state, no-ops and more than eight keys. |
| `exitNow(owner, vault)` | Simulates then prepares a free owner exit. Works for a recorded position after disarming too. Does not submit it or promise a complete withdrawal. |
| `exitReceipt(hash)` | Reuses the existing chain-based receipt reader and page link. |

## Reviewing a transaction plan

Every step includes `chainId`, `from`, `to`, `data`, zero `value` and a purpose. The owner must review the terms
included in an arming plan. The approval, when needed, matches the app's **unlimited vault-share approval** to its
configured router. It is identified separately in the plan. There is no recipient parameter; the router pays the owner.

Reads for a proposal use one mined block. A plan is a snapshot, not a reservation or an execution authorization.
Before signing, rebuild against fresh state, simulate in the owner's wallet and wait for each prerequisite transaction
to confirm. Missing registrations mean the final arm cannot be simulated successfully until those registrations land.
An active alarm is never reset by these tools. The router also checks armability during execution.

`tighten` is an **owner-approved proposal**, not the PDF's ERC-7579 policy module. Rearming resets the arming time;
a concurrent owner change after the read can make a saved proposal stale. Enforcing a floor against an agent's session
key needs the separate audited account policy. Do not give an agent unrestricted signing authority on the strength
of these software checks.

The explanation does not yet resolve nested allocations, oracle/session data or external ratings. Plan/keeper
coverage is not checked. Read failures are unknowns, never evidence of safety.

`bun run build` emits an ESM bundle in `dist/` with `viem` external. Source imports still require the repository;
publication, package declarations and independent distribution are separate release work.

## Research suite

Ten additional read-only/local research tools are included. See [the launch guide](../docs/research-launch.md) for methods, input formats, deployment and verification. Existing transaction-preparation tools retain their original owner-review boundary.
