import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { Address, Hex } from "viem";
import { levelLabel, type LevelBps } from "../../../services/src/api/levels";
import type { AlarmIo } from "../alarms";
import { LEVEL_COPY } from "../copy/levels";
import { chosenLevel, levelViews, withLevel, type LevelView } from "../levels";

/**
 * Picks how far the share price must fall under its high before the "Vault loss" alarm exits you: 0.5%, 1%, 2%, 5% or 10%.
 * The keys are worked out in the browser from the vault address, and each level is read from the chain before it can be
 * chosen, so one that is going off, or can't be read, is greyed out. The 0.5% level is the "Vault loss" alarm above it.
 */
export function LevelPicker({ io, vault, picked, setPicked, busy }: { io: AlarmIo; vault: Address; picked: Hex[]; setPicked: (keys: Hex[]) => void; busy: boolean }) {
  const [views, setViews] = useState<LevelView[] | null>(null);
  useEffect(() => void levelViews(io, vault).then(setViews), [io, vault]);
  const now = chosenLevel(vault, picked);
  const choose = (bps: LevelBps | null) => setPicked(withLevel(vault, picked, bps));

  return <div className="cd-level-picker">
    <div className="cd-section-heading"><h3>{LEVEL_COPY.title}</h3></div>
    <p className="cd-caption">{LEVEL_COPY.tradeoff}</p>
    <div className="cd-alarm-editor" role="radiogroup" aria-label={LEVEL_COPY.title}>
      <label className={`cd-alarm-option ${now === null ? "is-selected" : ""}`}>
        <input type="radio" name="loss-level" disabled={busy} checked={now === null} onChange={() => choose(null)} />
        <span className="cd-checkbox-mark">{now === null && <Check size={12} strokeWidth={3} />}</span>
        <span><strong>{LEVEL_COPY.off}</strong><small>{LEVEL_COPY.offNote}</small></span>
      </label>
      {(views ?? []).map(({ bps, status }) => {
        const on = now === bps;
        return <label key={bps} className={`cd-alarm-option ${on ? "is-selected" : ""}`}>
          <input type="radio" name="loss-level" disabled={status !== "clear" || busy} checked={on} onChange={() => choose(bps)} />
          <span className="cd-checkbox-mark">{on && <Check size={12} strokeWidth={3} />}</span>
          <span><strong>{levelLabel(bps)}</strong><small>{status === "going-off" ? LEVEL_COPY.tripped : status === "unreadable" ? LEVEL_COPY.unreadable : LEVEL_COPY.note(levelLabel(bps))}</small></span>
        </label>;
      })}
      {views === null && <p className="cd-caption">{LEVEL_COPY.reading}</p>}
    </div>
  </div>;
}
