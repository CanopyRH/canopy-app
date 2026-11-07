import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { Shell } from "../Shell.jsx";
import { CONFIG } from "../../config";
import {
  FEATURES,
  readResearch,
  readResearchFile,
  sessionPlan,
  sessionIcs,
  verifyEvidence,
  verifyHeartbeat,
  compareReports,
} from "../../research";
import "./research.css";

const label = (k) =>
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());
const text = (v) =>
  v === null || v === undefined
    ? "Unknown"
    : typeof v === "boolean"
      ? v
        ? "Yes"
        : "No"
      : String(v);
function Value({ value, depth = 0 }) {
  if (value === null || typeof value !== "object")
    return (
      <span
        className={
          typeof value === "string" && value.startsWith("0x")
            ? "rs-address"
            : ""
        }
      >
        {text(value)}
      </span>
    );
  if (depth > 6)
    return <span>More detail is available in the exported report.</span>;
  if (Array.isArray(value)) {
    if (!value.length)
      return <span className="rs-muted">No entries in this observation.</span>;
    const rows = value.slice(0, 100),
      objects = rows.every(
        (x) => x && typeof x === "object" && !Array.isArray(x),
      );
    if (objects) {
      const keys = [...new Set(rows.flatMap(Object.keys))];
      return (
        <>
          <div
            className="rs-table"
            tabIndex={0}
            role="region"
            aria-label="Report table"
          >
            <table>
              <thead>
                <tr>
                  {keys.map((k) => (
                    <th key={k}>{label(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {keys.map((k) => (
                      <td key={k}>
                        {r[k] && typeof r[k] === "object" ? (
                          <details>
                            <summary>Details</summary>
                            <Value value={r[k]} depth={depth + 1} />
                          </details>
                        ) : (
                          <Value value={r[k]} depth={depth + 1} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {value.length > 100 && (
            <p>
              Showing the first 100 of {value.length} entries. Export the full
              report for every entry.
            </p>
          )}
        </>
      );
    }
    return (
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            <Value value={r} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="rs-facts">
      {Object.entries(value).map(([k, v]) => (
        <div key={k}>
          <dt>{label(k)}</dt>
          <dd>
            <Value value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function save(value, name, type = "application/json") {
  const url = URL.createObjectURL(
    new Blob(
      [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
      { type },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function JsonFile({ label: caption, onLoad, onError }) {
  return (
    <label className="rs-file">
      {caption}
      <input
        type="file"
        accept=".json,application/json"
        onChange={async (e) => {
          try {
            const f = e.target.files?.[0];
            if (f) onLoad(await readResearchFile(f));
          } catch {
            onError("Choose a valid JSON file under 2 MB.");
          }
        }}
      />
    </label>
  );
}
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s),
  isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(s);
export default function Research() {
  const [id, setId] = useState("oracles"),
    [vault, setVault] = useState(CONFIG.vaults[0]?.address ?? ""),
    [owner, setOwner] = useState(""),
    [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [report, setReport] = useState(null),
    [file, setFile] = useState(null),
    [second, setSecond] = useState(null);
  const [approved, setApproved] = useState(""),
    [agent, setAgent] = useState(""),
    [scope, setScope] = useState(""),
    [sequence, setSequence] = useState("");
  const [watchFeature, setWatchFeature] = useState("controls"),
    [watching, setWatching] = useState(false),
    [baseline, setBaseline] = useState(null),
    [notice, setNotice] = useState("");
  const savedBaseline = useRef(null),
    lastNotified = useRef(""),
    abort = useRef(null),
    generation = useRef(0),
    feature = FEATURES.find((f) => f.id === id);
  const reset = (next) => {
    generation.current++;
    abort.current?.abort();
    setWatching(false);
    setOwner("");
    setAccount("");
    setId(next);
    setReport(null);
    setError("");
    setFile(null);
    setSecond(null);
    setBaseline(null);
    savedBaseline.current = null;
    lastNotified.current = "";
    setBusy(false);
    setNotice("");
  };
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
    },
    [],
  );
  const query = (which) => {
    const q = {};
    if (["oracles", "controls", "concentration", "liquidity"].includes(which))
      q.vault = vault;
    if (["liquidity", "perps"].includes(which) && owner) q.owner = owner;
    if (which === "perps" && account) q.account = account;
    return q;
  };
  const load = async (which) => {
    const controller = new AbortController();
    abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      return await readResearch(
        CONFIG.apiUrl,
        which,
        query(which),
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
  const run = async () => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      let result;
      if (feature.mode === "live") result = await load(id);
      else if (id === "sessions") result = sessionPlan(file);
      else if (id === "evidence") {
        const addresses = approved.split(/[\s,]+/).filter(Boolean);
        if (
          !addresses.length ||
          addresses.length > 32 ||
          addresses.some((a) => !isAddress(a))
        )
          throw new Error(
            "Enter one to 32 independently checked signer addresses.",
          );
        result = await verifyEvidence(file, {
          chainId: CONFIG.chainId,
          alarmBook: CONFIG.alarmBook,
          approved: addresses,
        });
      } else if (id === "heartbeat") {
        if (!isAddress(agent) || !isHash(scope))
          throw new Error("Enter the expected agent address and scope hash.");
        result = await verifyHeartbeat(file, {
          chainId: CONFIG.chainId,
          alarmBook: CONFIG.alarmBook,
          agent,
          scope,
          lastSequence: sequence || null,
        });
      } else result = compareReports(file, second);
      if (current === generation.current) setReport(result);
    } catch (e) {
      if (current === generation.current)
        setError(
          e?.name === "ZodError"
            ? "The file does not match this tool’s documented format."
            : e?.name === "AbortError"
              ? "The read was cancelled or timed out."
              : e.message || "The report could not be produced.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!watching) return;
    let stopped = false,
      timer;
    const current = ++generation.current;
    const tick = async () => {
      setBusy(true);
      try {
        const next = await load(watchFeature);
        if (stopped || current !== generation.current) return;
        if (savedBaseline.current) {
          const diff = compareReports(savedBaseline.current, next);
          setReport(diff);
          setNotice(
            `${diff.data.changes.length} changed fields since the saved baseline.`,
          );
          const signature = JSON.stringify(diff.data.changes);
          if (
            diff.data.changes.length &&
            signature !== lastNotified.current &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          )
            new Notification("Canopy observation changed", {
              body: "Review the changed fields in the open Canopy tab.",
            });
          lastNotified.current = signature;
        } else {
          savedBaseline.current = next;
          setBaseline(next);
          setNotice(
            "Baseline captured. Checking every 30 seconds while this tab remains open.",
          );
        }
        setError("");
      } catch {
        if (!stopped)
          setError(
            "This observation failed. The last baseline is retained; no unchanged or safe result is inferred.",
          );
      } finally {
        if (!stopped) {
          setBusy(false);
          timer = setTimeout(tick, 30000);
        }
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.current?.abort();
    };
  }, [watching, watchFeature, vault]);
  const exampleCalendar = () => {
    const now = Math.floor(Date.now() / 1000),
      open = now + 3600;
    save(
      {
        calendar: {
          source: "https://example.com/reviewed-calendar",
          reviewedAt: now,
          validFrom: now,
          validUntil: now + 86400,
          windows: [{ open, close: open + 7200 }],
        },
        preCloseSeconds: 900,
        feed: { updatedAt: now, heartbeat: 60, positive: true, paused: null },
        multiplierChanged: false,
      },
      "EXAMPLE-session-input.json",
    );
  };
  return (
    <Shell page="research">
      <header className="rs-hero">
        <div>
          <div className="doc-eyebrow">CANOPY RESEARCH / TEN NEW TOOLS</div>
          <h1>
            See more.
            <br />
            Decide with context.
          </h1>
          <p>
            Explore dependencies, rehearse liquidity shocks and inspect the
            evidence behind a decision. Your wallet stays out of the process.
          </p>
          <a href="research-guide.html">
            Read the field guide <ArrowUpRight size={16} />
          </a>
        </div>
        <div className="rs-orb" aria-hidden="true">
          <span>10</span>
        </div>
      </header>
      <main className="rs-layout">
        <nav className="rs-menu" aria-label="Research tools">
          {FEATURES.map((f, i) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={id === f.id}
              onClick={() => reset(f.id)}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {f.title}
              <small>
                {f.mode === "live" ? "Source read" : "On your device"}
              </small>
            </button>
          ))}
        </nav>
        <section className="rs-work" aria-labelledby="rs-title">
          <div className="rs-heading">
            <ShieldCheck size={22} />
            <span>
              {feature.mode === "local"
                ? "Files stay in this browser"
                : "Reads public sources"}
            </span>
          </div>
          <h2 id="rs-title">{feature.title}</h2>
          <p>{feature.summary}</p>
          {feature.mode === "live" && (
            <div className="rs-form">
              {["oracles", "controls", "concentration", "liquidity"].includes(
                id,
              ) && (
                <label>
                  Vault
                  <select
                    value={vault}
                    onChange={(e) => {
                      setVault(e.target.value);
                      setReport(null);
                    }}
                    disabled={busy}
                  >
                    {CONFIG.vaults.map((v) => (
                      <option value={v.address} key={v.address}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {["liquidity", "perps"].includes(id) && (
                <label>
                  Owner address (optional)
                  <input
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="0x…"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
              )}
              {id === "perps" && (
                <label>
                  RH Lighter account index (required with owner)
                  <input
                    inputMode="numeric"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              <p className="rs-note">
                {id === "funding"
                  ? "Reference rates retain their exchange labels. Intervals and rate timestamps are not supplied by this endpoint."
                  : id === "perps"
                    ? "Read-only venue observations. No trading key or order submission."
                    : "Reads the listed Robinhood Chain vault at a recent block. Unknown values stay visible."}
              </p>
            </div>
          )}
          {feature.mode === "local" && (
            <div className="rs-form">
              <JsonFile
                label={
                  id === "changes"
                    ? "Earlier exported report"
                    : id === "sessions"
                      ? "Reviewed session input"
                      : "Signed report file"
                }
                onLoad={(v) => {
                  setFile(v);
                  setReport(null);
                }}
                onError={setError}
              />
              {id === "sessions" && (
                <>
                  <p className="rs-note">
                    Use a reviewed calendar with UTC intervals and a timestamped
                    feed observation. The example is only a format template.
                  </p>
                  <button
                    type="button"
                    className="rs-secondary"
                    onClick={exampleCalendar}
                  >
                    Download format example
                  </button>
                </>
              )}
              {id === "evidence" && (
                <label>
                  Approved signers you independently checked
                  <textarea
                    value={approved}
                    onChange={(e) => setApproved(e.target.value)}
                    placeholder="One address per line"
                  />
                </label>
              )}
              {id === "heartbeat" && (
                <>
                  <label>
                    Expected agent address
                    <input
                      value={agent}
                      onChange={(e) => setAgent(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    Expected scope hash
                    <input
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    Last accepted sequence (blank for first observation)
                    <input
                      value={sequence}
                      onChange={(e) => setSequence(e.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                </>
              )}
              {id === "changes" && (
                <>
                  <JsonFile
                    label="Later exported report"
                    onLoad={setSecond}
                    onError={setError}
                  />
                  <div className="rs-watch">
                    <h3>Or monitor a vault in this tab</h3>
                    <label>
                      Observation
                      <select
                        disabled={watching}
                        value={watchFeature}
                        onChange={(e) => {
                          setWatchFeature(e.target.value);
                          setBaseline(null);
                          savedBaseline.current = null;
                          lastNotified.current = "";
                        }}
                      >
                        {FEATURES.filter((f) =>
                          [
                            "controls",
                            "oracles",
                            "concentration",
                            "liquidity",
                          ].includes(f.id),
                        ).map((f) => (
                          <option value={f.id} key={f.id}>
                            {f.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Vault
                      <select
                        disabled={watching}
                        value={vault}
                        onChange={(e) => {
                          setVault(e.target.value);
                          setBaseline(null);
                          savedBaseline.current = null;
                          lastNotified.current = "";
                        }}
                      >
                        {CONFIG.vaults.map((v) => (
                          <option value={v.address} key={v.address}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (watching) {
                          generation.current++;
                          abort.current?.abort();
                          setBusy(false);
                        }
                        setWatching(!watching);
                      }}
                    >
                      {watching ? "Stop monitoring" : "Start monitoring"}
                    </button>
                    <button
                      type="button"
                      className="rs-secondary"
                      onClick={async () => {
                        try {
                          if (typeof Notification === "undefined")
                            throw new Error();
                          const p = await Notification.requestPermission();
                          setNotice(
                            p === "granted"
                              ? "Desktop notifications enabled for this open tab."
                              : "Notifications are not enabled; reports remain visible here.",
                          );
                        } catch {
                          setNotice(
                            "Desktop notifications are unavailable in this browser.",
                          );
                        }
                      }}
                    >
                      Enable desktop notifications
                    </button>
                    {baseline && (
                      <button
                        type="button"
                        className="rs-secondary"
                        onClick={() => save(baseline, "canopy-baseline.json")}
                      >
                        Export baseline
                      </button>
                    )}
                    <p className="rs-note">
                      Monitoring stops when you close the tab. No background
                      service or automatic exit is enabled. Reports are compared
                      with the original baseline.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="rs-actions">
            <button
              type="button"
              onClick={run}
              disabled={busy || watching || (feature.mode === "local" && !file)}
            >
              <RefreshCw size={16} />
              {busy
                ? "Reading…"
                : feature.mode === "live"
                  ? "Read current facts"
                  : "Analyze files"}
            </button>
            {busy && !watching && (
              <button
                type="button"
                className="rs-secondary"
                onClick={() => abort.current?.abort()}
              >
                Cancel
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="rs-error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {report && (
            <article className="rs-result" aria-live="polite">
              <header>
                <h3>Observation</h3>
                <button
                  type="button"
                  className="rs-secondary"
                  onClick={() => save(report, `canopy-${id}-report.json`)}
                >
                  <Download size={16} />
                  Export report
                </button>
                {id === "sessions" && (
                  <button
                    type="button"
                    className="rs-secondary"
                    onClick={() => {
                      try {
                        save(
                          sessionIcs(file),
                          "canopy-session-reminders.ics",
                          "text/calendar",
                        );
                      } catch {
                        setError("The calendar could not be exported.");
                      }
                    }}
                  >
                    Export calendar reminders
                  </button>
                )}
              </header>
              <Value value={report.observedAt} />
              <Value value={report.data} />
              <aside>
                <h4>What this tells you—and its limits</h4>
                <ul>
                  {report.limitations.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </aside>
            </article>
          )}
        </section>
      </main>
    </Shell>
  );
}
