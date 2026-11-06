import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { PREVIEW } from "../copy/preview";
import { buildPreview, liquidityText, money, statusText, verdict, type Preview } from "../preview";
import { chainDeps } from "../previewChain";
import type { Net, Position } from "../chain";
import "./preview.css";

type Row = Position & { state: { posId: Hex; armed: boolean } | null };
type Slot = Preview | "reading";

/** Reads one position's preview. Never throws: buildPreview turns each failed read into an empty part. */
const read = (net: Net, r: Row, owner: Address) => buildPreview(chainDeps(net, r.vault.address, owner, r.state?.armed ? r.state.posId : null), r.shares, r.state?.armed ?? false);

/** "What you'd get back right now": for each position, what an exit would pay, whether the vault can pay it, and how its alarms look. Read-only. */
export default function ExitPreview({ net, rows, owner }: { net: Net; rows: Row[]; owner: Address | null }) {
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!owner || rows.length === 0) return; // `rows` is a fresh empty list on every render until the scan lands.
    let stale = false;
    setSlots(Object.fromEntries(rows.map((r) => [r.vault.address, "reading" as const])));
    for (const r of rows) void read(net, r, owner).then((p) => !stale && setSlots((s) => ({ ...s, [r.vault.address]: p })));
    return () => void (stale = true);
  }, [net, rows, owner, tick]);

  return <section className="cd-glass cd-preview" aria-label={PREVIEW.title}>
    <div className="cd-card-top"><div><h2>{PREVIEW.title}</h2><p className="cd-caption">{PREVIEW.help}</p></div></div>
    {!owner || rows.length === 0 ? <p className="cd-caption">{owner ? PREVIEW.none : PREVIEW.empty}</p> : <div className="cd-preview-list">{rows.map((r) => {
      const slot = slots[r.vault.address] ?? "reading";
      const armed = r.state?.armed ?? false;
      const head = <div className="cd-preview-head"><strong>{r.vault.name}</strong><small>{armed ? PREVIEW.armedTag : PREVIEW.idleTag}</small></div>;
      if (slot === "reading") return <article className="cd-preview-item" key={r.vault.address}>{head}<p className="cd-caption">{PREVIEW.reading}</p></article>;
      const v = verdict(slot, r.vault.asset);
      return <article className="cd-preview-item" key={r.vault.address}>{head}
        {slot.payout && <div className="cd-preview-amount"><strong>{money(slot.payout.payNow, r.vault.asset)}</strong><span>{PREVIEW.youGet} · {liquidityText(slot.payout.liquidity)}{slot.payout.liquidity === "partial" && ` ${PREVIEW.worth} ${money(slot.payout.worth, r.vault.asset)}.`}</span></div>}
        <p className={`cd-preview-verdict is-${v.tone}`} role="status">{v.text}</p>
        <div className="cd-preview-alarms"><span>{armed ? PREVIEW.alarmsTitleArmed : PREVIEW.alarmsTitleIdle}</span>
          {slot.alarms === null ? <span>{net.live ? PREVIEW.alarmsUnread : PREVIEW.noAlarms}</span> : slot.alarms.map((a) => <span key={a.name} className={`cd-preview-chip is-${a.status}`}>{a.name} · {statusText(a.status)}</span>)}
        </div>
      </article>;
    })}</div>}
    {owner && rows.length > 0 && <div className="cd-preview-actions"><button className="cd-button cd-button-light" onClick={() => setTick((t) => t + 1)}>{PREVIEW.refresh}</button></div>}
  </section>;
}
