import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";
import { presetsFor } from "./presets";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";
import { acceptAttestation } from "../watcher/watcher";

const AttestBody = z.strictObject({
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  evidence: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deadline: z.string().regex(/^\d{1,20}$/),
  signer: z.string().refine((a) => isAddress(a)),
  sig: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const MAX_BODY = 64 * 1024;

export interface ApiDeps {
  db: Db;
  repo: Repo;
  vaults: () => Promise<{ address: Address; name: string; chainId: number; asset: string }[]>;
  liveAlarms: () => Promise<unknown[]>;
  watchers: Address[];
  alarmBook: Address;
  chainId: number;
  now: () => number;
  onAttested?: (key: Hex, evidence: Hex, deadline: bigint) => Promise<void>;
  telegram?: (update: unknown) => Promise<void>;
  telegramSecret?: string;
  health?: () => Promise<unknown>;
  healthToken?: string;
}
