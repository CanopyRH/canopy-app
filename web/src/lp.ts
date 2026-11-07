import {
  readerPresets,
  orderedDetectors,
} from "../../services/src/api/readerPresets";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { network, type Net, type Signer } from "./chain";
import { sendTx } from "./wallet";
import { termsHash, registerTx, exitTx } from "./tx";
import { stablePayout, RAW_PAYOUT } from "./stableExit";
import { presetStatus } from "./alarms";
import {
  Kind,
  keyOf,
  presetsFor,
  type Preset,
} from "../../services/src/api/presets";
import {
  routerAbi,
  alarmBookAbi,
} from "../../services/src/chain/abi.generated";
import type { Chain } from "./config";

export const lpAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function approve(address,uint256)",
  "function factory() view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function symbol() view returns (string)",
  "function ROUTER() view returns (address)",
  "function POSITIONS() view returns (address)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const lpPositionId = (
  owner: Address,
  adapter: Address,
  manager: Address,
  tokenId: bigint,
) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [owner, adapter, manager, tokenId],
    ),
  );
export const rangeState = (tick: number, lower: number, upper: number) =>
  tick >= lower && tick < upper ? "In range" : "Out of range";

export function lpNetwork(c: Chain, net: Net = network(c)) {
  const client = net.client,
    manager = c.lp?.positionManager,
    adapter = c.lp?.adapter;
  const requireManager = () => {
    if (!manager)
      throw new Error("LP positions are not configured for this chain.");
    return manager;
  };
  async function deployment() {
    if (!adapter || !c.router || !c.alarmBook) return false;
    const [r, p, allowed] = await Promise.all([
      client.readContract({
        address: adapter,
        abi: lpAbi,
        functionName: "ROUTER",
      }),
      client.readContract({
        address: adapter,
        abi: lpAbi,
        functionName: "POSITIONS",
      }),
      client.readContract({
        address: c.router,
        abi: routerAbi,
        functionName: "adapterAllowed",
        args: [adapter],
      }),
    ]);
    return allowed && same(r, c.router) && same(p, requireManager());
  }
  async function position(owner: Address, id: bigint, blockNumber: bigint) {
    const npm = requireManager();
    const [holder, p, factory] = await Promise.all([
      client.readContract({
        address: npm,
        abi: lpAbi,
        functionName: "ownerOf",
        args: [id],
        blockNumber,
      }),
      client.readContract({
        address: npm,
        abi: lpAbi,
        functionName: "positions",
        args: [id],
        blockNumber,
      }),
      client.readContract({
        address: npm,
        abi: lpAbi,
        functionName: "factory",
        blockNumber,
      }),
    ]);
    if (!same(holder, owner))
      throw new Error("This position belongs to another wallet.");
    const pool = await client.readContract({
      address: factory,
      abi: lpAbi,
      functionName: "getPool",
      args: [p[2], p[3], p[4]],
      blockNumber,
    });
    if (pool === zeroAddress)
      throw new Error("The position's pool could not be found.");
    const [slot, symbol0, symbol1] = await Promise.all([
      client.readContract({
        address: pool,
        abi: lpAbi,
        functionName: "slot0",
        blockNumber,
      }),
      client
        .readContract({
          address: p[2],
          abi: lpAbi,
          functionName: "symbol",
          blockNumber,
        })
        .catch(() => p[2]),
      client
        .readContract({
          address: p[3],
          abi: lpAbi,
          functionName: "symbol",
          blockNumber,
        })
        .catch(() => p[3]),
    ]);
    const posId = adapter ? lpPositionId(owner, adapter, npm, id) : null;
    const armed =
      posId && c.router
        ? await client.readContract({
            address: c.router,
            abi: routerAbi,
            functionName: "isArmed",
            args: [posId],
            blockNumber,
          })
        : false;
    return {
      id,
      pool,
      token0: p[2],
      token1: p[3],
      symbol0,
      symbol1,
      fee: p[4],
      lower: p[5],
      upper: p[6],
      tick: slot[1],
      liquidity: p[7],
      owed0: p[10],
      owed1: p[11],
      posId,
      armed,
      status: rangeState(slot[1], p[5], p[6]),
    };
  }
  async function scan(owner: Address, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid page.");
    if ((await client.getChainId()) !== c.chainId)
      throw new Error("The RPC is on another network.");
    const blockNumber = await client.getBlockNumber(),
      npm = requireManager();
    const total = await client.readContract({
      address: npm,
      abi: lpAbi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber,
    });
    const end = total < BigInt(offset + 12) ? Number(total) : offset + 12;
    const rows = await Promise.all(
      Array.from({ length: Math.max(0, end - offset) }, async (_, n) => {
        try {
          const id = await client.readContract({
            address: npm,
            abi: lpAbi,
            functionName: "tokenOfOwnerByIndex",
            args: [owner, BigInt(offset + n)],
            blockNumber,
          });
          return {
            ok: true as const,
            position: await position(owner, id, blockNumber),
          };
        } catch {
          return { ok: false as const };
        }
      }),
    );
    return {
      total,
      positions: rows.flatMap((r) => (r.ok ? [r.position] : [])),
      failed: rows.some((r) => !r.ok),
      next: BigInt(end) < total ? end : null,
      enabled: await deployment().catch(() => false),
    };
  }
  async function alarm(pool: Address, configured?: Preset) {
    const preset =
      configured ??
      presetsFor(pool).find((p) => p.detector.kind === Kind.QUORUM)!;
    if (!c.alarmBook) return { preset, status: "unreadable" as const };
    const book = c.alarmBook;
    const state = (key: Hex) =>
      client.readContract({
        address: book,
        abi: alarmBookAbi,
        functionName: "state",
        args: [key],
      });
    const status = await presetStatus(
      {
        check: (key) =>
          client.readContract({
            address: book,
            abi: alarmBookAbi,
            functionName: "check",
            args: [key],
          }),
        firedAt: async (key) => (await state(key))[1],
        now: async () => (await client.getBlock()).timestamp,
        known: async (key) => (await state(key))[0],
        armable: (key) =>
          client.readContract({
            address: book,
            abi: alarmBookAbi,
            functionName: "armable",
            args: [key],
          }),
      },
      preset,
    );
    return { preset, status };
  }
  async function alarms(pool: Address) {
    return Promise.all(
      [
        presetsFor(pool).find((p) => p.detector.kind === Kind.QUORUM)!,
        ...readerPresets(pool, c.lp?.alarms ?? []),
      ].map((p) => alarm(pool, p)),
    );
  }
  async function arm(
    s: Signer,
    id: bigint,
    choice: "raw" | "stable",
    selected?: Hex[],
  ) {
    if (!(await deployment()))
      throw new Error("The LP adapter has not been enabled on this network.");
    const npm = requireManager(),
      p = await position(s.account, id, await client.getBlockNumber());
    const available = await alarms(p.pool);
    const chosen = selected ?? [available[0]!.preset.key];
    if (
      !chosen.length ||
      chosen.length > 8 ||
      new Set(chosen).size !== chosen.length
    )
      throw new Error("Choose one to eight distinct alarms.");
    const picked = chosen.map((k) => available.find((a) => a.preset.key === k));
    if (picked.some((a) => !a || a.status !== "clear"))
      throw new Error(
        "This alarm is going off or cannot be read. Nothing was sent.",
      );
    const payout =
      choice === "stable" ? stablePayout(c, [p.token0, p.token1]) : RAW_PAYOUT;
    if (!payout)
      throw new Error("Reviewed stablecoin routes are missing for this pool.");
    const send = async (tx: { to: Address; data: Hex }) => {
      s.onConfirm();
      return sendTx(s.provider, client, s.account, tx, c);
    };
    for (const detector of orderedDetectors(picked.map((a) => a!.preset))) {
      const state = await client.readContract({
        address: c.alarmBook!,
        abi: alarmBookAbi,
        functionName: "state",
        args: [keyOf(detector)],
      });
      if (!state[0]) await send(registerTx(c.alarmBook!, detector));
    }
    const [approved, all] = await Promise.all([
      client.readContract({
        address: npm,
        abi: lpAbi,
        functionName: "getApproved",
        args: [id],
      }),
      client.readContract({
        address: npm,
        abi: lpAbi,
        functionName: "isApprovedForAll",
        args: [s.account, c.router!],
      }),
    ]);
    if (!all && !same(approved, c.router!))
      await send({
        to: npm,
        data: encodeFunctionData({
          abi: lpAbi,
          functionName: "approve",
          args: [c.router!, id],
        }),
      });
    const tx = {
      to: c.router!,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "arm",
        args: [
          {
            adapter: adapter!,
            target: npm,
            tokenId: id,
            ...payout,
            termsHash: termsHash(),
            keys: chosen,
          },
        ],
      }),
    };
    await client.call({ account: s.account, ...tx });
    return send(tx);
  }
  async function exit(s: Signer, id: bigint) {
    if (!adapter || !c.router) throw new Error("No LP adapter is configured.");
    const posId = lpPositionId(s.account, adapter, requireManager(), id);
    const tx = exitTx(c.router, posId);
    await client.call({ account: s.account, ...tx });
    s.onConfirm();
    return sendTx(s.provider, client, s.account, tx, c);
  }
  return { scan, alarm, alarms, arm, exit, deployment };
}
export type LpPosition = Awaited<
  ReturnType<ReturnType<typeof lpNetwork>["scan"]>
>["positions"][number];
