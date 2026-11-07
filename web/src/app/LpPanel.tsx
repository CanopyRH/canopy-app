import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import type { Chain } from "../config";
import type { Signer } from "../chain";
import { lpNetwork, type LpPosition } from "../lp";
import { parseWallet } from "../tx";
import { TERMS } from "../copy/text";
import { friendly } from "../wallet";
import { receiptLink } from "../receipt";
import { stablePayout } from "../stableExit";
import "./expansion.css";

export default function LpPanel({
  chain,
  signer,
}: {
  chain: Chain;
  signer: Signer | null;
}) {
  const lp = useMemo(() => lpNetwork(chain), [chain]);
  const [input, setInput] = useState(signer?.account ?? "");
  const [owner, setOwner] = useState<Address | null>(null);
  const [rows, setRows] = useState<LpPosition[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(false),
    [selected, setSelected] = useState<LpPosition | null>(null);
  const [chosen, setChosen] = useState<Hex[]>([]),
    [accepted, setAccepted] = useState(false),
    [stable, setStable] = useState(false);
  const [alarmViews, setAlarmViews] = useState<
      Awaited<ReturnType<typeof lp.alarms>>
    >([]),
    [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => {
    setRows([]);
    setOwner(null);
    setSelected(null);
    setEnabled(false);
    setNext(null);
    setNote("");
  }, [chain]);
  useEffect(() => {
    let alive = true;
    setChosen([]);
    setAccepted(false);
    setStable(false);
    setAlarmViews([]);
    if (selected)
      void lp
        .alarms(selected.pool)
        .then((a) => {
          if (alive) setAlarmViews(a);
        })
        .catch(() => {
          if (alive) setAlarmViews([]);
        });
    return () => {
      alive = false;
    };
  }, [lp, selected]);
  const mine = signer && owner?.toLowerCase() === signer.account.toLowerCase();
  const payout = selected
    ? stablePayout(chain, [selected.token0, selected.token1])
    : null;
  async function scan(offset = 0) {
    if (busy) return;
    const who = offset ? owner : parseWallet(input);
    if (!who) {
      setNote("Enter a valid wallet address.");
      return;
    }
    setBusy(true);
    setNote("");
    setReceipt(null);
    setSelected(null);
    try {
      const r = await lp.scan(who, offset);
      setOwner(who);
      setRows((old) => (offset ? [...old, ...r.positions] : r.positions));
      setNext(r.next);
      setEnabled(r.enabled);
      if (r.failed)
        setNote("Some positions could not be read. This list is incomplete.");
      else if (!r.total)
        setNote("No Uniswap v3 position NFTs were found in this wallet.");
    } catch (e) {
      setNote(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  async function act(exit: boolean) {
    if (!signer || !selected || !mine) return;
    setBusy(true);
    setNote("");
    try {
      const tx = exit
        ? await lp.exit(signer, selected.id)
        : await lp.arm(signer, selected.id, stable ? "stable" : "raw", chosen);
      setNote(
        exit
          ? "Exit confirmed. Check the receipt for what was paid and any tokens left owed."
          : "LP alarms armed.",
      );
      if (exit) setReceipt(receiptLink(chain, tx));
      setSelected(null);
    } catch (e) {
      setNote(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="cd-page-heading">
        <div>
          <span className="cd-eyebrow">CANOPY LP</span>
          <h1>Both tokens. Your wallet.</h1>
          <p>
            Read your Uniswap v3 positions, choose an alarm, and review your
            exit.
          </p>
        </div>
      </div>
      <form
        className="cd-scan"
        onSubmit={(e) => {
          e.preventDefault();
          void scan();
        }}
      >
        <label className="cd-search">
          <input
            aria-label="LP wallet address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Wallet address"
            spellCheck={false}
          />
        </label>
        <button className="cd-button cd-button-dark" disabled={busy}>
          Read LP positions
        </button>
      </form>
      {!enabled && (
        <p className="cd-context-note">
          LP positions can be viewed now. Automatic LP exits become available
          after the adapter is deployed and enabled on this network.
        </p>
      )}
      {note && (
        <p role="status" className="cd-context-note">
          {note} {receipt && <a href={receipt}>Open receipt</a>}
        </p>
      )}
      <div className="cd-expansion-grid">
        {rows.map((p) => (
          <button
            key={String(p.id)}
            className="cd-glass cd-lp-card"
            onClick={() => setSelected(p)}
          >
            <span className="cd-eyebrow">POSITION #{String(p.id)}</span>
            <h2>
              {p.symbol0} / {p.symbol1}
            </h2>
            <p>
              {p.fee / 10000}% pool fee · {p.status}
            </p>
            <span
              className={`cd-status ${p.armed ? "cd-status-armed" : "cd-status-idle"}`}
            >
              {p.armed ? "Armed" : "Not armed"}
            </span>
            <small>View position and alarms →</small>
          </button>
        ))}
      </div>
      {next !== null && (
        <button
          className="cd-button cd-button-light"
          disabled={busy}
          onClick={() => void scan(next)}
        >
          Load more positions
        </button>
      )}
      {selected && (
        <section
          className="cd-glass cd-lp-detail"
          aria-label="LP position details"
        >
          <button
            className="cd-button cd-button-light"
            onClick={() => setSelected(null)}
          >
            Close details
          </button>
          <h2>
            {selected.symbol0} / {selected.symbol1} · #{String(selected.id)}
          </h2>
          <p>
            Removing liquidity collects both pool tokens and available fees. The
            emptied NFT returns to the owner. A token that cannot transfer may
            remain owed inside the NFT.
          </p>
          <p>
            Out of range is a position state, not proof of an exploit. Removing
            liquidity has no external price minimum; the mix of tokens follows
            the pool price.
          </p>
          <a
            href={`${chain.explorer}/address/${selected.pool}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View pool
          </a>
          <div>
            {alarmViews.map((a) => (
              <label key={a.preset.key} className="cd-expansion-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(a.preset.key)}
                  disabled={busy || a.status !== "clear"}
                  onChange={(e) =>
                    setChosen((old) =>
                      e.target.checked
                        ? [...old, a.preset.key]
                        : old.filter((k) => k !== a.preset.key),
                    )
                  }
                />
                {a.preset.name} — {a.preset.note}
                {a.status !== "clear" ? " Unavailable." : ""}
              </label>
            ))}
          </div>
          {!alarmViews.length && <p>Alarm options could not be read.</p>}
          <label className="cd-expansion-check">
            <input
              type="checkbox"
              checked={stable}
              disabled={busy || !payout}
              onChange={(e) => setStable(e.target.checked)}
            />{" "}
            Receive {chain.planTokenSymbol} using reviewed routes
          </label>
          {!payout && (
            <p>
              No reviewed conversion route is configured for both tokens. Exits
              pay raw pool tokens.
            </p>
          )}
          {stable &&
            payout?.swaps.map((l) => (
              <div className="cd-route-review" key={l.token}>
                <strong>{l.token}</strong>
                <p>Feed: {l.feed}</p>
                <p>
                  Maximum feed age: {l.heartbeat}s · Maximum oracle slippage: 1%
                </p>
                <p>Path: {l.path}</p>
                <p>A failed swap pays the raw token instead.</p>
              </div>
            ))}
          <details>
            <summary>Read the terms</summary>
            <pre className="cd-risk-text">{TERMS}</pre>
          </details>
          <label className="cd-expansion-check">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={busy}
            />{" "}
            I have read and accept the terms.
          </label>
          {!mine && <p>Connect this position's owner wallet to act.</p>}
          <div className="cd-dialog-actions">
            <button
              className="cd-button cd-button-dark"
              disabled={
                busy || !mine || !enabled || !chosen.length || !accepted
              }
              onClick={() => void act(false)}
            >
              Approve this NFT and arm
            </button>
            <button
              className="cd-button cd-button-light"
              disabled={busy || !mine || !selected.posId}
              onClick={() => void act(true)}
            >
              Exit now
            </button>
          </div>
        </section>
      )}
    </>
  );
}
