import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readBorrowPosition } from "./morpho";
import { BorrowPolicy, planBorrowRepayment } from "./plan";
const abi = parseAbi([
  "function OWNER() view returns(address)",
  "function MORPHO() view returns(address)",
  "function ALARM_BOOK() view returns(address)",
  "function MARKET_ID() view returns(bytes32)",
  "function active() view returns(bool)",
  "function expiresAt() view returns(uint64)",
  "function withdrawShareBps() view returns(uint16)",
  "function remainingBudget() view returns(uint256)",
  "function keys() view returns(bytes32[])",
  "function allowance(address,address) view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function isLive(bytes32,uint256) view returns(bool)",
  "function repay(uint256 requested,bytes32 alarmKey) returns(uint256 paid,uint256 collateralPaid)",
]);
/** Same-block discovery and guard binding, then simulation. Returns an unsigned transaction; caller re-prepares before sending. */
export async function prepareBorrowRepayment(
  client: PublicClient,
  config: {
    chainId: number;
    guard: Address;
    owner: Address;
    morpho: Address;
    alarmBook: Address;
    market: Hex;
    health: Address;
  },
  executor: Address,
  policy: Parameters<typeof planBorrowRepayment>[1],
  session?: Parameters<typeof planBorrowRepayment>[4],
  now = Math.floor(Date.now() / 1000),
) {
  if ((await client.getChainId()) !== config.chainId)
    throw new Error("Wrong RPC chain");
  BorrowPolicy.parse(policy);
  const block = await client.getBlock();
  if (
    !Number.isSafeInteger(now) ||
    Number(block.timestamp) > now + 5 ||
    now - Number(block.timestamp) > policy.maxObservationAge
  )
    throw new Error("Stale or future chain head");
  const read = (address: Address, functionName: string, args: unknown[] = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber: block.number,
    } as never) as Promise<any>;
  const [owner, morpho, book, market, active, expiry, withdraw, budget, keys] =
    await Promise.all(
      [
        "OWNER",
        "MORPHO",
        "ALARM_BOOK",
        "MARKET_ID",
        "active",
        "expiresAt",
        "withdrawShareBps",
        "remainingBudget",
        "keys",
      ].map((name) => read(config.guard, name)),
    );
  for (const [actual, expected] of [
    [owner, config.owner],
    [morpho, config.morpho],
    [book, config.alarmBook],
    [market, config.market],
  ])
    if (String(actual).toLowerCase() !== expected!.toLowerCase())
      throw new Error("Guard does not match owner-reviewed configuration");
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8)
    throw new Error("Invalid guard alarm list");
  let key: Hex | null = null;
  for (const candidate of keys)
    if (await read(book, "isLive", [candidate, 86400n])) {
      key = candidate;
      break;
    }
  const position = await readBorrowPosition(
    client,
    config.morpho,
    config.market,
    config.owner,
    config.health,
    block,
  );
  const [allowance, balance] = await Promise.all([
    read(position.loanToken, "allowance", [owner, config.guard]),
    read(position.loanToken, "balanceOf", [owner]),
  ]);
  const plan = planBorrowRepayment(
    position,
    policy,
    {
      active,
      expiresAt: Number(expiry),
      withdrawShareBps: Number(withdraw),
      remainingBudget: budget,
      allowance,
      balance,
      alarmLive: key !== null,
    },
    Number(block.timestamp),
    session,
  );
  if (plan.action !== "repay") return { plan, position, transaction: null };
  if (!key) throw new Error("No live alarm");
  const args = [plan.requested, key] as const;
  await client.simulateContract({
    address: config.guard,
    abi,
    functionName: "repay",
    args,
    account: executor,
    blockNumber: block.number,
  });
  return {
    plan,
    position,
    transaction: {
      chainId: config.chainId,
      from: executor,
      to: config.guard,
      value: 0n,
      data: encodeFunctionData({ abi, functionName: "repay", args }),
    },
  };
}
