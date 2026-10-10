export interface GateResult {
  ok: boolean;
  reason?: string;
  gains: Record<string, bigint>;
}

/** Pure check on before/after balances. */
export function judge(
  ownerBefore: bigint[],
  ownerAfter: bigint[],
  routerBefore: bigint[],
  routerAfter: bigint[],
  tokens: string[],
): GateResult {
  const gains: Record<string, bigint> = {};
  let any = false;
  for (let i = 0; i < tokens.length; i++) {
    const g = ownerAfter[i]! - ownerBefore[i]!;
    if (routerAfter[i]! !== routerBefore[i]!) return { ok: false, reason: `router residue ${tokens[i]}`, gains };
    if (g < 0n) return { ok: false, reason: `owner lost ${tokens[i]}`, gains };
    if (g > 0n) {
      any = true;
      gains[tokens[i]!] = g;
    }
  }
  return any ? { ok: true, gains } : { ok: false, reason: "nothing out", gains };
}

/** Largest amount that passes `simulate`: 100%, then 50%, 25% and so on, up to 6 steps. 0n means nothing passed. */
export async function sizeExit(total: bigint, simulate: (amount: bigint) => Promise<boolean>): Promise<bigint> {
  let amount = total;
  for (let i = 0; i < 6 && amount > 0n; i++) {
    if (await simulate(amount)) return amount;
    amount /= 2n;
  }
  return 0n;
}
