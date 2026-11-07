import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  zeroAddress,
} from "viem";
const abi = parseAbi([
  "function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32) view returns(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function price() view returns(uint256)",
  "function value() view returns(uint256)",
  "function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns(uint256)",
]);
export const WAD = 10n ** 18n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function accruedDebt(
  shares: bigint,
  borrowAssets: bigint,
  borrowShares: bigint,
  rate: bigint,
  elapsed: bigint,
) {
  for (const n of [shares, borrowAssets, borrowShares, rate, elapsed])
    if (n < 0n || n >= 2n ** 256n) throw new Error("Invalid market accounting");
  if (elapsed > 365n * 86400n)
    throw new Error("Market accrual too old for this reader");
  const x = rate * elapsed,
    second = (x * x) / (2n * WAD),
    compound = x + second + (second * x) / (3n * WAD);
  const assets = borrowAssets + (borrowAssets * compound) / WAD;
  if (assets >= 2n ** 128n)
    throw new Error("Accrued debt exceeds market storage");
  return ceil(shares * (assets + 1n), borrowShares + 1_000_000n);
}
export interface BorrowPosition {
  market: Hex;
  owner: Address;
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  lltv: bigint;
  borrowShares: bigint;
  collateral: bigint;
  debt: bigint;
  collateralValue: bigint;
  ltv: bigint | null;
  headroomBps: bigint;
  block: bigint;
  observedAt: number;
  priceUsable: boolean;
}
export async function readBorrowPosition(
  client: PublicClient,
  morpho: Address,
  id: Hex,
  owner: Address,
  health: Address,
  block: { number: bigint; timestamp: bigint },
): Promise<BorrowPosition> {
  const read = (address: Address, functionName: string, args: unknown[] = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber: block.number,
    } as never) as Promise<any>;
  const [p, m, rawPosition] = await Promise.all([
    read(morpho, "idToMarketParams", [id]),
    read(morpho, "market", [id]),
    read(morpho, "position", [id, owner]),
  ]);
  const pos = rawPosition as readonly [bigint, bigint, bigint];
  const [loanToken, collateralToken, oracle, irm, lltv] = p as [
    Address,
    Address,
    Address,
    Address,
    bigint,
  ];
  const actual = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      p,
    ),
  );
  if (
    actual.toLowerCase() !== id.toLowerCase() ||
    m[4] === 0n ||
    m[4] > block.timestamp ||
    lltv <= 0n ||
    lltv >= WAD
  )
    throw new Error("Invalid Morpho market");
  const params = { loanToken, collateralToken, oracle, irm, lltv };
  const state = {
    totalSupplyAssets: m[0],
    totalSupplyShares: m[1],
    totalBorrowAssets: m[2],
    totalBorrowShares: m[3],
    lastUpdate: m[4],
    fee: m[5],
  };
  const [rate, price, fresh] = await Promise.all([
    irm === zeroAddress ? 0n : read(irm, "borrowRateView", [params, state]),
    read(oracle, "price").catch(() => null),
    read(health, "value").catch(() => null),
  ]);
  const debt = accruedDebt(pos[1], m[2], m[3], rate, block.timestamp - m[4]);
  const usable = price !== null && price > 0n && fresh === 2n,
    collateralValue = usable ? (pos[2] * price) / 10n ** 36n : 0n;
  const capacity = (collateralValue * lltv) / WAD;
  return {
    market: id,
    owner,
    loanToken,
    collateralToken,
    oracle,
    lltv,
    borrowShares: pos[1],
    collateral: pos[2],
    debt,
    collateralValue,
    ltv:
      usable && collateralValue > 0n
        ? ceil(debt * WAD, collateralValue)
        : debt === 0n
          ? 0n
          : null,
    headroomBps:
      debt === 0n
        ? 10000n
        : capacity > debt
          ? ((capacity - debt) * 10000n) / capacity
          : 0n,
    block: block.number,
    observedAt: Number(block.timestamp),
    priceUsable: usable,
  };
}
/** Bounded discovery over owner-reviewed market IDs, never an unbounded chain history scan. */
export async function discoverBorrowing(
  client: PublicClient,
  chainId: number,
  morpho: Address,
  owner: Address,
  markets: { id: Hex; health: Address }[],
) {
  if (
    markets.length > 64 ||
    new Set(markets.map((m) => m.id.toLowerCase())).size !== markets.length
  )
    throw new Error("At most 64 unique reviewed markets");
  if ((await client.getChainId()) !== chainId)
    throw new Error("Wrong RPC chain");
  const block = await client.getBlock();
  const positions: BorrowPosition[] = [],
    unknown: Hex[] = [];
  for (const market of markets) {
    try {
      const p = await readBorrowPosition(
        client,
        morpho,
        market.id,
        owner,
        market.health,
        block,
      );
      if (p.borrowShares > 0n || p.collateral > 0n) positions.push(p);
    } catch {
      unknown.push(market.id);
    }
  }
  return { block: block.number, positions, unknown };
}
