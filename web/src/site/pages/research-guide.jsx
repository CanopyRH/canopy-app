import React from "react";
import { Shell } from "../Shell.jsx";
import { FEATURES } from "../../research";
import "./research.css";
const notes = {
  oracles:
    "Choose a listed vault. The report follows its bounded market graph and inspects up to eight oracles. Feed round age is shown without declaring it fresh: a reviewed heartbeat and asset mapping are still required. Getter compatibility does not prove the oracle implementation.",
  controls:
    "Choose a vault to inspect its owner, curator and guardian and their code fingerprints. Standard ERC-1967 slots and EIP-7702 delegation are shown where readable. Empty code does not prove a human-controlled EOA, and empty slots do not prove immutability.",
  concentration:
    "Shares are calculated over known root-vault allocations in their loan asset, not your portfolio value. Idle balances and unknown allocations are excluded. Matching collateral, oracle or interest-rate-model addresses expose common dependencies, not measured price correlation.",
  liquidity:
    "Five scenarios compare 5%, 10%, 25%, 50% and 100% withdrawal demand against idle tokens. The optional owner read reports maxWithdraw. Neither measure simulates Canopy execution or accounts for all market liquidity, gates or fees.",
  perps:
    "Public market facts come from the RH-specific Lighter API. Optional positions require both the owner address and account index, and the adapter checks the venue-reported owner. Mark/reference gaps and liquidation distances can change before a trade; this tool submits none.",
  funding:
    "Every reference rate retains its exchange label. This API supplies no comparable funding interval or rate timestamp, so the tool does not annualize rates or predict payments. Reference market IDs are not automatically RH position IDs.",
  sessions:
    "Import a reviewed UTC calendar and feed observation. Exported calendar reminders begin at the later of the session opening and the configured pre-close time. Expired calendar coverage and missing feed health remain unknown. Calendar reminders do not schedule transactions.",
  evidence:
    "Import an archive produced by the Canopy watcher and supply the approved signer list you independently checked. The verifier checks an EOA signature, chain, AlarmBook, key, shared feed-report hashes and deadline. Unsigned signal metadata is not authenticated. A single signature is not a quorum or proof that the report is true.",
  heartbeat:
    "Import a signed Canopy Liveness heartbeat, then enter the expected agent, scope and last accepted sequence. First observation may use a blank prior sequence. Keep the last accepted sequence yourself and increment it for every new heartbeat. The scope is a bytes32 hash chosen by the integrator. A valid heartbeat proves recent key control, not correct behavior.",
  changes:
    "Import two exports of the same tool, chain and subject. The comparison rejects older blocks and conflicting hashes at the same height. Or start a live vault monitor: it compares each new observation with the baseline every 30 seconds while this tab is open. Stop it before switching tasks. Notifications need explicit browser permission and contain no wallet details.",
};
export default function Guide() {
  return (
    <Shell page="research">
      <header className="rs-hero">
        <div>
          <div className="doc-eyebrow">FIELD GUIDE</div>
          <h1>
            Know what
            <br />
            you are reading.
          </h1>
          <p>
            Ten research tools. Every result names its source or input and the
            limits of the conclusion.
          </p>
          <a href="research.html">Open the research tools →</a>
        </div>
      </header>
      <main className="rs-layout" style={{ display: "block", maxWidth: 1000 }}>
        {FEATURES.map((f, i) => (
          <section className="rs-work" key={f.id} style={{ marginBottom: 18 }}>
            <div className="doc-eyebrow">
              {String(i + 1).padStart(2, "0")} /{" "}
              {f.mode === "live" ? "SOURCE READ" : "LOCAL ANALYSIS"}
            </div>
            <h2>{f.title}</h2>
            <p>{notes[f.id]}</p>
          </section>
        ))}
        <section className="rs-work">
          <h2>Privacy and operation</h2>
          <p>
            The website reads public API sources without cookies. Addresses are
            sent only for the observation you request and are not stored by the
            research service. Hosting access logs may still contain request
            URLs; operators should disable query-string logging. Uploaded JSON
            is analyzed inside this browser and is never sent by these tools.
            Exports can contain public addresses and should be shared
            deliberately.
          </p>
          <p>
            Live chain reports use a recent mined block and check its hash again
            before returning. Unknown optional reads are displayed as unknown.
            The service bounds reads, time, response size and concurrent work. A
            report can be incomplete; absence of a finding is not evidence of
            safety.
          </p>
          <p>
            The six live readers require the updated API. A deployment still
            running the older API will show an unavailable message. Four local
            tools do not need that service. No tool here signs transactions,
            changes alarms, enables a deployment or sends orders.
          </p>
        </section>
        <section className="rs-work">
          <h2>Agent heartbeat integration</h2>
          <p>
            Use the SDK’s heartbeatTyped helper to construct the Canopy Liveness
            typed message. Sign it in your own agent integration, then export
            the message fields and signature as JSON. This application never
            accepts a private key. Use an independent key and scope for
            liveness; it grants no funds authority.
          </p>
          <pre className="rs-table">
            {JSON.stringify(
              {
                chainId: 4663,
                alarmBook: "0x… expected AlarmBook",
                agent: "0x… expected signer",
                scope: "0x… 32-byte scope hash",
                sequence: "1",
                issuedAt: 0,
                expiresAt: 0,
                signature: "0x… 65-byte signature",
              },
              null,
              2,
            )}
          </pre>
          <p>
            issuedAt and expiresAt are Unix seconds. Expiry must follow issue
            time by no more than one hour. Sequence is a decimal uint64 string.
            This format supports EOA signatures; contract-wallet signatures are
            not inferred.
          </p>
        </section>
        <section className="rs-work">
          <h2>Interface references</h2>
          <ul>
            <li>
              <a
                href="https://docs.morpho.org/developers/contracts/oracles/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Morpho oracle price semantics
              </a>
            </li>
            <li>
              <a
                href="https://eips.ethereum.org/EIPS/eip-1967"
                target="_blank"
                rel="noopener noreferrer"
              >
                ERC-1967 proxy slots
              </a>
            </li>
            <li>
              <a
                href="https://eips.ethereum.org/EIPS/eip-712"
                target="_blank"
                rel="noopener noreferrer"
              >
                EIP-712 typed signatures
              </a>
            </li>
            <li>
              <a
                href="https://github.com/elliottech/lighter-python/blob/main/lighter/api/funding_api.py"
                target="_blank"
                rel="noopener noreferrer"
              >
                Lighter funding reference endpoint
              </a>
            </li>
          </ul>
        </section>
      </main>
    </Shell>
  );
}
