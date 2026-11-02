import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import { preflight, type Launch } from "../deploy/preflight";

const NOW = 1_800_000_000;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [STABLE, WETH, ROUTER, FEED, PROPOSER, GUARDIAN, VAULT, KEEPER, DEPLOYER, PLAN] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(A) as [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];

type Chain = { code: Address[]; thresholds: Record<string, bigint>; answer: bigint; updatedAt: bigint; asset: Address; balance: bigint };
const chain = (over: Partial<Chain> = {}): Chain => ({
  code: [STABLE, WETH, ROUTER, FEED, PROPOSER, GUARDIAN, VAULT, PLAN],
  thresholds: { [PROPOSER]: 3n, [GUARDIAN]: 2n },
  answer: 100_000_000n, updatedAt: BigInt(NOW - 60), asset: STABLE, balance: 10n ** 16n, ...over,
});
const client = (c: Chain) => ({
  getCode: async ({ address }: { address: Address }) => (c.code.includes(address) ? "0x60" : undefined),
  getBalance: async () => c.balance,
  readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (functionName === "getThreshold") {
      if (!(address in c.thresholds)) throw new Error("not a Safe");
      return c.thresholds[address];
    }
    if (functionName === "decimals") return 8;
    if (functionName === "latestRoundData") return [1n, c.answer, 0n, c.updatedAt, 1n];
    if (functionName === "asset") return c.asset;
    if (functionName === "totalAssets") return 5n;
    throw new Error(functionName);
  },
}) as unknown as PublicClient;

const launch = (): Launch => ({
  settings: {
    chainId: 4663, proposer: PROPOSER, guardian: GUARDIAN, stable: STABLE, weth: WETH, swapRouter: ROUTER, stableFeed: FEED,
    heartbeat: 90_000, adminExpiry: NOW + 365 * 86_400, watchers: [A(11), A(12), A(13)], vaults: [VAULT], keeper: KEEPER, deployer: DEPLOYER,
    auditReport: "https://audit.example.org/report.pdf", auditedCommit: "abc123", termsApproved: true,
  },
  deployEnv: {
    STABLE, WETH, SWAP_ROUTER: ROUTER, STABLE_FEED: FEED, PROPOSER_MULTISIG: PROPOSER, GUARDIAN_MULTISIG: GUARDIAN,
    STABLE_FEED_HEARTBEAT: "90000", ADMIN_EXPIRY: String(NOW + 365 * 86_400), TIMELOCK_DELAY: "0",
  },
  webChainId: 4663,
  services: {
    PUBLIC_URL: "https://api.canopy.test", DATABASE_URL: "postgres://u:p@db.canopy.test/canopy?sslmode=require",
    CHAIN_ID: "4663", PLAN_TOKEN: STABLE,
    RPC_URL: "https://lb.drpc.live/robinhood/key", RPC_URL_BACKUP: "https://rpc.provider-b.test/key",
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s", HEALTH_TOKEN: "h", OPS_CHAT_ID: "1", ANTHROPIC_API_KEY: "k", FEED_URLS: "https://f.test",
    CARD_VAULTS: VAULT, PLAN_PAY_ADDRESS: PLAN,
  },
  webVaults: [VAULT], testConfigInWeb: false, contractsMatchAudit: () => true,
});

const failures = async (l: Launch, c = chain()) => (await preflight(client(c), l, NOW)).filter((x) => !x.ok && !x.reminder).map((x) => x.name);
const reminders = async (l: Launch) => (await preflight(client(chain()), l, NOW)).filter((x) => !x.ok && x.reminder).map((x) => x.name);

describe("preflight", () => {
  test("a complete launch passes every check", async () => {
    expect(await failures(launch())).toEqual([]);
  });

  test("Base still passes as a launch chain", async () => {
    const l = launch();
    l.settings.chainId = 8453;
    l.webChainId = 8453;
    l.services!.CHAIN_ID = "8453";
    expect(await failures(l)).toEqual([]);
  });
});
