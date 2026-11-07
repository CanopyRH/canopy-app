# Run an independent Canopy watcher

This kit runs the existing v2 indexer, detector and watcher, not a second engine. Bun 1.4.4 and PostgreSQL 18
are required. From `services/`, run `bun install --frozen-lockfile`. Copy `watcher-node/env.example` to a
private env file, fill deployment addresses from the reviewed chain deployment, then run
`bun --env-file=/absolute/private/watcher.env src/index.ts` from `services/`. Use a separate database per network.

Set `ROLE=indexer,detector,watcher` and `KEEPER_PAID_ONLY=false`. No Telegram bot or plan receiver is required.
Add `keeper` only to submit transactions, with a separate gas-only key. Signing reports needs a watcher key
and classifier credentials. Neither key is a user's wallet key. Never commit secrets.

Run `bun --env-file=/absolute/private/watcher.env ../watcher-node/preflight.ts` first. This checks RPC chain ID,
v2 contracts, watcher approval and activation delay without printing a key or provider URL. A new signer
must be approved by the existing Timelock and wait two days. Owning a key or bond does not grant permission.
Base still needs its Canopy deployment and activation.

`WATCHER_EVIDENCE_DIR` archives a content-addressed JSON bundle before each signature is gossiped. Back it up
and publish reviewed bundles through an operator-controlled static host. Bundles contain the signed report
hash and this node's chain signals. The shared report hash does not claim identical chain observations.
Preserve the corresponding report bodies from the `feed_items` database with their content hashes.
Do not publish connection strings or source credentials.

Optional `WATCHER_PROFILE_FILE` points to a JSON array of `{signer, operator, modelFamily, primarySource}`.
These are locally reviewed claims, not proof of independence. When set, this keeper assembles quorums with
distinct values in all three fields. Labels never come from peers. The live AlarmBook checks approved
signers only: other keepers can still use existing rules. Network-wide diversity enforcement needs governance
and contract changes. AI alone never signs; existing rules require a chain signal plus a report.

This kit adds neither bonds nor subjective slashing. Those require a separately audited, objectively provable
fault specification. A disputed headline is not sufficient evidence to seize a bond.
