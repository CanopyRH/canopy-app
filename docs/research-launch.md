# Canopy Research — launch guide

This release adds ten product workflows to the existing Canopy app. They are available through `research.html`, a field guide at `research-guide.html`, ten SDK methods, ten MCP tools, and a JSON CLI. Six workflows read public sources; four calculate or verify locally. The existing seven MCP tools remain available, making seventeen in total.

This is a source release candidate. Publication to the public mirror and deployment of the API and static assets are separate operator actions. No contract changes, Safe signature, token approval, trading key, funds transfer, or alarm activation is required for these ten tools.

## The ten features

| Feature | What the user can do | Boundary |
|---|---|---|
| Oracle Lens | Follow supported vault markets to oracle construction, readable feeds, rounds and timestamps; export a block-linked report. | Eight discovered oracles maximum. Unknown construction and unreviewed heartbeats remain explicit; raw prices are not USD. |
| Control Map | Inspect vault roles, role-address code fingerprints, delegation indicators and ERC-1967 implementation/admin/beacon slots. | Unsupported control paths, multisig thresholds and full timelock authority require separate review. No-code does not prove an EOA. |
| Exposure Concentration | Group known root-vault allocations by collateral, oracle and rate model. | Uses one root asset; excludes idle balances and nested valuation. Known allocation shares are not total-portfolio percentages. |
| Liquidity Stress Lab | Rehearse 5%, 10%, 25%, 50% and 100% withdrawal shocks against idle assets; optionally inspect one owner's share value and maxWithdraw. | Hypothetical idle liquidity, not a simulated exit or guarantee. Uses exact integer units and rounds demand upward. |
| Perps Radar | Inspect RH Lighter market state, mark/reference gaps and optional owner-bound position liquidation distances. | Public reads; no orders or keys. Account and market observations are separate; no exchange observation timestamp is invented. |
| Funding Watch | Inspect and export venue-labelled cross-exchange funding references. | Source supplies no comparable intervals or rate timestamps. No annualization or payment forecast. |
| Session Planner | Inspect a reviewed UTC calendar and supplied feed state; export pre-close calendar reminders. | Calendar/feed input is supplied by the user; no holiday inference or automatic trade scheduling. |
| Evidence Verifier | Verify archived watcher signatures, domain, shared evidence hash, deadline and expected approval list. | Verifier supplies approval list. One signature is not a quorum or proof of report truth; unsigned fields are identified. |
| Agent Liveness | Verify scope-bound, expiring EOA heartbeats and reject old sequences. | Shows recent signing-key activity only. Keep the last accepted sequence externally. No execution authority or contract-wallet verification. |
| Change Monitor | Compare compatible exported reports or watch a vault every 30 seconds in an open tab; export a baseline and optionally notify on changes. | Stops when tab closes. Imports are unauthenticated. Retains the original baseline; failed reads remain visible. |

## Build and verify

Use the repository's pinned Bun 1.4.4 and frozen dependency lockfiles. Install dependencies in `services`, `web`, `sdk` and `mcp` with `bun install --frozen-lockfile`. Existing contract artifact generation prerequisites for the full app remain unchanged; see the main build instructions.

In each of those four directories run `bun node_modules/typescript/bin/tsc --noEmit` and `bun test`. From the repository root run `sh tools/build-web.sh`. Build the SDK with `bun run build` in `sdk`. The web build includes both new HTML entry points automatically. SDK/MCP use the checked-out monorepo; this is not a separately published npm package.

New focused tests live in `services/test/observatory.test.ts`, `services/test/observatory-api.test.ts`, `services/test/research-cli.test.ts`, `web/test/research.test.ts`, `sdk/test/research.test.ts` and the expanded MCP suite. They cover exact-unit arithmetic, malformed queries, stale blocks, reorgs, failed reads, account binding, forged signatures, expiry, replay, input/download bounds, incompatible comparisons, concurrency and cache privacy.

Browser verification covered all ten tools with actual captured public-source reports, real test-key signatures, replay rejection, calendar download, monitoring start/stop, desktop and 390-pixel mobile layouts. Live smoke checks separately exercised all six readers against public Robinhood Chain and RH Lighter sources. This does not establish future provider availability.

## Deploy

1. Mirror the reviewed source through the existing developer process. Do not push with a personal account or include private repository history, release tooling, local paths, credentials, or video work directories.
2. Build and deploy the existing API service with `createResearch` wired into `createApi`. The normal service entry point includes this wiring. Keep the existing supported Robinhood Chain configuration and listed vault allowlist. Existing API startup/configuration requirements still apply.
3. Keep the existing CORS policy for the app origin. Configure the reverse proxy to omit query strings from access logs, since optional owner/account reads contain public wallet identifiers. Do not add analytics to local file content.
4. Deploy the entire generated static web output including `research.html`, `research-guide.html`, `site.js` and `site.css`. The existing footer links to Research tools. Deploy API support before linking the new page publicly; an older API reports an explicit unavailable state.
5. Probe `GET /research` and confirm ten entries. Probe the six live routes using the examples below. Verify block hash/timestamp or venue receipt time, the expected chain, and explicit limits. An unreadable field can be null; it must not become a safety verdict.
6. On a staging browser, test the ten workflows and local file/ICS exports. Validate a heartbeat using a test key and then repeat its accepted sequence to see replay rejection. Never use a production key in the browser.
7. Publish the prepared videos and captions only after the public commit URLs resolve. The media pack deliberately marks links pending until then. No website links are needed in the posts.

To roll back, restore the previous service and static build together. No on-chain rollback or database migration is involved. Saved reports remain ordinary JSON files.

## HTTP interface

`GET /research` returns the catalog. Live paths are `/research/oracles`, `/research/controls`, `/research/concentration`, `/research/liquidity`, `/research/perps`, `/research/funding`.

The first four require `vault`, a deployment-listed address. Liquidity optionally accepts `owner`. Perps accepts no parameters or the pair `owner` and `account` (decimal RH venue index up to 2^48−1). Funding accepts none. Duplicate and unknown query parameters are rejected. Local features have no upload endpoint.

Example: `/research/controls?vault=0xBeEff033F34C046626B8D0A041844C5d1A5409dd`.

The API returns a versioned report with `feature`, `chainId`, `observedAt`, `data` and `limitations`. RPC-sized integers are decimal strings. Errors are bounded and redact provider details. Status 400 is an invalid query; 404 is a non-live/unknown feature; 502 is a failed source; 503 is unconfigured or busy. Busy responses include Retry-After.

All live responses are no-store at the HTTP boundary. A bounded server cache retains public, non-owner reports for ten seconds; owner reports are never cached there. Each process allows two concurrent research jobs, uses a 30-second response deadline, and caps the cache at 64 entries. Chain snapshots require a head no more than 120 seconds old and recheck its hash before returning. Graph discovery has its own 256-read/15-second budget; additional probes allow up to 160 reads with a 20-second observation deadline. A source timeout yields explicit unknowns or failure. Browsers cap downloads/imports at 2 MB. Comparisons cap output at 200 fields and report truncation. Deployment-level rate limiting remains appropriate for the public API.

## SDK and MCP

```ts
import { createObservatory, heartbeatTyped, sessionIcs } from './sdk/src/index';
const research = createObservatory();
const report = await research.controls('0xBeEff033F34C046626B8D0A041844C5d1A5409dd');
// research.oracles, concentration, liquidity, perps, funding
// research.sessions, evidence, heartbeat, changes
```

The ten MCP names are `research_oracles`, `research_controls`, `research_concentration`, `research_liquidity`, `research_perps`, `research_funding`, `research_sessions`, `research_evidence`, `research_heartbeat` and `research_changes`. Their schemas reject transport URLs, signing keys and transaction fields. The API URL is trusted operator configuration, not a tool argument. Local verifier schemas and signed-domain checks still run after MCP validation.

Agent integration: build a heartbeat containing `chainId`, `alarmBook`, `agent`, a bytes32 `scope`, a decimal uint64 `sequence`, `issuedAt` and `expiresAt` (at most one hour later). Sign `heartbeatTyped(heartbeat)` in your existing secure agent environment, attach `signature`, and export the JSON. The verifying browser accepts only the expected key/scope/domain and a greater sequence. Advance your persisted last sequence only after accepting a valid fresh heartbeat. Do not put the private key in the request file. The heartbeat EIP-712 domain is `Canopy Liveness`, version `1`, distinct from AlarmBook attestations.

The field guide includes session JSON format downloads and the limitations for every workflow. Evidence input uses the existing watcher archive format; the verifier reconstructs the existing sorted unique FEED_ evidence hashing scheme rather than inventing a new attestation.

## CLI

From `services`, run `bun src/research-cli.ts request.json`. The input file is capped at 2 MB. Public reads use the configured chain and public RPC by default; a trusted operator can set `CANOPY_RESEARCH_RPC_URL`. Local commands require no network.

```json
{"command":"controls","query":{"vault":"0xBeEff033F34C046626B8D0A041844C5d1A5409dd"}}
```

Local request shapes: `{ "command": "sessions", "input": SESSION_INPUT, "calendarExport": true }`; `{ "command": "evidence", "bundle": ARCHIVE, "expected": { "chainId": 4663, "alarmBook": ADDRESS, "approved": [SIGNER] } }`; `{ "command": "heartbeat", "bundle": HEARTBEAT, "expected": { "chainId": 4663, "alarmBook": ADDRESS, "agent": ADDRESS, "scope": HASH, "lastSequence": null } }`; `{ "command": "changes", "before": REPORT, "after": REPORT }`. Uppercase placeholders here are documentation, not valid JSON values.

## Reference semantics

- [Morpho oracle price units](https://docs.morpho.org/developers/contracts/oracles/)
- [ERC-1967 proxy storage slots](https://eips.ethereum.org/EIPS/eip-1967)
- [EIP-712 typed signatures](https://eips.ethereum.org/EIPS/eip-712)
- [Lighter official funding API implementation](https://github.com/elliottech/lighter-python/blob/main/lighter/api/funding_api.py)

These reports describe source observations and supplied evidence. They do not establish that a vault is safe, guarantee liquidity, predict liquidation, or activate an automated response.
