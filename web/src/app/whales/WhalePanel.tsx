import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Address } from "viem";
import { WHALES_COPY as T } from "../../copy/whales";
import { ago, fetchWhales, pct, type WhaleMove } from "./whales";
import "./whales.css";

/** The latest big deposits and withdrawals on one vault, for its risk card. Asks the API for the vault only. */
export default function WhalePanel({ vault }: { vault: Address }) {
  const [moves, setMoves] = useState<WhaleMove[] | null | undefined>(undefined);
  useEffect(() => {
    setMoves(undefined);
    void fetchWhales(vault).then(setMoves);
  }, [vault]);
  const now = Math.floor(Date.now() / 1000);
  return <section className="cd-whales" aria-label={T.title}>
    <div className="cd-whales-head"><h3>🐋 {T.title}</h3><span>{T.pitch}</span></div>
    {moves === undefined && <p className="cd-whales-note">{T.reading}</p>}
    {moves === null && <p className="cd-whales-note">{T.failed}</p>}
    {moves && moves.length === 0 && <p className="cd-whales-note">{T.none}</p>}
    {moves && moves.length > 0 && <ul className="cd-whales-list">{moves.map((m) => <li key={m.tx + m.at} className={m.direction === "out" ? "is-out" : "is-in"}>
      {m.direction === "out" ? <ArrowUpRight size={16} aria-hidden="true" /> : <ArrowDownRight size={16} aria-hidden="true" />}
      <div>
        <strong>{m.label} {m.direction === "out" ? T.left : T.entered}</strong>
        <span>{pct(m.pctOfVault)} {T.ofVault} · {m.wallet} · {ago(m.at, now)}</span>
      </div>
      {m.txUrl && <a href={m.txUrl} target="_blank" rel="noreferrer noopener" aria-label={T.viewTx}><ArrowUpRight size={14} aria-hidden="true" /></a>}
    </li>)}</ul>}
    <p className="cd-whales-note">{T.help} {T.bot}</p>
  </section>;
}
