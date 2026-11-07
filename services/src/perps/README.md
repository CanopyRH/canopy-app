# Perps preparation

`closeOnly.ts` produces an unsigned, reduce-only IOC plan with account/market binding, owner caps,
fresh independent reference pricing, expiry and live-alarm requirements. `keystore.ts` provides local
AES-256-GCM storage, with venue/account/key-index binding and exclusive private-file creation.
The encryption key is supplied by the operator, kept separately and never persisted by this library.

These are tested preparation components, **not a live venue connector**. The booleans passed to the
planner must be established by an independently reviewed connector, not accepted from an agent or HTTP
caller. Re-read position size, permission scope, armed policy and live alarms immediately before signing.
If position size changes, the venue itself must enforce reduce-only. A receipt must be based on confirmed
fills, never on order submission. Public RH account/market/key reads and strict terminal-fill validation are implemented in `lighter.ts`.
No signed order submission is implemented here. Matching a public key does not prove its permissions.
The read-only operator CLI is documented in `docs/expansion-operator-guide.md`.

Lighter RH requires verification of the deployed key's actual withdrawal/transfer permissions. Do not
infer safety from the phrase “trade-only” or use a full account key. Arcus needs its deployed redeem
interface. GMX/gTrade need chain/version-specific delegation and output tests. Avantis/Ostium remain
alerts and owner-signed exits until a constrained delegation mechanism is verified. No venue is enabled
by this change. The PDF's external audit gate applies before any real-money activation.
