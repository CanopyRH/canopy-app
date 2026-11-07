import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "../services/node_modules/viem";
import { privateKeyToAccount } from "../services/node_modules/viem/accounts";
import { loadEnv } from "../services/src/env";
import { requireV2 } from "../services/src/chain/version";
import { alarmBookAbi } from "../services/src/chain/abi";
try {
  const env = loadEnv(process.env);
  if (!env.WATCHER_PRIVATE_KEY || !env.ROUTER || !env.ALARM_BOOK)
    throw new Error("Missing configuration");
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  if ((await client.getChainId()) !== env.CHAIN_ID)
    throw new Error("Wrong chain");
  await requireV2(client, {
    router: env.ROUTER as Address,
    alarmBook: env.ALARM_BOOK as Address,
  });
  const signer = privateKeyToAccount(env.WATCHER_PRIVATE_KEY as Hex).address;
  const [since, until, block] = await Promise.all([
    client.readContract({
      address: env.ALARM_BOOK as Address,
      abi: alarmBookAbi,
      functionName: "watcherSince",
      args: [signer],
    }),
    client.readContract({
      address: env.ALARM_BOOK as Address,
      abi: alarmBookAbi,
      functionName: "watcherUntil",
      args: [signer],
    }),
    client.getBlock(),
  ]);
  if (!since || block.timestamp < since || block.timestamp >= until)
    throw new Error("Watcher inactive");
  if (!env.WATCHERS.toLowerCase().split(",").includes(signer.toLowerCase()))
    throw new Error("Not locally approved");
  if (!env.WATCHER_EVIDENCE_DIR) throw new Error("Evidence directory missing");
  console.log(
    JSON.stringify({
      ready: true,
      chainId: env.CHAIN_ID,
      signer,
      approvedUntil: until.toString(),
      classifierConfigured: !!env.ANTHROPIC_API_KEY,
    }),
  );
} catch {
  console.error(
    "Preflight failed: check chain, v2 addresses, active watcher approval, local allowlist and evidence directory. No credentials printed.",
  );
  process.exit(1);
}
