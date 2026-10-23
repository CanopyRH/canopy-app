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

/** Alarms and the risk card for one position. Arming and Exit Now appear only for the connected owner on a live deployment. */
function PositionDialog({ row, owner, signer, busy, note, onClose, act }: { row: Row; owner: Address; signer: Signer | null; busy: boolean; note: Note | null; onClose: () => void; act: (fn: () => Promise<Note>) => void }) {
  const [tab, setTab] = useState<"alarms" | "risk">("alarms");
  const [risk, setRisk] = useState<string | null | undefined>(undefined);
  const [views, setViews] = useState<PresetView[] | null>(null);
  const [picked, setPicked] = useState<Hex[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [gated, setGated] = useState(false);
  const mine = live() && signer !== null && same(signer.account, owner);
  useEffect(() => void riskCard(row.vault.address).then(setRisk), [row.vault.address]);
  useEffect(() => {
    if (!mine) return;
    void presetViews(row.vault.address).then(setViews);
    void gatesBlock(row.vault.address, owner).then(setGated);
  }, [mine, row.vault.address, owner]);
  const toggle = (key: Hex, on: boolean) => setPicked((p) => (on ? [...p, key] : p.filter((k) => k !== key)));
  const armIt = () => act(async () => {
    await arm(signer!, row.vault.address, picked);
    onClose();
    return { text: COPY.armedDone };
  });
  const exitIt = () => act(async () => {
    const { hash, complete } = await exitNow(signer!, row.vault.address, row.state!.posId);
    onClose();
    return { text: complete ? COPY.exitDone : COPY.exitPartial, link: `${CONFIG.explorer}/tx/${hash}` };
  });

  return <Modal title={row.vault.name} eyebrow={`ERC-4626 · ${CONFIG.chainName}`} onClose={onClose} wide>
    <div className="cd-position-dialog-summary"><div><span className="cd-asset-icon cd-asset-vault" aria-hidden="true"><Layers3 size={21} strokeWidth={1.5} /></span><div><strong>{usd(row.assets)} {row.vault.asset}</strong><span>Read from the chain just now</span></div></div><Status row={row} /></div>
    <div className="cd-dialog-tabs" role="tablist" aria-label="Position details">{([["alarms", COPY.alarmsTab], ["risk", COPY.riskTab]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={tab === id ? "is-active" : ""}>{label}</button>)}</div>
    {tab === "risk" && <div className="cd-dialog-content"><div className="cd-risk-heading"><h3>What can change this position?</h3></div><pre className="cd-risk-text">{risk === undefined ? COPY.reading : risk ?? COPY.noRisk}</pre></div>}
    {tab === "alarms" && <div className="cd-dialog-content">
      {!live() && <p className="cd-inline-note"><CircleHelp size={15} />{COPY.notDeployed}</p>}
      {live() && !mine && <p className="cd-inline-note"><Wallet size={15} />{COPY.connectToAct}</p>}
      {mine && gated && <p className="cd-inline-note"><TriangleAlert size={15} />{COPY.gateBlocked}</p>}
      {mine && !gated && <>
        <div className="cd-section-heading"><h3>{COPY.armTitle}</h3><span>{picked.length} selected</span></div>
        <p className="cd-caption">{COPY.armHelp}</p>
        <div className="cd-alarm-editor">{(views ?? []).map(({ preset, tripped }) => {
          const on = picked.includes(preset.key);
          return <label key={preset.key} className={`cd-alarm-option ${on ? "is-selected" : ""}`}><input type="checkbox" disabled={tripped || busy} checked={on} onChange={(e) => toggle(preset.key, e.target.checked)} /><span className="cd-checkbox-mark">{on && <Check size={12} strokeWidth={3} />}</span><span><strong>{preset.name}</strong><small>{tripped ? COPY.alarmTripped : preset.note}</small></span>{preset.requires && <span className="cd-confirmation-tag">Watcher confirms</span>}</label>;
        })}{views === null && <p className="cd-caption">{COPY.reading}</p>}</div>
        <details className="cd-advanced"><summary>Terms</summary><pre className="cd-risk-text">{TERMS}</pre></details>
        <label className="cd-terms"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> {COPY.termsAccept}</label>
      </>}
      {/* The page's toast sits under this modal, so wallet prompts and errors show here too. */}
      {note && <p className={`cd-dialog-status ${note.error ? "is-error" : ""}`} role="status">{note.text}</p>}
      <div className="cd-dialog-actions">
        {mine && row.state?.armed && <button className="cd-button cd-button-light" disabled={busy} onClick={exitIt}>{COPY.exitButton}<ArrowUpRight size={15} /></button>}
        {mine && !gated && <button className="cd-button cd-button-dark" disabled={busy || !accepted || picked.length === 0} onClick={armIt}>{row.state?.armed ? COPY.changeAlarms : COPY.armButton}<ShieldCheck size={15} /></button>}
      </div>
    </div>}
  </Modal>;
}

const NAV = [{ id: "overview", label: "Overview", icon: LayoutGrid }, { id: "positions", label: "Positions", icon: Layers3 }, { id: "plan", label: "Plan and controls", icon: CreditCard }] as const;
function Dock({ active, onNavigate }: { active: Screen; onNavigate: (s: Screen) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => ref.current?.querySelectorAll<HTMLElement>(".cd-dock-item") ?? [];
  const reset = () => items().forEach((i) => (i.style.setProperty("--cd-dock-scale", "1"), i.style.setProperty("--cd-dock-rise", "0px")));
  const magnify = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    items().forEach((i) => {
      const r = i.getBoundingClientRect();
      const pull = Math.max(0, 1 - Math.abs(e.clientX - (r.left + r.width / 2)) / 110);
      i.style.setProperty("--cd-dock-scale", String(1 + pull * 0.22));
      i.style.setProperty("--cd-dock-rise", `${-pull * 8}px`);
    });
  };
  return <nav className="cd-dock-wrap" aria-label="App"><div className="cd-dock" ref={ref} onPointerMove={magnify} onPointerLeave={reset}>{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`cd-dock-item ${active === id ? "is-active" : ""}`} onClick={() => (reset(), onNavigate(id))} aria-current={active === id ? "page" : undefined} aria-label={label}><span className="cd-dock-tooltip">{label}</span><span className="cd-dock-icon"><Icon size={24} strokeWidth={1.5} /></span><span className="cd-dock-mobile-label">{label}</span><i /></button>)}</div><span className="cd-dock-caption">YOUR EXIT. YOUR RULES.</span></nav>;
}

export default function App() {
  const [input, setInput] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [owner, setOwner] = useState<Address | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [installed, setInstalled] = useState<FoundWallet[]>([]);
  const [picking, setPicking] = useState<FoundWallet[] | null>(null);
  const [screen, setScreen] = useState<Screen>("overview");
  const [review, setReview] = useState<Address | null>(null);
  const [confirmDisarm, setConfirmDisarm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const busyRef = useRef(false);

  useEffect(() => watchWallets(window, setInstalled), []);
  useEffect(() => void (input && scan(input)), []); // A wallet handed over from the landing page in the URL fragment.

  async function scan(value: string) {
    const who = parseWallet(value);
    setNote(null);
    if (!who) return setNote({ text: COPY.badAddress, error: true });
    if (isBlocked(who)) return setNote({ text: COPY.blocked, error: true });
    setNote({ text: COPY.reading });
    setOwner(who);
    const { found, failed } = await scanWallet(who);
    const withState = await Promise.all(found.map(async (p) => ({ ...p, state: await armState(who, p.vault.address).catch(() => null) })));
    setRows(withState);
    setFailed(failed);
    setNote(failed ? { text: COPY.readFailed, error: true } : null);
  }

  /** Runs one wallet action at a time, says how it went, and refreshes the view of the chain. */
  function act(fn: () => Promise<Note>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void fn()
      .then(async (done) => {
        if (owner) await scan(owner);
        setNote(done);
      })
      .catch((e) => setNote({ text: friendly(e), error: true }))
      .finally(() => ((busyRef.current = false), setBusy(false)));
  }

  async function chooseWallet(w: Eip1193) {
    setPicking(null);
    try {
      const [account] = (await w.request({ method: "eth_requestAccounts" })) as string[];
      const wallet = account ? parseWallet(account) : null;
      if (!wallet) return;
      setSigner({ provider: w, account: wallet, onConfirm: () => setNote({ text: COPY.confirm }) });
      setInput(wallet);
      await scan(wallet);
    } catch (e) {
      setNote({ text: friendly(e), error: true });
    }
  }

  function connect() {
    const choice = walletChoice(installed, window.ethereum);
    if (!choice) return setNote({ text: COPY.noWallet, error: true });
    if ("use" in choice) return void chooseWallet(choice.use);
    setPicking(choice.pick);
  }

  const submit = (e: FormEvent) => (e.preventDefault(), void scan(input));
  const list = rows ?? [];
  const total = list.reduce((s, r) => s + r.assets, 0n);
  const armedTotal = list.filter((r) => r.state?.armed).reduce((s, r) => s + r.assets, 0n);
  const mine = live() && signer !== null && same(signer.account, owner);
  const current = list.find((r) => same(r.vault.address, review)) ?? null;
  const pay = (amount: bigint) => act(async () => ((await payPlan(signer!, amount)), { text: COPY.paidDone }));
  const empty = <div className="cd-empty"><span className="cd-empty-icon"><Search size={25} strokeWidth={1.4} /></span><h3>{rows ? COPY.noPositions : COPY.noScan}</h3></div>;
  const positionsCard = (compact: boolean) => <GlassCard className={compact ? "cd-overview-positions" : "cd-positions-table"}><div className="cd-card-top"><div><h2>{COPY.positionsTitle}</h2><p className="cd-caption">{list.filter((r) => r.state?.armed).length} armed · {list.length} found</p></div>{compact && <button className="cd-icon-button" onClick={() => setScreen("positions")} aria-label="View all positions"><ArrowUpRight size={19} /></button>}</div>{list.length ? <PositionRows rows={list} compact={compact} onReview={(r) => setReview(r.vault.address)} /> : empty}</GlassCard>;

  return <div className="canopy-dashboard">
    <div className="cd-studio-light cd-studio-light-one" aria-hidden="true" /><div className="cd-studio-light cd-studio-light-two" aria-hidden="true" />
    <header className="cd-app-header"><a className="cd-brand" href="./" aria-label="Canopy website"><Brand /><span>Canopy<span className="cd-brand-dot">.</span></span></a><span className="cd-header-divider" /><span className="cd-workspace-name">{CONFIG.chainName}</span>
      <div className="cd-header-actions"><span className="cd-demo-badge"><Eye size={13} /><span>{live() ? COPY.autoExit : COPY.scanOnly}</span></span><a className="cd-back-link" href="./"><ArrowUpRight size={16} /><span>{COPY.website}</span></a><button className="cd-button cd-button-dark cd-connect" onClick={connect} disabled={busy}><Wallet size={15} />{signer ? `${signer.account.slice(0, 6)}…${signer.account.slice(-4)}` : COPY.connectButton}</button>
        {picking && <div className="cd-wallet-picker" role="dialog" aria-label={COPY.pickWallet}><p>{COPY.pickWallet}</p>{picking.map((w) => { const icon = safeIcon(w.info.icon); return <button key={w.info.uuid} onClick={() => void chooseWallet(w.provider)}>{icon && <img src={icon} alt="" />}{w.info.name}</button>; })}</div>}
      </div></header>
    <main className="cd-main"><div className="cd-workspace" key={screen}>
      {screen === "overview" && <>
        <div className="cd-page-heading"><div><span className="cd-eyebrow">YOUR WALLET</span><h1>{COPY.heading}</h1><p>{COPY.subheading}</p></div><div className="cd-network-label"><span />{CONFIG.chainName}<small>{live() ? COPY.autoExit : COPY.scanOnly}</small></div></div>
        <form className="cd-scan" onSubmit={submit}><label className="cd-search"><Search size={17} /><input value={input} onChange={(e) => setInput(e.target.value)} placeholder={COPY.scanPlaceholder} aria-label="Wallet address" autoComplete="off" spellCheck={false} /></label><button className="cd-button cd-button-dark" type="submit">{COPY.scanButton}<ArrowUpRight size={15} /></button></form>
        {!live() && <div className="cd-context-note"><CircleHelp size={15} /><p>{COPY.notDeployed}</p></div>}
        <div className="cd-overview-grid">
          <GlassCard className="cd-portfolio-card"><div className="cd-card-top"><span className="cd-card-label">{COPY.positionsLabel}</span><span className="cd-tiny-pill"><Eye size={12} /> Read-only values</span></div><div className="cd-portfolio-amount">{usd(total).split(".")[0]}<span>.{usd(total).split(".")[1]}</span></div><p className="cd-caption">{rows ? COPY.positionsHelp : COPY.noScan}</p>
            <div className="cd-portfolio-body"><div className="cd-portfolio-stats"><div><span><i className="cd-swatch cd-swatch-armed" />{COPY.armedValue}</span><strong>{usd(armedTotal)}</strong></div><div><span><i className="cd-swatch cd-swatch-idle" />{COPY.idleValue}</span><strong>{usd(total - armedTotal)}</strong></div><button className="cd-text-button" onClick={() => setScreen("positions")}>Manage positions<ArrowUpRight size={14} /></button></div><div className="cd-chart-area">{list.length > 0 && <Allocation rows={list} />}</div></div>
          </GlassCard>
          <GlassCard className="cd-destination-card cd-ambient"><div className="cd-card-top"><span className="cd-card-label">Always your destination</span><LockKeyhole size={16} /></div><div className="cd-metal-scene" aria-hidden="true"><div className="cd-orbit cd-orbit-one" /><div className="cd-orbit cd-orbit-two" /><div className="cd-metal-orb cd-chrome-emblem"><span className="cd-official-mark cd-hero-brand-mark"><img src="assets/canopy-logo.png" alt="" draggable="false" /></span></div><span className="cd-orbit-node cd-orbit-node-a" /><span className="cd-orbit-node cd-orbit-node-b" /><span className="cd-orbit-node cd-orbit-node-c" /></div><div className="cd-destination-copy"><span className="cd-tiny-pill cd-owner-pill"><LockKeyhole size={12} /> {COPY.ownerOnly}</span><h2>{COPY.destinationTitle}</h2><p>{COPY.destinationHelp}</p></div></GlassCard>
          {positionsCard(true)}
          <GlassCard className="cd-alarm-card"><div className="cd-card-top"><h2>{COPY.signalsTitle}</h2><span className="cd-soft-icon"><Bell size={16} /></span></div><p className="cd-caption">{COPY.signalsHelp}</p><div className="cd-signal-list">{SIGNALS.map((s, i) => <div key={s.name}><span className="cd-signal-icon">{i % 2 ? <Eye size={15} /> : <Waves size={15} />}</span><span>{s.name}<small>{s.note}</small></span><strong>{s.value}</strong></div>)}</div></GlassCard>
        </div>
        <div className="cd-context-note"><CircleHelp size={15} /><p>{COPY.limitsNote}</p></div>
      </>}
      {screen === "positions" && <>
        <div className="cd-page-heading"><div><span className="cd-eyebrow">POSITIONS</span><h1>{COPY.positionsScreen}</h1><p>{COPY.positionsScreenHelp}</p></div></div>
        {positionsCard(false)}
        <div className="cd-info-strip"><TriangleAlert size={19} /><div><strong>A plan is only as useful as its limits.</strong><p>A fully lent-out vault or a share gate can delay or stop an exit. Read each risk card before arming.</p></div></div>
      </>}
      {screen === "plan" && <>
        <div className="cd-page-heading"><div><span className="cd-eyebrow">PLAN AND CONTROLS</span><h1>{COPY.planScreen}</h1><p>{COPY.planScreenHelp}</p></div></div>
        <div className="cd-settings-grid">
          <GlassCard className="cd-settings-main"><div className="cd-card-top"><div><h2>{COPY.planTitle}</h2><p className="cd-caption">{COPY.planHelp}</p></div><CreditCard size={19} /></div><div className="cd-dialog-actions"><button className="cd-button cd-button-light" disabled={busy || !mine || !CONFIG.planPayTo} onClick={() => pay(PLAN_AMOUNTS.months3)}>{COPY.plan3}</button><button className="cd-button cd-button-dark" disabled={busy || !mine || !CONFIG.planPayTo} onClick={() => pay(PLAN_AMOUNTS.year)}>{COPY.plan12}</button></div>{!mine && <p className="cd-inline-note"><Wallet size={15} />{live() ? COPY.connectToAct : COPY.notDeployed}</p>}</GlassCard>
          <GlassCard className="cd-settings-main"><div className="cd-card-top"><div><h2>{COPY.disarmButton}</h2><p className="cd-caption">{COPY.disarmHelp}</p></div><ShieldCheck size={19} /></div><div className="cd-dialog-actions"><button className="cd-button cd-button-dark" disabled={busy || !mine} onClick={() => setConfirmDisarm(true)}>{COPY.disarmButton}</button></div></GlassCard>
        </div>
      </>}
      <footer className="cd-workspace-footer"><span><span className="cd-footer-dot" /> {signer ? `${signer.account.slice(0, 6)}…${signer.account.slice(-4)}` : COPY.disconnected}</span><span>{COPY.footer}</span></footer>
    </div></main>
    <Dock active={screen} onNavigate={(s) => (setScreen(s), scrollTo({ top: 0 }))} />
    <div className="cd-toast-region" aria-live="polite" aria-atomic="true">{note && <div className={`cd-toast ${note.error ? "cd-toast-error" : ""}`}>{note.error ? <TriangleAlert size={15} /> : <Check size={15} />}<span>{note.text}{note.link && <> <a href={note.link} target="_blank" rel="noreferrer">{COPY.viewTx}<ExternalLink size={12} /></a></>}</span><button aria-label="Dismiss" onClick={() => setNote(null)}><X size={14} /></button></div>}</div>
    {current && owner && <PositionDialog key={current.vault.address} row={current} owner={owner} signer={signer} busy={busy} note={note} act={act} onClose={() => setReview(null)} />}
    {confirmDisarm && <Modal title={COPY.disarmTitle} eyebrow="YOUR CONTROLS" onClose={() => setConfirmDisarm(false)}><div className="cd-dialog-content"><p className="cd-confirm-copy">{COPY.disarmHelp}</p><div className="cd-dialog-actions"><button className="cd-button cd-button-light" onClick={() => setConfirmDisarm(false)}>{COPY.keep}</button><button className="cd-button cd-button-dark" disabled={busy} onClick={() => { setConfirmDisarm(false); act(async () => ((await disarmAll(signer!)), { text: COPY.disarmDone })); }}>{COPY.disarmButton}</button></div></div></Modal>}
  </div>;
}
