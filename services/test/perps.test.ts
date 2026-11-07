import { test, expect } from "bun:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClose } from "../src/perps/closeOnly";
import { saveVenueKey, loadVenueKey } from "../src/perps/keystore";
const policy = {
  venue: "reviewed-fixture",
  account: "123",
  market: "BTC",
  maxCloseBps: 5000,
  maxSlippageBps: 100,
  expiresAt: 1000,
  maxObservationAge: 10,
};
const position = {
  venue: policy.venue,
  account: policy.account,
  market: policy.market,
  side: "long" as const,
  size: "100",
  mark: "10000",
  reference: "10000",
  observedAt: 100,
  referenceAt: 100,
  healthy: true,
};
const request = {
  size: "50",
  now: 105,
  armedPolicyMatches: true,
  alarmLive: true,
  venuePermissionsVerified: true,
};
test("close plans only reduce the pinned account inside size, time and independent price limits", () => {
  expect(planClose(policy, position, request)).toMatchObject({
    reduceOnly: true,
    recipient: null,
    side: "sell",
    limitPrice: "9900",
    size: "50",
  });
  for (const patch of [
    { size: "51" },
    { size: "101" },
    { now: 1000 },
    { now: 111 },
    { now: 99 },
    { alarmLive: false },
    { armedPolicyMatches: false },
    { venuePermissionsVerified: false },
  ])
    expect(() =>
      planClose(policy, position, { ...request, ...patch }),
    ).toThrow();
  for (const patch of [
    { account: "other" },
    { healthy: false },
    { mark: "10101" },
    { referenceAt: 1 },
  ])
    expect(() =>
      planClose(policy, { ...position, ...patch }, request),
    ).toThrow();
  expect(
    planClose(policy, { ...position, side: "short" }, request),
  ).toMatchObject({ side: "buy", limitPrice: "10100" });
});
test("venue keys are authenticated, account-bound and require private file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canopy-keys-")),
    path = join(directory, "key.json"),
    master = new Uint8Array(32).fill(5),
    context = { venue: "test", account: "owner-account", keyIndex: 2 },
    secret = Buffer.from("local-test-secret");
  try {
    await saveVenueKey(path, context, secret, master);
    expect((await loadVenueKey(path, context, master)).equals(secret)).toBe(
      true,
    );
    const alias = join(directory, "key-alias.json");
    await symlink(path, alias);
    await expect(loadVenueKey(alias, context, master)).rejects.toThrow();
    await expect(saveVenueKey(path, context, secret, master)).rejects.toThrow();
    await expect(
      loadVenueKey(path, { ...context, account: "other" }, master),
    ).rejects.toThrow();
    await expect(
      loadVenueKey(path, context, new Uint8Array(32)),
    ).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(loadVenueKey(path, context, master)).rejects.toThrow();
    await chmod(path, 0o600);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.ciphertext = "00" + envelope.ciphertext.slice(2);
    await writeFile(path, JSON.stringify(envelope));
    await expect(loadVenueKey(path, context, master)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
