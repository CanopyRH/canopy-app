/**
 * Writes web/src/mainnet.base.json from the real Base deployment, at release. Until then the file stays all null, and the app
 * hides Base. Sends nothing and needs no key.
 *
 * Usage: bun deploy/web-base-config.ts <deploy/out/8453/deployment.json> <Base RPC url> [--out <file>]
 *
 * It refuses unless the deployment is for Base, every verify.ts check passes against the RPC, the plan payment address is a
 * contract, and the API URL is a real https address. A local fork (anvil) can only be written to another file with --out, so a
 * rehearsal can never fill the app's real config.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, isAddress, type Address, type PublicClient } from "viem";
import type { Deployment, Settings } from "./plan";
import { verifyDeployment } from "./verify";

export const BASE_CHAIN_ID = 8453;
export const WEB_BASE_FILE = join(import.meta.dir, "../../web/src/mainnet.base.json");

export interface WebChainFile {
  router: Address;
  adapter: Address;
  alarmBook: Address;
  planPayTo: Address;
  apiUrl: string;
  walletConnectProjectId: string | null;
}

/** The web config for Base from a deployment, or the reasons it can't be written. Keeps the current WalletConnect project. */
export function webBaseConfig(d: Deployment & { settings: Settings }, current: { walletConnectProjectId?: string | null }): { config: WebChainFile } | { problems: string[] } {
  const problems: string[] = [];
  const s = d.settings;
  if (s?.chainId !== BASE_CHAIN_ID) problems.push(`the deployment is for chain ${s?.chainId}, not Base (${BASE_CHAIN_ID})`);
  for (const k of ["router", "adapter", "alarmBook"] as const) if (!isAddress(d[k] ?? "")) problems.push(`${k} is not an address`);
  if (!isAddress(s?.planPayTo ?? "")) problems.push("settings.planPayTo is not an address: set the Base Payments Safe");
  const api = s?.apiUrl ?? "";
  if (!/^https:\/\/[^/]+/.test(api) || /YOUR_|example\.com|localhost|127\.0\.0\.1/.test(api)) problems.push(`settings.apiUrl "${api}" is not the Base API's https address`);
  if (problems.length) return { problems };
  return {
    config: {
      router: d.router, adapter: d.adapter, alarmBook: d.alarmBook, planPayTo: s.planPayTo!, apiUrl: api.replace(/\/+$/, ""),
      walletConnectProjectId: current.walletConnectProjectId ?? null,
    },
  };
}

/** True for a local test node, which answers as Base on a fork. */
export const isLocalNode = (clientVersion: string) => /anvil|hardhat|ganache|tenderly/i.test(clientVersion);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  const [file, rpc] = args;
  if (!file || !rpc || (outAt >= 0 && !out)) throw new Error("usage: bun deploy/web-base-config.ts <deployment.json> <Base RPC url> [--out <file>]");
  const target = out ?? WEB_BASE_FILE;
  const { settings, ...d } = JSON.parse(readFileSync(file, "utf8")) as Deployment & { settings: Settings };
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const stop = (why: string[]) => {
    for (const w of why) console.error(`STOP: ${w}`);
    console.error(`${target.split("/").slice(-3).join("/")} was not written.`);
    process.exit(1);
  };
  const chainId = await client.getChainId();
  if (chainId !== BASE_CHAIN_ID) stop([`that RPC is on chain ${chainId}, not Base`]);
  const node = String(await client.request({ method: "web3_clientVersion" } as never).catch(() => ""));
  if (isLocalNode(node) && target === WEB_BASE_FILE) stop([`that RPC is a local node (${node.split("/")[0]}), not Base. A rehearsal can write elsewhere with --out.`]);
  const built = webBaseConfig({ ...d, settings }, JSON.parse(readFileSync(WEB_BASE_FILE, "utf8")));
  if ("problems" in built) stop(built.problems);
  const checks = await verifyDeployment(client, d, settings);
  const failed = checks.filter((c) => !c.ok).map((c) => `verify: ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (failed.length) stop(failed);
  const config = (built as { config: WebChainFile }).config;
  if (((await client.getCode({ address: config.planPayTo })) ?? "0x").length <= 2) stop(["planPayTo has no code on Base: it must be the Base Payments Safe"]);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`all ${checks.length} verify checks passed. Wrote ${target.split("/").slice(-3).join("/")}: Base router ${config.router}, API ${config.apiUrl}`);
}
