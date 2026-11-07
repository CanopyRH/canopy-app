# Expansion implementation review

These additions are local release candidates, not activated deployments. Existing owner exits remain
unchanged. No exchange order, production transaction, new charge or public post was submitted.

## Running the tools

From `services`, run `bun src/expansion-cli.ts request.json`. Set `CANOPY_EXPANSION_RPC_URL` for
chain reads. The process accepts no wallet key and never signs or broadcasts. Unknown request fields
are rejected; bigint amounts are printed as decimal strings. RPC errors are deliberately not printed
because they can contain authenticated endpoint URLs.

Commands:

- `exposure`: `chainId`, `root`. Returns same-block facts and plain-language explanations. Reads stop
  at 256 calls, 32 markets, 20 nodes, depth 3 or a 15-second deadline. Compatible V2 adapters must name
  the parent vault. Duplicate adapters and markets are counted once. Amounts are denominated in each
  loan asset; they are not cross-asset portfolio weights or a complete valuation.
- `borrow-discover`: `chainId`, `morpho`, `owner`, `markets: [{id, health}]`. Maximum 64 reviewed
  market IDs. Failed reads appear separately as unknown markets.
- `borrow-prepare`: `chainId`, `guard`, `owner`, `morpho`, `alarmBook`, `market`, `health`, `executor`,
  and `policy`. The policy has `triggerLtvBps`, `targetLtvBps`, `sessionTargetLtvBps`,
  `preCloseSeconds`, `maxObservationAge`. Optional `session` contains a reviewed `calendar`, a
  timestamped `feed` observation, and `multiplierChanged`. See the strict schemas in the source.
  Binds the deployed guard to its owner, Morpho market and alarm book; requires a fresh chain head;
  reads allowance, balance and selected live alarms; calculates accrued debt and a capped repayment;
  simulates at the same block. Returns unsigned calldata only after simulation succeeds. Retains
  collateral for LTV targets. Unknown pricing may permit defensive debt repayment from the already
  approved allowance, but never an oracle-priced swap or a claimed target LTV. Re-prepare immediately
  before signing. Automated scheduling, flash unwind and real-market fork validation remain pending.
- `lighter-discover`: `owner`, optional `cursor`. Returns one page of owner-bound RH venue accounts.
- `lighter-account`: `owner`, `account`. Reads positions from the Robinhood-specific Lighter API.
- `identity-prepare`: `chainId`, `registry`, `codeHash`, `owner`, `registration`; optional `agentId`
  for an update and `implementation: {address, codeHash}` for an EIP-1967 proxy. Registration needs
  `name`, `description`, HTTPS `image`, `services` and `active`. Verifies runtime code and standard
  proxy slots, checks ownership on update, and simulates unsigned ERC-8004 calldata. Beacon proxies
  are rejected. Other proxy designs require manual bytecode review. No chain registry is assumed.
  Metadata asserts no trust or x402 capability. After mint confirmation, add the assigned identity ID.

## Contract candidates

`MorphoHeadroomReader` estimates accrued borrowing debt and requires a separately reviewed feed-health
reader. Its score is remaining capacity in basis points plus one; 1 means no remaining headroom.
`PriceDeviationReader` and `V3TwapDeviationReader` return 10001 minus relative price disagreement in
basis points. Unknown/stale data reverts. TWAP requires at least 60 seconds of observation history.
Feed/token correspondence and feed freshness settings need deployment review. DEX-derived signals
must use BOTH with watcher quorum. A successful numerical read does not establish asset quality.

`MorphoV2ForceExitAdapter` is explicit opt-in, pinned to one vault and one deallocation path. It tries
ordinary redemption first, caps the fee and verifies the actual payout. If forced redemption fails,
the whole transaction including the penalty reverts. It cannot create liquidity in a fully borrowed
market. Actual vault/adapter gates, rounding and share behavior need real-deployment fork tests.

`PerpsArmBook` holds policies, not credentials or funds. Owner revisions invalidate prior policies;
size budgets, expiry and selected live alarms constrain reporting. `CloseReported` is an executor
attestation, not cryptographic evidence of an exchange fill. A disarm cannot cancel an order already
submitted to a venue. The connector must reconcile terminal fills and recheck policy before signing.

`WatcherBond` and `KeeperBond` share an opt-in `OperatorBond`. They prove only equivocation: opposite
ECDSA decisions with the same signer, generation, subject, hour, snapshot and evidence. Distinct
observations or opinions are not slashable. EIP-712 binds chain, contract and role. Proofs expire seven
days after the epoch ends; withdrawals wait eight days and stop eligibility immediately. Old stake
generations cannot be replayed; each fault is consumed once. Slashes go to the immutable treasury,
without a submitter bounty. Exact-transfer, non-rebasing token behavior is required. Token, treasury,
minimum and slash amounts are constructor inputs requiring review, not approved economics. These
contracts do not change AlarmBook's Timelock-managed signer list. Missed-alarm, accuracy and late-job
slashing are deliberately not represented as implemented. External audit, legal review and a dry-run
challenge period precede activation.

## Verified interface references and unresolved dependencies

- [Robinhood Lighter domains](https://docs.robinhood.com/chain/lighter-domains/): RH uses its separate
  API. [Official SDK](https://github.com/elliottech/lighter-python/tree/38a34672e7cb43c67d807ece25f125fda2dfdecf)
  inspected at this commit; signing chain 466324 differs from settlement chain 4663. The key response
  exposes no scope field. SDK withdrawal and same-master-account transfer signing paths exist.
  This does not prove server permission, and does not establish a trade-only restriction. Hosted
  execution remains disabled until the venue supplies independently verifiable permissions.
- [Morpho V2](https://github.com/morpho-org/vault-v2/tree/470574ec00a625f821d079c5b5cc62f5518ec735)
  checked for adapter allocation and force-deallocation interfaces. No upstream contract source is
  vendored. Force-exit implementation still requires tests against the actual reviewed deployment.
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is a draft. Identity metadata and unsigned
  preparation are implemented; no chain-4663 registry deployment was verified or published to.
- [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) is a draft with differing funding signatures in
  the normative text and reference example reviewed here. A pinned deployed job kernel and exact hook
  interface are required before a funding hook can be implemented and represented as compatible.
- Arcus needs a confirmed deployed redeem interface. GMX/gTrade need deployment/version-specific
  restricted execution integration and fork tests. x402 requires actual settlement/reconciliation,
  approved pricing and payment configuration. None is represented as complete.
