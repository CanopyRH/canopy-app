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
    STABLE_FEED_HEARTBEAT: "90000", ADMIN_EXPIRY: String(NOW + 365 * 86_400), TIMELOCK_DELAY: "0", WATCHERS: [A(11), A(12), A(13)].join(","),
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

  test("the audit and the lawyer's review are reminders, never failures", async () => {
    const l = launch();
    delete l.settings.auditReport;
    delete l.settings.auditedCommit;
    l.settings.termsApproved = false;
    expect(await failures(l)).toEqual([]);
    expect(await reminders(l)).toEqual(["External audit report is linked", "A lawyer approved the terms", "Contracts are unchanged since the audited commit"]);
  });
  test("contracts changed after an audit raise a reminder", async () => {
    const l = launch();
    l.contractsMatchAudit = () => false;
    expect(await failures(l)).toEqual([]);
    expect(await reminders(l)).toEqual(["Contracts are unchanged since the audited commit"]);
  });

  const broken: [string, string, (l: Launch) => void, Partial<Chain>?][] = [
    ["the wrong chain", "Settings target a launch chain", (l) => { l.settings.chainId = 84532; }],
    ["a web app on another chain", "Web app targets the same chain", (l) => { l.webChainId = 8453; }],
    ["services on another chain", "Services run on the same chain", (l) => { l.services!.CHAIN_ID = "8453"; }],
    ["plan payments in another token", "Plan payments use the launch stablecoin", (l) => { l.services!.PLAN_TOKEN = WETH; }],
    ["a delay over 30 days", "Timelock delay is 0 to 30 days", (l) => { l.settings.timelockDelay = 31 * 86_400; }],
    ["files that disagree on the delay", "launch.env and settings.json agree on TIMELOCK_DELAY", (l) => { l.deployEnv.TIMELOCK_DELAY = "3600"; }],
    ["a test Timelock", "No test Timelock", (l) => { l.settings.testTimelockDelay = 60; }],
    ["plain-wallet admins", "No plain-wallet admins", (l) => { l.settings.allowEoaAdmin = true; }],
    ["an expiry too soon", "Admin expiry is 180 to 730 days away", (l) => { l.settings.adminExpiry = NOW + 86_400; }],
    ["an expiry too far", "Admin expiry is 180 to 730 days away", (l) => { l.settings.adminExpiry = NOW + 800 * 86_400; }],
    ["a heartbeat over two days", "Feed heartbeat is valid", (l) => { l.settings.heartbeat = 200_000; }],
    ["files that disagree", "launch.env and settings.json agree on PROPOSER_MULTISIG", (l) => { l.deployEnv.PROPOSER_MULTISIG = GUARDIAN; }],
    ["one Safe in both roles", "Proposer and guardian are different Safes", (l) => { l.settings.guardian = PROPOSER; }],
    ["a one-signer Safe", "Guardian Safe needs 2 or more signers", () => {}, { thresholds: { [PROPOSER]: 2n, [GUARDIAN]: 1n } }],
    ["a plain wallet as a Safe", "Proposer Safe needs 2 or more signers", () => {}, { thresholds: { [GUARDIAN]: 2n } }],
    ["files that disagree on the watchers", "launch.env and settings.json agree on WATCHERS", (l) => { l.deployEnv.WATCHERS = [A(11), A(12), A(14)].join(","); }],
    ["no WATCHERS in launch.env", "launch.env and settings.json agree on WATCHERS", (l) => { delete l.deployEnv.WATCHERS; }],
    ["a repeated watcher", "Three different watchers", (l) => { l.settings.watchers = [A(11), A(11), A(13)]; }],
    ["the keeper as a watcher", "Keeper is separate from the watchers", (l) => { l.settings.keeper = A(11); }],
    ["a keeper with no gas", "Keeper holds gas", () => {}, { balance: 1n }],
    ["a deployer with no gas", "Deployer holds gas", () => {}, { balance: 1n }],
    ["a missing contract", "Swap router contract exists", () => {}, { code: [STABLE, WETH, FEED, PROPOSER, GUARDIAN, VAULT, PLAN] }],
    ["a depegged feed", "Feed reads about $1", () => {}, { answer: 80_000_000n }],
    ["a stale feed", "Feed is fresh", () => {}, { updatedAt: BigInt(NOW - 100_000) }],
    ["a vault missing from settings", "settings.json lists exactly the web app's vaults", (l) => { l.webVaults = [VAULT, A(20)]; }],
    ["a vault in another asset", `Vault ${VAULT.slice(0, 8)} holds the stablecoin`, () => {}, { asset: WETH }],
    ["a test config in the web app", "Web app has no test deployment", (l) => { l.testConfigInWeb = true; }],
    ["no service settings", "Service settings file was given", (l) => { l.services = null; }],
    ["a blank secret", "Service secrets are set", (l) => { l.services!.HEALTH_TOKEN = ""; }],
    ["a placeholder", "No placeholder values remain", (l) => { l.services!.PUBLIC_URL = "https://api.example.com"; }],
    ["a placeholder RPC key", "No placeholder values remain", (l) => { l.services!.RPC_URL = "https://lb.drpc.live/robinhood/YOUR_KEY"; }],
    ["a plain HTTP URL", "Public URL uses HTTPS", (l) => { l.services!.PUBLIC_URL = "http://api.canopy.test"; }],
    ["a database without TLS", "Database requires TLS", (l) => { l.services!.DATABASE_URL = "postgres://u:p@db/canopy"; }],
    ["a public RPC", "RPC is a private endpoint", (l) => { l.services!.RPC_URL = "https://mainnet.base.org"; }],
    ["the public Robinhood RPC", "RPC is a private endpoint", (l) => { l.services!.RPC_URL = "https://rpc.mainnet.chain.robinhood.com"; }],
    ["keyless dRPC", "RPC is a private endpoint", (l) => { l.services!.RPC_URL = "https://robinhood.drpc.org"; }],
    ["one RPC twice", "Backup RPC is a different provider", (l) => { l.services!.RPC_URL_BACKUP = l.services!.RPC_URL!; }],
    ["a vault with no card", "CARD_VAULTS covers every web vault", (l) => { l.services!.CARD_VAULTS = ""; }],
    ["plan payments to a wallet", "Plan payments go to a multisig", (l) => { l.services!.PLAN_PAY_ADDRESS = A(30); }],
  ];
  for (const [what, name, breakIt, over] of broken) {
    test(`stops on ${what}`, async () => {
      const l = launch();
      breakIt(l);
      expect(await failures(l, chain(over))).toContain(name);
    });
  }
});
