# Agent policy audit candidate

CanopyArmPolicy is an ERC-7579 **executor**, module type 2. Its only execution paths are a stricter arm
and an owner-account exit on the pinned router. A smart account installs it with one agent, expiry and
an owner-reviewed terms hash. The owner establishes the initial armed position. The agent can add keys
or reduce slippage; it cannot change harbour/swap legs, remove keys, disarm, approve tokens, transfer
funds, call arbitrary contracts or reactivate a position after owner disarm. No-op rearms are refused.

This is an intentional refinement of the PDF's Smart Sessions validation-policy design. Smart Sessions
checks action policies during ERC-4337 validation. Reading keysOf then is insufficient if another action
changes the floor before execution. This executor compares the live router state immediately before
its one permitted account call. Sequential calls see preceding changes. It does not claim compatibility
with Smart Sessions IActionPolicy or ERC-7715 grants.

The account must enforce executor installation and retain owner-only installation/uninstallation. The
agent must have no independent unrestricted account key or parallel module permission. Expiry/uninstall
ends this module's authority but does not disarm the owner's positions. Payout goes to the smart account.

Status: tested against a minimal ERC-7579 account fixture and the real local ExitRouter. **Not deployed,
not audited, no production account compatibility certification.** Next: real account implementation and
bundler integration tests, external audit, then an explicit owner installation flow. SDK/MCP continue to
return owner-reviewed unsigned transactions; they do not silently install this module.

Primary interfaces checked on 2026-11-06:
- https://github.com/erc7579/erc7579-implementation/blob/main/src/interfaces/IERC7579Account.sol
- https://github.com/erc7579/erc7579-implementation/blob/main/src/interfaces/IERC7579Module.sol
- https://github.com/erc7579/smartsessions/blob/main/contracts/interfaces/IPolicy.sol

ERC-8004 publishing and ERC-8183 funding hooks remain separate integrations: chain-4663 deployment
addresses, deployed code and draft interface compatibility must be verified before any binding or funding.
