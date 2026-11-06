import { z } from "zod";

/**
 * The one list of the API's public routes. GET /openapi.json is built from it, and a test fails if a route exists in the
 * app without an entry here or in INTERNAL_ROUTES. Add a route, add its entry in the same change.
 */

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("A 20-byte address, 0x followed by 40 hex digits.");
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("A 32-byte value, 0x followed by 64 hex digits.");
const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).describe("Hex bytes.");

export const errorSchema = z.object({ error: z.string().describe("What went wrong, in plain words."), code: z.string().optional().describe("A stable machine-readable code, on the routes that set one.") });

const vaultSchema = z.object({ address: addressSchema, name: z.string(), chainId: z.number().int(), asset: z.string() });
const aliveSchema = z.object({ key: bytes32Schema, fired_at: z.number().int().describe("Unix seconds when the alarm fired.") });
const cardSchema = z.looseObject({
  numbers: z.record(z.string(), z.unknown()).describe("On-chain facts about the vault, such as its name and asset."),
  text: z.string().describe("The risk card in plain words."),
  updated_at: z.union([z.string(), z.number()]).describe("Unix seconds of the last refresh."),
});
const presetSchema = z.object({
  name: z.string(),
  note: z.string(),
  key: bytes32Schema.describe("The alarm key. Pass keys to /calldata/arm."),
  detector: z.object({ kind: z.number().int(), target: addressSchema, threshold: z.string().describe("A base-10 integer."), window: z.number().int(), a: bytes32Schema, b: bytes32Schema }),
});
const exitsSchema = z.object({
  summary: z.object({ total: z.number().int(), timed: z.number().int(), medianSeconds: z.number().nullable(), longestSeconds: z.number().nullable() }),
  exits: z.array(
    z.object({
      id: z.string(),
      vault: z.object({ address: addressSchema, name: z.string().nullable() }).nullable(),
      alarm: z.object({ key: bytes32Schema, name: z.string(), firedAt: z.number().nullable() }).nullable().describe("Null for an Exit Now."),
      ranAt: z.number().nullable().describe("Unix seconds of the exit's block, or null while that is not known yet."),
      seconds: z.number().nullable().describe("Seconds from the alarm to the exit."),
      paid: z.array(z.object({ token: addressSchema, amount: z.string().describe("Base units, a base-10 integer."), symbol: z.string().nullable(), decimals: z.number().nullable() })),
      tx: bytes32Schema,
    }),
  ),
  next: z.string().nullable().describe("Pass as `before` for the next page. Null on the last page."),
});

const callSchema = z.object({
  step: z.enum(["approve", "arm", "exit", "disarmAll"]),
  to: addressSchema,
  data: hexSchema,
  value: z.literal("0"),
  note: z.string(),
});
const armedSchema = z.object({ chainId: z.number().int(), vault: addressSchema, keys: z.array(bytes32Schema), calls: z.array(callSchema).describe("In order: approve, then arm. Send both from the owner's wallet.") });
const exitCalldataSchema = z.object({ chainId: z.number().int(), vault: addressSchema, owner: addressSchema, positionId: bytes32Schema, calls: z.array(callSchema).length(1) });
const disarmCalldataSchema = z.object({ chainId: z.number().int(), calls: z.array(callSchema).length(1) });
const refusedSchema = z.object({
  error: z.string(),
  code: z.literal("keys_refused"),
  keys: z.array(z.object({ key: bytes32Schema, reason: z.enum(["not_registered", "not_armable", "unreadable"]) })),
});

type Param = { description: string; schema: z.ZodType; example?: string };
export interface RouteDef {
  method: "get";
  /** Hono path syntax: `:vault` for a path parameter. */
  path: string;
  summary: string;
  description: string;
  tag: "Reads" | "Calldata" | "Agents";
  params?: Record<string, Param>;
  query?: Record<string, Param & { required?: boolean }>;
  ok: { contentType: "application/json" | "text/plain" | "text/plain; charset=utf-8"; schema?: z.ZodType; description: string; headers?: Record<string, { description: string; schema: object }> };
  errors?: { status: number; description: string; schema?: z.ZodType }[];
  /** Whether the shared per-address read limit applies. True for every route today. */
  rateLimited: boolean;
}

const vaultParam: Param = { description: "The vault's contract address.", schema: addressSchema, example: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" };
const noContracts = { status: 503, description: "This deployment runs alerts only and has no Canopy contracts.", schema: errorSchema };

export const ROUTES: RouteDef[] = [
  {
    method: "get", path: "/vaults", tag: "Reads", rateLimited: true,
    summary: "List the vaults Canopy covers",
    description: "Every vault with a risk card that the deployment lists. A plain array.",
    ok: { contentType: "application/json", schema: z.array(vaultSchema), description: "The vaults." },
  },
  {
    method: "get", path: "/alarms/live", tag: "Reads", rateLimited: true,
    summary: "Alarms that fired in the last day",
    description: "Newest first. A full page names the next one in the X-Next-Before header; pass it back as `before`.",
    query: {
      limit: { description: "Alarms per page, 1 to 1000. Default 1000.", schema: z.number().int().min(1).max(1000) },
      before: { description: "A cursor from X-Next-Before: firedAt, a colon, then the key.", schema: z.string().regex(/^\d{1,12}:0x[0-9a-fA-F]{64}$/) },
    },
    ok: {
      contentType: "application/json", schema: z.array(aliveSchema), description: "The alarms.",
      headers: { "X-Next-Before": { description: "Present when the page is full. The cursor for the next page.", schema: { type: "string" } } },
    },
    errors: [{ status: 400, description: "The cursor is malformed.", schema: errorSchema }],
  },
  {
    method: "get", path: "/risk/:target", tag: "Reads", rateLimited: true,
    summary: "A vault's risk card",
    description: "Plain-words facts about one vault: who can change it, what it is exposed to, how much could be withdrawn.",
    params: { target: vaultParam },
    ok: { contentType: "application/json", schema: cardSchema, description: "The card." },
    errors: [{ status: 400, description: "Not an address.", schema: errorSchema }, { status: 404, description: "No card for that vault.", schema: errorSchema }],
  },
  {
    method: "get", path: "/presets/:target", tag: "Reads", rateLimited: true,
    summary: "The alarm presets a vault can use",
    description: "Each preset's name, note, detector and key. Nothing is armed by default: the owner chooses which keys to arm.",
    params: { target: vaultParam },
    ok: { contentType: "application/json", schema: z.array(presetSchema), description: "The presets." },
    errors: [{ status: 400, description: "Not an address.", schema: errorSchema }],
  },
  {
    method: "get", path: "/exits", tag: "Reads", rateLimited: true,
    summary: "The public exit log",
    description: "Every exit, newest first, with how long the alarm took to run it and what was paid out. No owner or caller address is listed.",
    query: {
      limit: { description: "Exits per page, 1 to 100. Default 20.", schema: z.number().int().min(1).max(100) },
      before: { description: "Return exits with an id below this. Use `next` from the last page.", schema: z.string().regex(/^\d{1,18}$/) },
    },
    ok: { contentType: "application/json", schema: exitsSchema, description: "A summary and a page of exits." },
    errors: [{ status: 400, description: "Bad paging.", schema: errorSchema }],
  },
  {
    method: "get", path: "/alarms/record", tag: "Reads", rateLimited: true,
    summary: "The public alarm record",
    description: "Every alarm that fired, newest first: a hard rule or a watcher quorum, the exits that followed, the time to the first one, and the operator's review. An alarm nobody has reviewed is never counted as correct.",
    query: {
      limit: { description: "Alarms per page, 1 to 100.", schema: z.number().int().min(1).max(100) },
      before: { description: "A cursor from `next`: firedAt, a colon, then the key.", schema: z.string().regex(/^\d{1,12}:0x[0-9a-fA-F]{64}$/) },
      vault: { description: "Only alarms on this vault.", schema: addressSchema },
      outcome: { description: "Only alarms with this review outcome.", schema: z.string() },
    },
    ok: { contentType: "application/json", description: "A summary, the vaults, and a page of alarms with `next`." },
    errors: [{ status: 400, description: "A malformed query.", schema: errorSchema }],
  },
  {
    method: "get", path: "/board", tag: "Reads", rateLimited: true,
    summary: "The armed board",
    description: "What is armed right now: the armed value, positions, wallets, exits and time to exit. Cached for a minute. No owner address is listed.",
    ok: { contentType: "application/json", description: "The board's numbers." },
    errors: [{ status: 503, description: "The board could not be worked out and there is no earlier answer.", schema: errorSchema }],
  },
  {
    method: "get", path: "/status", tag: "Reads", rateLimited: true,
    summary: "Is Canopy working right now",
    description: "Whether Canopy's services are running and keeping up with the chain. Only fields that are safe to show.",
    ok: { contentType: "application/json", description: "The status." },
  },
  {
    method: "get", path: "/calldata/arm", tag: "Calldata", rateLimited: true,
    summary: "Calldata to arm a vault position",
    description:
      "Returns the approve and arm calls for a vault, using the router's v2 arm tuple with the raw harbour and `swaps: []`. Every key is read from the chain first: it must be registered in AlarmBook and armable now, or nothing is returned. " +
      "The API only builds calldata. It never signs, holds a key or takes a recipient, and no exit can pay anyone but the owner. The owner's wallet sends both calls. Arming again replaces the position's keys, so send every key it should keep.",
    query: {
      vault: { description: "The vault to arm.", schema: addressSchema, required: true, example: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" },
      keys: { description: "Comma-separated alarm keys, 1 to 8. Take them from /presets/{target}.", schema: z.string(), required: true },
    },
    ok: { contentType: "application/json", schema: armedSchema, description: "The calls to send, in order." },
    errors: [
      { status: 400, description: "A missing, malformed or unknown parameter. A recipient is never accepted.", schema: errorSchema },
      { status: 422, description: "A key is not registered, not armable now, or could not be read. Nothing is returned for the rest.", schema: refusedSchema },
      { status: 502, description: "The chain could not be read.", schema: errorSchema },
      noContracts,
    ],
  },
  {
    method: "get", path: "/calldata/exit", tag: "Calldata", rateLimited: true,
    summary: "Calldata for an owner's Exit Now",
    description:
      "The router's exit call for the owner's armed position in a vault. The owner address is only used to work out the position id: it is not stored, and funds go to the owner on-chain whatever is sent. Exit Now is free. " +
      "A position that is not armed has no router exit: the owner withdraws from the vault as usual.",
    query: {
      vault: { description: "The vault.", schema: addressSchema, required: true },
      owner: { description: "The position's owner, the wallet that will send the call.", schema: addressSchema, required: true },
    },
    ok: { contentType: "application/json", schema: exitCalldataSchema, description: "The call to send from the owner's wallet." },
    errors: [
      { status: 400, description: "A missing, malformed or unknown parameter. A recipient is never accepted.", schema: errorSchema },
      { status: 404, description: "That owner has no armed position in the vault.", schema: errorSchema },
      { status: 502, description: "The chain could not be read.", schema: errorSchema },
      noContracts,
    ],
  },
  {
    method: "get", path: "/calldata/disarm-all", tag: "Calldata", rateLimited: true,
    summary: "Calldata to disarm every position",
    description: "The router's disarmAll call. It is free and only the owner should send it. Do not give an agent the right to send it.",
    ok: { contentType: "application/json", schema: disarmCalldataSchema, description: "The call." },
    errors: [noContracts],
  },
  {
    method: "get", path: "/openapi.json", tag: "Agents", rateLimited: true,
    summary: "This description",
    description: "The OpenAPI 3.1 description of the public API.",
    ok: { contentType: "application/json", description: "An OpenAPI 3.1 document." },
  },
  {
    method: "get", path: "/llms.txt", tag: "Agents", rateLimited: true,
    summary: "What Canopy is, for language models",
    description: "A short plain-text brief: the hard rules, the API address, the contracts and the links to the spec and docs.",
    ok: { contentType: "text/plain; charset=utf-8", description: "Plain text." },
  },
];

/** Routes the app has that are not for callers of the public API. Each says why. */
export const INTERNAL_ROUTES: { method: string; path: string; why: string }[] = [
  { method: "GET", path: "/health", why: "Operator health check behind a bearer token." },
  { method: "POST", path: "/watcher/attest", why: "Approved watchers post signed attestations here." },
  { method: "POST", path: "/tg/webhook", why: "Telegram calls this with its secret token." },
  { method: "POST", path: "/alarms/review", why: "The operator marks an alarm reviewed, behind the health bearer token." },
];

const honoToOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${honoToOpenApi(path)}`;

const schemaOf = (s: z.ZodType) => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  return rest;
};

export interface SpecOptions { baseUrl: string; perMin: number }

/** The OpenAPI 3.1 document. Plain JSON, no references, so a reader needs nothing else to use it. */
export function buildOpenApi(o: SpecOptions) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const parameters = [
      ...Object.entries(r.params ?? {}).map(([name, p]) => ({ name, in: "path", required: true, description: p.description, schema: schemaOf(p.schema), ...(p.example ? { example: p.example } : {}) })),
      ...Object.entries(r.query ?? {}).map(([name, p]) => ({ name, in: "query", required: p.required ?? false, description: p.description, schema: schemaOf(p.schema), ...(p.example ? { example: p.example } : {}) })),
    ];
    const content = (type: string, schema?: z.ZodType) => ({ [type]: schema ? { schema: schemaOf(schema) } : { schema: { type: "string" } } });
    const responses: Record<string, unknown> = {
      "200": { description: r.ok.description, ...(r.ok.headers ? { headers: r.ok.headers } : {}), content: r.ok.schema ? content(r.ok.contentType, r.ok.schema) : { [r.ok.contentType]: { schema: r.ok.contentType === "application/json" ? { type: "object" } : { type: "string" } } } },
    };
    for (const e of r.errors ?? []) responses[String(e.status)] = { description: e.description, content: content("application/json", e.schema ?? errorSchema) };
    if (r.rateLimited) {
      responses["429"] = {
        description: `More than ${o.perMin} reads from one address in a minute. Wait Retry-After seconds.`,
        headers: { "Retry-After": { description: "Seconds until the window resets.", schema: { type: "integer" } } },
        content: content("application/json", errorSchema),
      };
    }
    paths[honoToOpenApi(r.path)] = {
      [r.method]: {
        operationId: r.method + r.path.replace(/[:/.-]+(\w)/g, (_m, c: string) => c.toUpperCase()),
        summary: r.summary,
        description: r.description,
        tags: [r.tag],
        ...(parameters.length ? { parameters } : {}),
        responses,
        ...(r.rateLimited ? { "x-rate-limit": { requests: o.perMin, windowSeconds: 60, per: "client address (IPv6 counted by /64)" } } : {}),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Canopy API",
      version: "1.0.0",
      summary: "Read-only API and calldata helpers for Canopy, the DeFi auto-exit.",
      description:
        "Canopy exits a vault position when an alarm the owner chose fires. This API reads alarms, risk cards and exits, and builds calldata for the owner's wallet to send. " +
        "It never signs, never holds a key and never takes a recipient: the exit contract has no recipient field and pays only the position owner. " +
        "Agents may arm and tighten. Only owners loosen or disarm. The contracts have not had an external audit yet.",
    },
    servers: [{ url: o.baseUrl }],
    tags: [{ name: "Reads" }, { name: "Calldata" }, { name: "Agents" }],
    paths,
  };
}
