# Operational hardening and rollout

This release changes services, the app, SDK and deployment tooling. It does not deploy contracts, rotate signers, publish a report or authorize production transactions. The deployed v2 `contracts/src` files are unchanged. Review these steps before activating the release.

| Area | Source change | Remaining operator action |
| --- | --- | --- |
| Report attribution | Exact content hash + source + chain + vault address approval; brand matching removed; depeg reports cannot confirm exploits | Each watcher operator reviews real reports and maintains its own short-lived approvals |
| Watcher correlation | Hosted quorum submission requires diversity profiles by default; public status displays configuration | Establish actual independent operators, models and primary sources; profiles are assertions, not proof |
| Reference upkeep | Listed DRAIN/SHARE_DROP presets maintained regardless of paid positions; existing paid/live scope for other keys and gas caps retained | Register listed presets, fund keeper, monitor checkpoints and verify nonzero fresh references |
| Arm readiness | App, SDK and hosted API check BOTH components and drain references | Existing direct v2 calls can bypass off-chain checks; enforce in a separately reviewed replacement router |
| Approval cleanup | Owner-only per-vault disarm and allowance revocation, available at zero balance | Owner confirms the transactions; other router/adapter approvals need separate cleanup |
| Timelock | New mainnet deployment tooling defaults to and requires at least seven days; adapter helper checks actual delay | Existing zero-delay Timelock and router ADMIN are immutable: migration requires a new deployment and owner opt-in |
| Role separation | New mainnet deploy checks disjoint admin/guardian owners, threshold >=2; preflight includes payments | Rotate live Safe owners using separately controlled signers; verify Safe modules, thresholds and human independence |
| Adapter trust | Mainnet admission refuses short delays and requires a current exact runtime-hash approval | Independent adapter review, deployment verification, delayed Safe schedule/execute and user consent |

## Service rollout

1. Stop watcher signing and hosted quorum submission while updating. Preserve existing evidence and queues for private investigation. Review any queued quorum work and previously issued signatures; the new attribution policy cannot invalidate already valid on-chain signatures. Wait until their actual deadlines have passed before claiming the old signing window is closed. Do not bulk-delete exit work. The owner can always use Exit now.
2. Install pinned dependencies and update all watcher, keeper and API processes. Keep `WATCHER_REQUIRE_DIVERSITY=true`. Without `WATCHER_PROFILE_FILE`, hosted quorum submission stays disabled. The public `/status` watcher policy reports this host's configuration only; it is not an assertion that remote peers are configured or independent.
3. Each real watcher operator creates the existing `watchnet/diversity.ts` profile format: an array of `{signer, operator, modelFamily, primarySource}`. Require unique operators, model families and primary sources for the selected quorum. Do not relabel one operator or shared model pipeline to pass the check. On-chain 2-of-N rules remain unchanged, and other callers can submit signatures directly. The watcher-list Timelock authority does not expire with router admin.
4. Set `WATCHER_APPROVAL_FILE` to a protected local JSON file, initially `{"version":1,"reports":[]}`. Keep it outside the public repo and outside model/peer write access. The watcher reads it each pass; malformed or oversized files fail closed. Missing approvals mean no feed signatures.
5. For an actual incident, review the exact `feed_items.raw` text and its recorded `source_url`. Independently establish the affected chain and exact vault addresses. A brand, curator name, asset symbol, or an LLM-provided address is insufficient. Confirm affected vaults, not every product sharing the brand. Do not approve depegs as exploit confirmations. Export the stored text verbatim to a local UTF-8 file; adding a newline changes its hash. From `services/`, run:

   ```sh
   bun deploy/report-approval.ts report.txt https://approved-source.example/feed 4663 0xVERIFIED_VAULT EXPIRY_UNIX_SECONDS
   ```

   The tool emits JSON for the operator to review and place atomically into the approval file. It does not fetch, validate the factual claim, sign or publish anything. Approvals bind SHA-256 of exact text, exact HTTPS source, chain, exact targets and review/expiry times; maximum lifetime is 24 hours. Expired, future-dated, wrong-chain, wrong-source and changed-byte reports are refused. Feed URL must also remain in `FEED_URLS`. Only reports classified `EXPLOIT_CONFIRMED` with a separate recent vault-specific on-chain soft signal can be signed. Recent-report selection remains one hour; approval does not extend it.
6. Register the listed presets using the existing registration tooling. Run the keeper with its usual paid-position policy and gas caps; listed reference upkeep is now independent of that policy. Checkpoints execute immediately on loop startup, then DRAIN every 10 minutes and SHARE_DROP every hour, subject to the keeper's checkpoint eligibility and gas budget. Check each DRAIN state's `snap`, `prevSnap`, `snapAt` against its window. Two nonzero period references are required. A new 3600-second preset normally needs two half-window rolls; an older untouched registration may roll immediately on its first checkpoint and need only one further half-window. Do not promise an exact one-hour activation time. Zero vault assets cannot create a usable nonzero reference.
7. Verify each listed drain preset is ready in the app and SDK; warming, stale, unreadable, pending and recently fired parts must refuse arming. Maintenance interruptions can leave existing positions armed without drain coverage. Keep monitoring and fund gas. Resume feed signing only once real operator profiles and incident approvals are configured. Hard alarms and owner exits do not depend on feed attribution.

## Governance and adapter admission

Create a private JSON file containing public addresses only: `{chainId, timelock, admin, guardian, payments}`. Run this read-only preflight from `services/`:

```sh
bun deploy/governance-check.ts governance.json https://YOUR_RPC
```

Exit 0 means the checked address-level policy passed; exit 2 reports policy failures; exit 1 is an unreadable/invalid snapshot. Reads are pinned to one block and its hash is rechecked. The tool verifies chain, proposer, delay, thresholds and pairwise owner separation. It cannot establish human independence or verify Safe bytecode/modules. The existing deployment is expected to fail until governance is changed. No transaction is sent.

The new Deploy script validates mainnet delay >=604800 seconds and admin/guardian signer separation even when its `deploy` helper is called directly. Match `TIMELOCK_DELAY` and `settings.json.timelockDelay`; historical deployment records must retain the actual delay. Never edit a record to make a live zero-delay deployment appear compliant. `ADMIN` and Timelock `DELAY` are immutable, so replacing only a settings file or deploying an unused Timelock cannot fix the live router. A migration needs separately reviewed contracts, verification, operational rehearsal, consent and allowance cleanup on the old router.

For a new mainnet adapter, supply a local review JSON with `{chainId, adapter, runtimeHash, reviewedAt, expiresAt}`. `runtimeHash` is keccak256 of deployed runtime bytecode; maximum approval lifetime is 30 days. Review proxy/upgradeability and dependencies separately: a code hash alone cannot prove safety. The helper checks actual chain and Timelock delay as well as adapter wiring and the current approval, then emits separate schedule and execute batches:

```sh
bun deploy/enable-adapter.ts deployment.json 0xADAPTER out https://YOUR_RPC adapter-review.json
```

It refuses the existing zero-delay mainnet deployment. Generated files are unsigned; executing Safe transactions remains an operator action. Recheck code and dependencies before executing after the delay. Existing positions retain their recorded adapter.

## Owner cleanup

The app's **Plan and controls → Revoke a vault allowance** lists every configured vault, including zero-balance ones. The owner must explicitly accept stopping automatic exits. It disarms that vault position first, then sets its router allowance to zero, waits for receipts and verifies the result. A rejected disarm does not advance to revoke. A rejected/failed revoke is reported as incomplete and can be retried. These are separate transactions, not an atomic batch. Refresh and verify state if another wallet session changes the position concurrently.

An exit does not disarm. Disarm All does not revoke allowances. Later deposits can still be exited while an armed key is live, or after a subsequent valid firing. Arming continues to use an unlimited share allowance. The control covers the configured ERC-4626 router; inspect other routers and NFT adapters separately. The agent/MCP API gains no disarm or revocation authority.

## Local verification

Regression coverage includes wrong-chain/source/hash attribution, approval expiry, depeg rejection, positive verified report signing, listed upkeep without subscribers, cold/stale/pending BOTH components, block-pinned SDK/API readiness, partial revocation failures, zero-delay adapter refusal, shared Safe owner refusal and a local Anvil drain warm-up flow. Run package tests and type checks, build the web/SDK, and run all Foundry tests before mirroring. No production state change is part of these tests. Private correspondence and review attachments do not belong in the public release.
