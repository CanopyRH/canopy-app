import { useEffect, useId, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Bell, Check, CircleHelp, CreditCard, ExternalLink, Eye, LayoutGrid, Layers3, LockKeyhole, Search, ShieldCheck, TriangleAlert, Wallet, Waves, X } from "lucide-react";
import { formatUnits, type Address, type Hex } from "viem";
import { COPY, SIGNALS, TERMS } from "../copy/text";
import { CONFIG } from "../config";
import { arm, armState, disarmAll, exitNow, gatesBlock, live, payPlan, presetViews, riskCard, scanWallet, type Position, type PresetView, type Signer } from "../chain";
import { friendly, safeIcon, walletChoice, watchWallets, type Eip1193, type FoundWallet } from "../wallet";
import { isBlocked, parseWallet, PLAN_AMOUNTS } from "../tx";

declare global { interface Window { ethereum?: Eip1193 } }

type Row = Position & { state: { posId: Hex; armed: boolean } | null };
type Screen = "overview" | "positions" | "plan";
type Note = { text: string; error?: boolean; link?: string };

const usd = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const same = (a: Address | null, b: Address | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function Brand() {
  return <span className="cd-official-mark" aria-hidden="true"><img src="assets/canopy-logo.png" alt="" draggable="false" /></span>;
}

function GlassCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const light = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--cd-light-x", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--cd-light-y", `${e.clientY - r.top}px`);
  };
  return <section className={`cd-glass ${className}`} onPointerMove={light}>{children}</section>;
}

function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={ref} aria-labelledby={titleId} className={`cd-dialog ${wide ? "cd-dialog-wide" : ""}`} onCancel={(e) => (e.preventDefault(), onClose())} onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="cd-dialog-surface"><div className="cd-dialog-header"><div>{eyebrow && <span className="cd-eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div><button className="cd-icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</div>
  </dialog>, document.body);
}

function Status({ row }: { row: Row }) {
  const armed = row.state?.armed ?? false;
  return <span className={`cd-status ${armed ? "cd-status-armed" : "cd-status-idle"}`}><span className="cd-status-dot" />{armed ? COPY.armed : COPY.idleValue}</span>;
}

function PositionRows({ rows, onReview, compact = false }: { rows: Row[]; onReview: (r: Row) => void; compact?: boolean }) {
  return <div className={`cd-position-list ${compact ? "cd-position-list-compact" : ""}`}>{rows.map((r) => <article className="cd-position-row" key={r.vault.address}>
    <button className="cd-position-title" onClick={() => onReview(r)}><span className="cd-asset-icon cd-asset-vault" aria-hidden="true"><Layers3 size={21} strokeWidth={1.5} /></span><span><strong>{r.vault.name}</strong><small>ERC-4626 · {r.vault.asset}</small></span></button>
    <div className="cd-position-value"><strong>{usd(r.assets)}</strong><small>{r.vault.asset}</small></div>
    <Status row={r} />
    <button className="cd-icon-button cd-position-review" onClick={() => onReview(r)} aria-label={`Review ${r.vault.name}`}><ArrowUpRight size={18} /></button>
  </article>)}</div>;
}

function Allocation({ rows }: { rows: Row[] }) {
  const total = rows.reduce((s, r) => s + r.assets, 0n);
  const colors = ["#3d4541", "#8e9f91", "#c4cec2", "#a7aaa6"];
  const share = (r: Row) => (total ? Number((r.assets * 10_000n) / total) / 10_000 : 0);
  let offset = 0;
  return <div className="cd-allocation">
    <div className="cd-donut-wrap"><svg viewBox="0 0 180 180" className="cd-donut" role="img" aria-label={`Allocation across ${rows.length} positions`}><circle cx="90" cy="90" r="70" fill="none" stroke="#e9eae5" strokeWidth="13" />{rows.map((r, i) => {
      const dash = share(r) * 439.82;
      const at = offset;
      offset += dash;
      return <circle key={r.vault.address} cx="90" cy="90" r="70" fill="none" stroke={colors[i % colors.length]} strokeWidth="13" strokeDasharray={`${Math.max(0, dash - 5)} ${439.82 - Math.max(0, dash - 5)}`} strokeDashoffset={-at} transform="rotate(-90 90 90)" strokeLinecap="round" className="cd-donut-segment" />;
    })}</svg><div className="cd-donut-label"><strong>{rows.length}</strong><span>positions</span></div></div>
    <div className="cd-allocation-legend">{rows.map((r, i) => <div key={r.vault.address} className="cd-legend-item"><i style={{ background: colors[i % colors.length] }} /><span>{r.vault.name}</span><strong>{Math.round(share(r) * 100)}%</strong></div>)}</div>
  </div>;
}
