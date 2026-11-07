import { formatUnits } from "viem";
import { PREVIEW, VERDICT } from "./copy/preview";
import type { AlarmStatus } from "./alarms";

/**
 * What an exit would pay right now. Pure logic over a few chain reads, so it can be tested without a chain.
 * It follows the real path: ExitRouter pulls min(balance, allowance) shares, ERC4626Adapter tries a full redeem, falls
 * back to maxRedeem when that fails, and hands any unredeemed shares back to the owner.
 */

/** The vault reads the preview needs, all for one owner. */
export interface VaultIo {
  /** previewRedeem(shares): what the vault says these shares are worth. */
  previewRedeem: (shares: bigint) => Promise<bigint>;
  /** maxRedeem(owner): shares the vault would let out now. Some vaults, such as Morpho Vault V2, report 0. */
  maxRedeem: () => Promise<bigint>;
  /** maxWithdraw(owner): assets the vault would let out now. Also 0 on some vaults. */
  maxWithdraw: () => Promise<bigint>;
  /** A dry run of redeem(shares) as the owner. The assets it would pay, or null when the vault refuses. Sends nothing. */
  redeemNow: (shares: bigint) => Promise<bigint | null>;
}

export type Liquidity = "full" | "partial" | "none";

export interface Payout {
  /** Shares an exit would pull. */
  shares: bigint;
  /** What those shares are worth at the vault's own price. */
  worth: bigint;
  /** What the vault would pay now. */
  payNow: bigint;
  liquidity: Liquidity;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** An exit takes min(balance, allowance). A position that is not armed yet is previewed as if arming gave full approval. */
export async function payout(io: VaultIo, held: bigint, approved: bigint | null): Promise<Payout> {
  const shares = approved === null ? held : min(held, approved);
  if (shares === 0n) return { shares, worth: 0n, payNow: 0n, liquidity: "none" };
  const worth = await io.previewRedeem(shares);
  const all = await io.redeemNow(shares);
  if (all !== null) return { shares, worth, payNow: all, liquidity: "full" };
  // The adapter's fallback: redeem what maxRedeem allows, if that is some but not all of it.
  const [maxShares, maxAssets] = await Promise.all([io.maxRedeem().catch(() => 0n), io.maxWithdraw().catch(() => 0n)]);
  if (maxShares > 0n && maxShares < shares) {
    const part = await io.previewRedeem(maxShares);
    return { shares, worth, payNow: maxAssets > 0n ? min(part, maxAssets) : part, liquidity: "partial" };
  }
  return { shares, worth, payNow: 0n, liquidity: "none" };
}

export interface AlarmLine { name: string; status: AlarmStatus }

export interface Preview {
  armed: boolean;
  held: bigint;
  /** Shares the router may take. Null when the position is not armed, or the allowance could not be read. */
  approved: bigint | null;
  /** Null when the vault could not be read. */
  payout: Payout | null;
  /** True when the vault's gates would stop an exit. Null when they were not checked or could not be. */
  blocked: boolean | null;
  /** Null when the alarms could not be read at all, or auto-exit is not live. */
  alarms: AlarmLine[] | null;
}

export interface PreviewDeps {
  vault: VaultIo;
  allowance: () => Promise<bigint>;
  blocked: () => Promise<boolean | null>;
  alarms: () => Promise<AlarmLine[] | null>;
}

/** Runs every read for one position. A read that fails leaves its part empty and never takes the others down. */
export async function buildPreview(deps: PreviewDeps, held: bigint, armed: boolean): Promise<Preview> {
  const approved = armed ? await deps.allowance().catch(() => null) : null;
  const [pay, blocked, alarms] = await Promise.all([
    // An armed position whose allowance can't be read is not previewed: guessing it could overstate the payout.
    armed && approved === null ? null : payout(deps.vault, held, approved).catch(() => null),
    deps.blocked().catch(() => null),
    deps.alarms().catch(() => null),
  ]);
  return { armed, held, approved, payout: pay, blocked, alarms };
}

/** The worst status wins: going off, then can't be read, then clear. Null when there are no alarms to judge. */
export function worstAlarm(lines: AlarmLine[] | null): AlarmStatus | null {
  if (!lines || lines.length === 0) return null;
  const all = lines.map((l) => l.status);
  return all.includes("going-off") ? "going-off" : all.includes("unreadable") ? "unreadable" : "clear";
}

/** An amount in the vault's asset. Stablecoin vaults use 6 decimals, as the rest of the app assumes. */
export const money = (v: bigint, asset: string) =>
  `${Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${asset}`;

export type Tone = "good" | "warn" | "bad";

/** One plain sentence, and how worried to look. */
export function verdict(p: Preview, asset: string): { text: string; tone: Tone } {
  if (!p.payout || (p.armed && p.approved === null)) return { text: VERDICT.unreadable, tone: "bad" };
  if (p.blocked) return { text: VERDICT.blocked, tone: "bad" };
  const { payNow, worth, liquidity, shares } = p.payout;
  if (p.armed && shares === 0n && p.held > 0n) return { text: VERDICT.noApproval, tone: "bad" };
  if (liquidity === "none") return { text: VERDICT.none, tone: "bad" };
  const worst = worstAlarm(p.alarms);
  const alarm = worst === "going-off" ? VERDICT.alarmsGoingOff : worst === "unreadable" ? VERDICT.alarmsUnreadable : worst === "clear" ? VERDICT.alarmsClear : "";
  let text: string = liquidity === "partial" ? VERDICT.partial(money(payNow, asset), money(worth, asset)) : p.armed ? VERDICT.full(money(payNow, asset)) : VERDICT.fullIdle(money(payNow, asset));
  const short = p.armed && p.approved !== null && p.approved < p.held;
  if (short) text += ` ${VERDICT.partialApproval(Number((p.approved! * 100n) / p.held))}`;
  const tone: Tone = short || liquidity === "partial" || worst === "going-off" || worst === "unreadable" ? "warn" : "good";
  return { text: alarm ? `${text} ${alarm}` : text, tone };
}

export const liquidityText = (l: Liquidity) => (l === "full" ? PREVIEW.liquidityFull : l === "partial" ? PREVIEW.liquidityPartial : PREVIEW.liquidityNone);
export const statusText = (s: AlarmStatus) => (s === "clear" ? PREVIEW.clear : s === "going-off" ? PREVIEW.goingOff : s === "warming-up" ? "Drain warming up" : s === "stale" ? "Drain reference stale" : PREVIEW.unreadable);
