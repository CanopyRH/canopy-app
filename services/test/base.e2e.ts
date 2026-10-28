/**
 * Full run on a local fork of Base: real contracts, a real USDC vault, a real holder.
 * Plan payment -> indexer -> watchers sign -> quorum fires -> keeper exits.
 * Start: bun test/base.e2e.ts <base rpc url>. Nothing leaves the local fork.
 */
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE } from "../src/chain/addresses";
import { createApi } from "../src/api/server";
import { applyPayment, applyRegistered, applyRouterLog, decodeFired, syncLogs } from "../src/indexer/indexer";
import { drainExits, onFired, type KeeperDeps } from "../src/keeper/keeper";
import { cardText, readCard } from "../src/risk/card";
import { migrate, type Db } from "../src/store/db";
import { repo } from "../src/store/repo";
import { maybeAttest, quorumCall } from "../src/watcher/watcher";
import type { Signal } from "../src/detectors";
import { approveTx, armTx, disarmAllTx, exitTx, planTx, PLAN_AMOUNTS, termsHash } from "../../web/src/tx";

const FORK = process.argv[2]!;
const PORT = 18545;
const URL_ = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "../..");
const VAULT = "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2" as Address; // Steakhouse USDC (V1)
const PAID = "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8" as Address; // real holder, about $519K
const FREE = "0xC30673F758E02069e28181edFD9D424c57f562af" as Address; // real holder, about $506
const PAY_TO = "0x00000000000000000000000000000000000caf0e" as Address;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const keeperKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const w1 = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const w2 = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);
