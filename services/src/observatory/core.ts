import {
  getAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const obsAbi = parseAbi([
  "function asset() view returns(address)",
  "function totalAssets() view returns(uint256)",
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function maxWithdraw(address) view returns(uint256)",
  "function convertToAssets(uint256) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
  "function owner() view returns(address)",
  "function curator() view returns(address)",
  "function guardian() view returns(address)",
  "function implementation() view returns(address)",
  "function price() view returns(uint256)",
  "function BASE_FEED_1() view returns(address)",
  "function BASE_FEED_2() view returns(address)",
  "function QUOTE_FEED_1() view returns(address)",
  "function QUOTE_FEED_2() view returns(address)",
  "function BASE_VAULT() view returns(address)",
  "function QUOTE_VAULT() view returns(address)",
  "function SCALE_FACTOR() view returns(uint256)",
  "function description() view returns(string)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);
export class ObservatoryError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const address = (v: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v))
    throw new ObservatoryError("bad_address", "Use a complete address.");
  return getAddress(v.toLowerCase());
};
export const serial = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_, n) => (typeof n === "bigint" ? n.toString() : n)),
  );
export async function bounded<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ObservatoryError(
                "timeout",
                "The data source did not answer in time.",
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function observe(
  client: PublicClient,
  chainId: number,
  now = Math.floor(Date.now() / 1000),
) {
  if ((await bounded(client.getChainId())) !== chainId)
    throw new ObservatoryError(
      "wrong_chain",
      "The data source is on the wrong network.",
    );
  const b = await bounded(client.getBlock());
  if (
    b.number === null ||
    !b.hash ||
    b.timestamp > BigInt(now + 15) ||
    BigInt(now) - b.timestamp > 120n
  )
    throw new ObservatoryError(
      "stale_head",
      "A recent, mined block is required.",
    );
  let count = 0;
  const deadline = Date.now() + 20_000;
  async function attempt<T>(f: () => Promise<T>): Promise<T | null> {
    if (++count > 160 || Date.now() >= deadline) return null;
    try {
      return await bounded(
        f(),
        Math.min(4000, Math.max(1, deadline - Date.now())),
      );
    } catch {
      return null;
    }
  }
  const read = <T>(at: Address, name: string, args: unknown[] = []) =>
    attempt(
      () =>
        client.readContract({
          address: at,
          abi: obsAbi,
          functionName: name,
          args,
          blockNumber: b.number!,
        } as never) as Promise<T>,
    );
  return {
    client,
    chainId,
    blockNumber: b.number,
    blockHash: b.hash,
    timestamp: b.timestamp,
    read,
    attempt,
    code: (at: Address) =>
      attempt(
        async () =>
          (await client.getCode({ address: at, blockNumber: b.number! })) ??
          "0x",
      ),
    slot: (at: Address, slot: Hex) =>
      attempt(
        async () =>
          (await client.getStorageAt({
            address: at,
            slot,
            blockNumber: b.number!,
          })) ?? "0x",
      ),
    async finish<T>(feature: string, data: T, limitations: string[]) {
      const end = await bounded(client.getBlock({ blockNumber: b.number! }));
      if (end.hash !== b.hash)
        throw new ObservatoryError(
          "reorg",
          "The observed block changed. Read again.",
        );
      return serial({
        version: 1,
        feature,
        chainId,
        observedAt: { block: b.number, hash: b.hash, timestamp: b.timestamp },
        data,
        limitations,
      });
    },
  };
}
export type Observation = Awaited<ReturnType<typeof observe>>;
export const fractionBps = (n: bigint, d: bigint): string | null =>
  d <= 0n ? null : ((n * 10000n) / d).toString();
