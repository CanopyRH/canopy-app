/**
 * The armed board: the numbers people quote. Everything here is pure, so the maths is tested on fixtures; the plugin in
 * src/plugins/board.ts reads the database and the chain and hands the rows to `buildBoard`.
 *
 * Money is carried in millionths of a dollar (bigint) and turned into a plain number of dollars only at the end. Every
 * asset the board counts is a dollar stablecoin (USDG at launch), so one unit of the asset is one dollar.
 */

const DAY = 86_400;
const WEEK = 7 * DAY;
/** An alarm lives 24 hours (the contract's lifetime). A gap longer than that is not "alarm to exit", so it is left out. */
export const ALARM_LIFETIME = DAY;
/** The router pays swapped exits in its stablecoin, which has 6 decimals. */
export const STABLE_DECIMALS = 6;
const ONE_SHARE = 10n ** 18n;

/** A listed vault, as the board knows it. */
export interface BoardVault {
  address: string;
  name: string;
  assetDecimals: number;
}

/**
 * One armed position. `shares` is what the owner can still exit (balance capped by approval), read on-chain, or null
 * when that read failed. A null counts as armed but adds no value.
 */
export interface ArmedPosition {
  owner: string;
  target: string;
  shares: bigint | null;
}

/** One exit that landed, with what it paid. `firedAt` is the newest alarm fire before it, if the alarm is still on record. */
export interface ExitRecord {
  exitId: string;
  at: number | null;
  tx: string;
  target: string | null;
  alarm: string | null;
  firedAt: number | null;
  paid: { amount: bigint; decimals: number }[];
}

export interface BoardInput {
  now: number;
  vaults: BoardVault[];
  positions: ArmedPosition[];
  /**
   * Latest share price per vault from the cached `vault_snaps` (what `convertToAssets(1e18)` returned at the last scan),
   * in the asset's smallest units. A vault with none is not priced.
   */
  sharePrice: Map<string, bigint>;
  exits: ExitRecord[];
  txUrl: (tx: string) => string | undefined;
}

export interface Board {
  generatedAt: number;
  armed: {
    /** Dollars armed and watching, or null if share balances could not be read. */
    value: number | null;
    positions: number;
    wallets: number;
    /** Armed positions that could not be priced: no balance read or no share price yet. Their value is left out. */
    unpriced: number;
    topVaults: { vault: string; name: string; value: number | null; positions: number }[];
  };
  exits: {
    last24h: { count: number; value: number };
    last7d: { count: number; value: number };
    allTime: { count: number; value: number };
    /** Seconds from an alarm firing to the exit landing. Null until an exit has a known alarm. */
    secondsToExit: { fastest: number | null; median: number | null; samples: number };
    latest: { vault: string; alarm: string | null; secondsToExit: number | null; amount: number; at: number | null; tx: string; txUrl: string | null }[];
  };
}

const lc = (s: string) => s.toLowerCase();
const pow10 = (n: number) => 10n ** BigInt(n);

/** An amount in `decimals` places, as millionths of a dollar. */
export function toMicro(amount: bigint, decimals: number): bigint {
  return decimals >= 6 ? amount / pow10(decimals - 6) : amount * pow10(6 - decimals);
}

/** Millionths of a dollar as dollars, to the cent. */
export const dollars = (micro: bigint): number => Number(micro / 10_000n) / 100;

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  // For an even count, the lower middle: a whole number of seconds that really happened.
  return s.length % 2 ? s[mid]! : s[mid - 1]!;
};

/** Value of `shares` of one vault in millionths of a dollar, or null with no share price. */
function valueOf(shares: bigint, price: bigint | undefined, assetDecimals: number): bigint | null {
  if (price === undefined || price <= 0n) return null;
  return toMicro((shares * price) / ONE_SHARE, assetDecimals);
}

export function buildBoard(i: BoardInput): Board {
  const listed = new Map(i.vaults.map((v) => [lc(v.address), v]));

  // Armed. Only listed vaults count: anyone can deploy a vault with any share price and arm on it.
  const armed = i.positions.filter((p) => listed.has(lc(p.target)) && (p.shares === null || p.shares > 0n));
  const perVault = new Map<string, { micro: bigint; priced: number; positions: number }>();
  let totalMicro = 0n;
  let unpriced = 0;
  let anyRead = false;
  for (const p of armed) {
    const t = lc(p.target);
    const v = listed.get(t)!;
    const row = perVault.get(t) ?? { micro: 0n, priced: 0, positions: 0 };
    row.positions++;
    const micro = p.shares === null ? null : valueOf(p.shares, i.sharePrice.get(t), v.assetDecimals);
    if (p.shares !== null) anyRead = true;
    if (micro === null) unpriced++;
    else {
      row.micro += micro;
      row.priced++;
      totalMicro += micro;
    }
    perVault.set(t, row);
  }
  const knowsValue = armed.length === 0 || anyRead;
  const topVaults = [...perVault.entries()]
    .map(([t, r]) => ({ vault: t, name: listed.get(t)!.name, value: r.priced > 0 || r.positions === 0 ? dollars(r.micro) : null, positions: r.positions, micro: r.micro }))
    .sort((a, b) => (a.micro === b.micro ? b.positions - a.positions : a.micro > b.micro ? -1 : 1))
    .slice(0, 5)
    .map(({ micro: _m, ...v }) => v);

  // Exits, again on listed vaults only.
  const exits = i.exits.filter((e) => e.target !== null && listed.has(lc(e.target)));
  const valueOfExit = (e: ExitRecord) => e.paid.reduce((s, p) => s + toMicro(p.amount, p.decimals), 0n);
  const since = (from: number) => exits.filter((e) => e.at !== null && e.at >= from);
  const stat = (rows: ExitRecord[]) => ({ count: rows.length, value: dollars(rows.reduce((s, e) => s + valueOfExit(e), 0n)) });
  const secs = (e: ExitRecord) => {
    if (e.at === null || e.firedAt === null) return null;
    const d = e.at - e.firedAt;
    return d >= 0 && d <= ALARM_LIFETIME ? d : null;
  };
  const times = exits.map(secs).filter((x): x is number => x !== null);
  const latest = [...exits]
    .sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || (BigInt(b.exitId) > BigInt(a.exitId) ? 1 : -1))
    .slice(0, 5)
    .map((e) => ({
      vault: listed.get(lc(e.target!))!.name,
      alarm: e.alarm,
      secondsToExit: secs(e),
      amount: dollars(valueOfExit(e)),
      at: e.at,
      tx: e.tx,
      txUrl: i.txUrl(e.tx) ?? null,
    }));

  return {
    generatedAt: i.now,
    armed: { value: knowsValue ? dollars(totalMicro) : null, positions: armed.length, wallets: new Set(armed.map((p) => lc(p.owner))).size, unpriced, topVaults },
    exits: {
      last24h: stat(since(i.now - DAY)),
      last7d: stat(since(i.now - WEEK)),
      allTime: stat(exits),
      secondsToExit: { fastest: times.length ? Math.min(...times) : null, median: median(times), samples: times.length },
      latest,
    },
  };
}
