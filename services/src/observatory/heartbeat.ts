import { z } from "zod";
import { verifyTypedData, type Address, type Hex } from "viem";
const seconds = z.number().int().nonnegative().max(253402300799);
export const Heartbeat = z
  .strictObject({
    chainId: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    alarmBook: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    agent: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    scope: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    sequence: z
      .string()
      .regex(/^(0|[1-9]\d{0,19})$/)
      .refine((s) => BigInt(s) < 2n ** 64n),
    issuedAt: seconds,
    expiresAt: seconds,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .refine(
    (r) => r.expiresAt > r.issuedAt && r.expiresAt - r.issuedAt <= 3600,
    "Heartbeats last at most one hour",
  );
export const heartbeatTypes = {
  Heartbeat: [
    { name: "agent", type: "address" },
    { name: "scope", type: "bytes32" },
    { name: "sequence", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export function heartbeatTyped(
  r: Omit<z.infer<typeof Heartbeat>, "signature">,
) {
  return {
    domain: {
      name: "Canopy Liveness",
      version: "1",
      chainId: r.chainId,
      verifyingContract: r.alarmBook as Address,
    },
    types: heartbeatTypes,
    primaryType: "Heartbeat" as const,
    message: {
      agent: r.agent as Address,
      scope: r.scope as Hex,
      sequence: BigInt(r.sequence),
      issuedAt: BigInt(r.issuedAt),
      expiresAt: BigInt(r.expiresAt),
    },
  };
}
export async function verifyHeartbeat(
  raw: unknown,
  expected: {
    chainId: number;
    alarmBook: Address;
    agent: Address;
    scope: Hex;
    lastSequence: string | null;
  },
  now = Math.floor(Date.now() / 1000),
) {
  const r = Heartbeat.parse(raw);
  if (
    expected.lastSequence !== null &&
    !/^(0|[1-9]\d{0,19})$/.test(expected.lastSequence)
  )
    throw new Error("Invalid prior sequence");
  const bound =
    r.chainId === expected.chainId &&
    r.alarmBook.toLowerCase() === expected.alarmBook.toLowerCase() &&
    r.agent.toLowerCase() === expected.agent.toLowerCase() &&
    r.scope.toLowerCase() === expected.scope.toLowerCase();
  const valid = await verifyTypedData({
    ...heartbeatTyped(r),
    address: expected.agent,
    signature: r.signature as Hex,
  }).catch(() => false);
  const newer =
    expected.lastSequence === null ||
    BigInt(r.sequence) > BigInt(expected.lastSequence);
  const fresh = r.issuedAt <= now && r.expiresAt > now;
  return {
    version: 1,
    feature: "heartbeat",
    chainId: r.chainId,
    observedAt: { evaluatedAt: now },
    data: {
      agent: r.agent,
      scope: r.scope,
      sequence: r.sequence,
      expiresAt: r.expiresAt,
      state:
        !bound || !valid
          ? "invalid"
          : !newer
            ? "replayed"
            : !fresh
              ? "expired-or-future"
              : "recent-signed-heartbeat",
      bound,
      signatureValid: valid,
      newer,
      fresh,
    },
    limitations: [
      "A signed heartbeat establishes recent control of the configured EOA key, not correct monitoring, agent health, or contract-wallet signature support.",
      "Preserve the last accepted sequence for replay protection. A heartbeat cannot arm, disarm, trade or authorize funds. This domain is separate from AlarmBook attestations.",
    ],
  };
}
