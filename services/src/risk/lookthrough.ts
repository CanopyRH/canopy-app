import {
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
const abi = parseAbi([
  "function asset() view returns(address)",
  "function owner() view returns(address)",
  "function curator() view returns(address)",
  "function guardian() view returns(address)",
  "function adaptersLength() view returns(uint256)",
  "function adapters(uint256) view returns(address)",
  "function MORPHO() view returns(address)",
  "function morpho() view returns(address)",
  "function parentVault() view returns(address)",
  "function marketIdsLength() view returns(uint256)",
  "function marketIds(uint256) view returns(bytes32)",
  "function expectedSupplyAssets(bytes32) view returns(uint256)",
  "function withdrawQueueLength() view returns(uint256)",
  "function withdrawQueue(uint256) view returns(bytes32)",
  "function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32) view returns(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
]);
export interface ExposureNode {
  address: Address;
  depth: number;
  asset: Address | null;
  roles: Record<string, Address | null>;
  adapters: Address[];
  markets: {
    id: Hex;
    collateral: Address;
    oracle: Address;
    irm: Address;
    lltv: string;
    allocationAssets: string;
    utilizationBps: string | null;
    lastAccrual: string;
    adapter?: Address;
    accounting?: "expected-adapter-assets" | "stored-vault-shares";
  }[];
  unknown: string[];
}
export interface ExposureGraph {
  blockNumber: bigint;
  nodes: ExposureNode[];
  edges: {
    from: Address;
    to: Address;
    kind: "asset" | "collateral";
    cycle: boolean;
  }[];
  truncated: boolean;
  coverage: string;
}
/** Bounded chain reads at one block. Never interprets failed interface probes as proof that collateral is safe. */
export async function lookThrough(
  client: PublicClient,
  root: Address,
  blockNumber: bigint,
): Promise<ExposureGraph> {
  const nodes: ExposureNode[] = [],
    edges: ExposureGraph["edges"] = [];
  let truncated = false;
  const seen = new Set<string>();
  const deadline = Date.now() + 15_000;
  let reads = 0,
    marketsRead = 0;
  const exhausted = () => reads >= 256 || Date.now() >= deadline;
  async function read<T>(
    address: Address,
    functionName: string,
    args: unknown[] = [],
  ): Promise<T | null> {
    if (exhausted()) {
      truncated = true;
      return null;
    }
    reads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.readContract({
          address,
          abi,
          functionName,
          args,
          blockNumber,
        } as never) as Promise<T>,
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => {
              truncated = true;
              resolve(null);
            },
            Math.min(4000, Math.max(1, deadline - Date.now())),
          );
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const queue: { address: Address; depth: number; ancestors: string[] }[] = [
    { address: root, depth: 0, ancestors: [] },
  ];
  while (queue.length) {
    const item = queue.shift()!,
      id = item.address.toLowerCase();
    if (seen.has(id)) continue;
    if (nodes.length >= 20 || exhausted()) {
      truncated = true;
      break;
    }
    seen.add(id);
    const [asset, owner, curator, guardian, length, morpho, count] =
      await Promise.all([
        read<Address>(item.address, "asset"),
        read<Address>(item.address, "owner"),
        read<Address>(item.address, "curator"),
        read<Address>(item.address, "guardian"),
        read<bigint>(item.address, "adaptersLength"),
        read<Address>(item.address, "MORPHO"),
        read<bigint>(item.address, "withdrawQueueLength"),
      ]);
    const node: ExposureNode = {
      address: item.address,
      depth: item.depth,
      asset,
      roles: { owner, curator, guardian },
      adapters: [],
      markets: [],
      unknown: [],
    };
    nodes.push(node);
    function add(to: Address, kind: "asset" | "collateral") {
      if (to === zeroAddress) return;
      const lower = to.toLowerCase(),
        cycle = lower === id || item.ancestors.includes(lower);
      edges.push({ from: item.address, to, kind, cycle });
      if (cycle) {
        node.unknown.push("Cyclic exposure; value is not counted twice");
        return;
      }
      if (item.depth >= 3) {
        truncated = true;
        return;
      }
      queue.push({
        address: to,
        depth: item.depth + 1,
        ancestors: [...item.ancestors, id],
      });
    }
    if (asset) add(asset, "asset");
    else
      node.unknown.push(
        "ERC-4626 asset interface unavailable; token or unsupported contract",
      );
    if (length !== null) {
      if (length > 12n) truncated = true;
      const adaptersSeen = new Set<string>();
      for (let i = 0n; i < length && i < 12n; i++) {
        if (exhausted() || marketsRead >= 32) {
          truncated = true;
          break;
        }
        const a = await read<Address>(item.address, "adapters", [i]);
        if (!a) {
          node.unknown.push(`Adapter ${i} unreadable`);
          continue;
        }
        if (adaptersSeen.has(a.toLowerCase())) {
          node.unknown.push(`Duplicate adapter ${a}; counted once`);
          continue;
        }
        adaptersSeen.add(a.toLowerCase());
        node.adapters.push(a);
        const [parent, core, marketCount] = await Promise.all([
          read<Address>(a, "parentVault"),
          read<Address>(a, "morpho"),
          read<bigint>(a, "marketIdsLength"),
        ]);
        if (
          parent?.toLowerCase() !== item.address.toLowerCase() ||
          !core ||
          marketCount === null
        ) {
          node.unknown.push(
            `Adapter ${a}: unsupported allocation interface; no weight inferred`,
          );
          continue;
        }
        if (marketCount > 12n) truncated = true;
        const marketIdsSeen = new Set<string>();
        for (let j = 0n; j < marketCount && j < 12n; j++) {
          if (exhausted() || marketsRead >= 32) {
            truncated = true;
            break;
          }
          marketsRead++;
          const id = await read<Hex>(a, "marketIds", [j]);
          if (!id) {
            node.unknown.push(`Adapter ${a} market ${j} unreadable`);
            continue;
          }
          if (marketIdsSeen.has(id.toLowerCase())) {
            node.unknown.push(`Duplicate market ${id}; counted once`);
            continue;
          }
          marketIdsSeen.add(id.toLowerCase());
          const [params, market, allocation] = await Promise.all([
            read<readonly [Address, Address, Address, Address, bigint]>(
              core,
              "idToMarketParams",
              [id],
            ),
            read<readonly bigint[]>(core, "market", [id]),
            read<bigint>(a, "expectedSupplyAssets", [id]),
          ]);
          if (!params || !market || allocation === null) {
            node.unknown.push(
              `Adapter ${a} market ${id} allocation unavailable`,
            );
            continue;
          }
          node.markets.push({
            id,
            collateral: params[1],
            oracle: params[2],
            irm: params[3],
            lltv: params[4].toString(),
            allocationAssets: allocation.toString(),
            utilizationBps:
              market[0] === 0n
                ? null
                : ((market[2]! * 10000n) / market[0]!).toString(),
            lastAccrual: market[4]!.toString(),
            adapter: a,
            accounting: "expected-adapter-assets",
          });
          if (allocation > 0n) add(params[1], "collateral");
        }
        node.unknown.push(
          `Adapter ${a}: interface observations, not a bytecode audit or complete portfolio valuation`,
        );
      }
    } else if (morpho && count !== null) {
      if (count > 12n) truncated = true;
      const marketIdsSeen = new Set<string>();
      for (let i = 0n; i < count && i < 12n; i++) {
        if (exhausted() || marketsRead >= 32) {
          truncated = true;
          break;
        }
        marketsRead++;
        const marketId = await read<Hex>(item.address, "withdrawQueue", [i]);
        if (!marketId) {
          node.unknown.push(`Market ${i} unreadable`);
          continue;
        }
        if (marketIdsSeen.has(marketId.toLowerCase())) {
          node.unknown.push(`Duplicate market ${marketId}; counted once`);
          continue;
        }
        marketIdsSeen.add(marketId.toLowerCase());
        const [params, market, position] = await Promise.all([
          read<readonly [Address, Address, Address, Address, bigint]>(
            morpho,
            "idToMarketParams",
            [marketId],
          ),
          read<readonly bigint[]>(morpho, "market", [marketId]),
          read<readonly bigint[]>(morpho, "position", [marketId, item.address]),
        ]);
        if (!params || !market || !position) {
          node.unknown.push(`Market ${marketId} incomplete`);
          continue;
        }
        // Morpho's stored accounting, with virtual asset/share offsets. Not accrued-to-now earnings.
        const allocation =
          (position[0]! * (market[0]! + 1n)) / (market[1]! + 1_000_000n);
        node.markets.push({
          id: marketId,
          collateral: params[1],
          oracle: params[2],
          irm: params[3],
          lltv: params[4].toString(),
          allocationAssets: allocation.toString(),
          accounting: "stored-vault-shares",
          utilizationBps:
            market[0] === 0n
              ? null
              : ((market[2]! * 10000n) / market[0]!).toString(),
          lastAccrual: market[4]!.toString(),
        });
        if (position[0]! > 0n) add(params[1], "collateral");
      }
    } else if (asset)
      node.unknown.push("Market allocation interface unavailable");
  }
  return {
    blockNumber,
    nodes,
    edges,
    truncated,
    coverage:
      "ERC-4626 assets, Morpho V1 stored withdrawal-queue allocations and compatible Morpho V2 adapter expectedSupplyAssets. Unsupported adapters and truncated dependencies remain unknown; values are in each vault asset, not cross-asset portfolio weights.",
  };
}
