import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Eye, LockKeyhole, Pencil, Plus, RefreshCw, Trash2, TriangleAlert, Wallet } from "lucide-react";
import type { Address } from "viem";
import type { Net, Position } from "../../chain";
import { WALLETS_COPY as T, capNote } from "./copy";
import { addWallet, defaultStore, formatUsd, loadList, MAX_LABEL, MAX_WALLETS, removeWallet, saveList, setLabel, shortAddress, shown, STORAGE_KEY, totals, type Saved } from "./list";
import "./wallets.css";

type Row = Position & { armed: boolean };
type Reading = { status: "loading" } | { status: "done"; rows: Row[]; failed: boolean };

/** Reads one wallet from the chain, the same way the main list does. Nothing here talks to Canopy's API. */
async function read(net: Net, owner: Address): Promise<Reading> {
  const { found, failed } = await net.scanWallet(owner);
  const rows = await Promise.all(found.map(async (p) => ({ ...p, armed: (await net.armState(owner, p.vault.address).catch(() => null))?.armed ?? false })));
  return { status: "done", rows, failed };
}

/** Risk text per vault. riskCard fetches every listed vault once for everyone, so it never reveals which vaults a wallet holds. */
function RiskFacts({ net, rows }: { net: Net; rows: Row[] }) {
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<Record<string, string | null | undefined>>({});
  useEffect(() => {
    if (!open) return;
    rows.forEach((r) => void net.riskCard(r.vault.address).then((t) => setTexts((x) => ({ ...x, [r.vault.address]: t })), () => setTexts((x) => ({ ...x, [r.vault.address]: null }))));
  }, [open, rows, net]);
  return <details className="cd-advanced cd-wallet-risk" onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{T.riskFacts}</summary>
    {rows.map((r) => <div key={r.vault.address} className="cd-wallet-risk-item"><strong>{r.vault.name}</strong><pre className="cd-risk-text">{texts[r.vault.address] === undefined ? T.reading : (texts[r.vault.address] ?? "Risk facts could not be loaded.")}</pre></div>)}
  </details>;
}

function WalletCard({ net, w, reading, onSave, onRemove, onRename, onOpen }: { net: Net; w: ReturnType<typeof shown>[number]; reading: Reading | undefined; onSave: () => void; onRemove: () => void; onRename: (label: string) => void; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(w.label);
  const done = reading?.status === "done" ? reading : null;
  const rename = (e: FormEvent) => (e.preventDefault(), onRename(draft), setEditing(false));
  return <article className={`cd-wallet ${w.connected ? "is-connected" : ""}`}>
    <div className="cd-wallet-head">
      <div className="cd-wallet-id">
        {editing
          ? <form className="cd-wallet-rename" onSubmit={rename}><input value={draft} maxLength={MAX_LABEL} autoFocus onChange={(e) => setDraft(e.target.value)} placeholder={T.labelPlaceholder} aria-label="Wallet label" /><button className="cd-button cd-button-dark" type="submit">Done</button></form>
          : <strong>{w.label || shortAddress(w.address)}</strong>}
        <small title={w.address}>{w.label ? `${shortAddress(w.address)} · ` : ""}{w.address}</small>
      </div>
      <span className={`cd-wallet-tag ${w.connected ? "is-connected" : ""}`}>{w.connected ? <Wallet size={12} /> : <Eye size={12} />}{w.connected ? T.connectedTag : T.readOnlyTag}</span>
    </div>
    <div className="cd-wallet-body">
      {!done && <p className="cd-caption">{T.reading}</p>}
      {done && done.rows.length === 0 && <p className="cd-caption">{T.none}</p>}
      {done?.rows.map((r) => <div key={r.vault.address} className="cd-wallet-position"><span>{r.vault.name}<small>{r.vault.asset}</small></span><strong>{formatUsd(r.assets)}</strong><span className={`cd-status ${r.armed ? "cd-status-armed" : "cd-status-idle"}`}><span className="cd-status-dot" />{r.armed ? "Armed" : "Not armed"}</span></div>)}
      {done?.failed && <p className="cd-inline-note"><TriangleAlert size={15} />{T.failed}</p>}
      {done && done.rows.length > 0 && <RiskFacts net={net} rows={done.rows} />}
    </div>
    <div className="cd-wallet-actions">
      <button className="cd-button cd-button-light" onClick={onOpen}>{T.open}<ArrowUpRight size={14} /></button>
      {w.saved && !editing && <button className="cd-button cd-button-light" onClick={() => (setDraft(w.label), setEditing(true))}><Pencil size={14} />{T.rename}</button>}
      {!w.saved && <button className="cd-button cd-button-dark" onClick={onSave}><Plus size={14} />{T.save}</button>}
      {w.saved && <button className="cd-button cd-button-light" onClick={onRemove}><Trash2 size={14} />{T.remove}</button>}
      {!w.saved && <span className="cd-caption">{T.unsaved}</span>}
    </div>
  </article>;
}

/** Saved wallets and their positions on one screen. Only the connected wallet can act, and that rule stays in the main list: "Show in list above" opens a wallet there, where arming and Exit Now already check who is connected. */
export default function WalletsPanel({ net, connected, onOpen }: { net: Net; connected: Address | null; onOpen: (a: Address) => void }) {
  const [saved, setSaved] = useState<Saved[]>(() => loadList());
  const [kept, setKept] = useState(true);
  const [input, setInput] = useState("");
  const [label, setLabelText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const asked = useRef(new Set<string>());
  const list = useMemo(() => shown(saved, connected), [saved, connected]);
  const key = list.map((w) => w.address.toLowerCase()).join(",");

  const update = (next: Saved[]) => (setSaved(next), setKept(saveList(next)));
  // Another tab changed the list.
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === STORAGE_KEY && e.storageArea === defaultStore() && setSaved(loadList());
    addEventListener("storage", on);
    return () => removeEventListener("storage", on);
  }, []);
  // A switch to another chain reads every wallet again there.
  useEffect(() => {
    asked.current.clear();
    setReadings({});
  }, [net]);
  // Read each wallet once as it appears. "Read again" asks for all of them afresh.
  useEffect(() => {
    list.forEach((w) => {
      const id = w.address.toLowerCase();
      if (asked.current.has(id)) return;
      asked.current.add(id);
      void read(net, w.address).then((r) => setReadings((x) => ({ ...x, [id]: r })), () => setReadings((x) => ({ ...x, [id]: { status: "done", rows: [], failed: true } })));
    });
  }, [key, net]);
  const again = () => {
    asked.current.clear();
    setReadings({});
    setConfirmClear(false);
    list.forEach((w) => {
      const id = w.address.toLowerCase();
      asked.current.add(id);
      void read(net, w.address).then((r) => setReadings((x) => ({ ...x, [id]: r })), () => setReadings((x) => ({ ...x, [id]: { status: "done", rows: [], failed: true } })));
    });
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const r = addWallet(saved, input, label);
    if (!r.ok) return setError(T.errors[r.error]);
    update(r.list);
    setInput("");
    setLabelText("");
    setError(null);
  };
  const saveConnected = () => {
    const r = connected ? addWallet(saved, connected) : null;
    if (r && !r.ok) return setError(T.errors[r.error]);
    if (r) (update(r.list), setError(null));
  };

  const done = list.map((w) => readings[w.address.toLowerCase()]);
  const sum = totals(done.map((r) => (r?.status === "done" ? r.rows : [])));
  const waiting = done.some((r) => r?.status !== "done");
  const incomplete = done.some((r) => r?.status === "done" && r.failed);

  return <section className="cd-glass cd-wallets" aria-labelledby="cd-wallets-title">
    <div className="cd-card-top"><div><h2 id="cd-wallets-title">{T.title}</h2><p className="cd-caption">{T.help}</p></div>{list.length > 0 && <button className="cd-icon-button" onClick={again} aria-label={T.refresh} title={T.refresh}><RefreshCw size={17} /></button>}</div>
    <p className="cd-wallets-privacy"><LockKeyhole size={13} />{T.privacy}</p>
    {!kept && <p className="cd-inline-note"><TriangleAlert size={15} />{T.noStorage}</p>}
    <form className="cd-wallets-add" onSubmit={add}>
      <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={T.addPlaceholder} aria-label="Wallet address to save" autoComplete="off" spellCheck={false} />
      <input value={label} maxLength={MAX_LABEL} onChange={(e) => setLabelText(e.target.value)} placeholder={T.labelPlaceholder} aria-label="Label for this wallet" autoComplete="off" />
      <button className="cd-button cd-button-dark" type="submit"><Plus size={14} />{T.add}</button>
    </form>
    <p className="cd-caption">{capNote(MAX_WALLETS)} {saved.length} saved.</p>
    {error && <p className="cd-dialog-status is-error" role="alert">{error}</p>}
    {list.length > 0 && <div className="cd-wallets-total"><div><span className="cd-card-label">{T.totalLabel}</span><strong>{waiting ? T.reading : formatUsd(sum.total)}</strong></div><small>{waiting ? "" : `${formatUsd(sum.armed)} armed · ${sum.positions} ${sum.positions === 1 ? "position" : "positions"} · ${list.length} ${list.length === 1 ? "wallet" : "wallets"}`}</small>{incomplete && <small className="cd-wallets-warn"><TriangleAlert size={13} />{T.incomplete}</small>}</div>}
    {list.length === 0 && <p className="cd-caption">{T.empty}</p>}
    <div className="cd-wallet-list">{list.map((w) => <WalletCard key={w.address} net={net} w={w} reading={readings[w.address.toLowerCase()]} onSave={saveConnected} onRemove={() => update(removeWallet(saved, w.address))} onRename={(l) => update(setLabel(saved, w.address, l))} onOpen={() => onOpen(w.address)} />)}</div>
    {saved.length > 0 && <div className="cd-wallets-clear">{confirmClear
      ? <><span className="cd-caption">{T.clearConfirm}</span><button className="cd-button cd-button-light" onClick={() => setConfirmClear(false)}>Keep</button><button className="cd-button cd-button-dark" onClick={() => (update([]), setConfirmClear(false))}>{T.clear}</button></>
      : <button className="cd-button cd-button-light" onClick={() => setConfirmClear(true)}><Trash2 size={14} />{T.clear}</button>}</div>}
  </section>;
}
