import { expect, test } from "bun:test";
import { cleanupAllowance } from "../src/allowanceCleanup";
import { decodeFunctionData, parseAbi } from "viem";
import { disarmTx, revokeTx } from "../src/tx";
const A = "0x0000000000000000000000000000000000000001";
const H = `0x${"11".repeat(32)}` as const;
function fixture(
  o: {
    armed?: boolean;
    allowance?: bigint;
    rejectDisarm?: boolean;
    rejectRevoke?: boolean;
    stuck?: boolean;
  } = {},
) {
  let armed = o.armed ?? true,
    allowance = o.allowance ?? 100n;
  const calls: string[] = [];
  return {
    calls,
    io: {
      armed: async () => armed,
      allowance: async () => allowance,
      disarm: async () => {
        calls.push("disarm");
        if (o.rejectDisarm) throw Error("rejected disarm");
        armed = false;
      },
      revoke: async () => {
        calls.push("revoke");
        if (o.rejectRevoke) throw Error("rejected revoke");
        if (!o.stuck) allowance = 0n;
      },
    },
  };
}
test("owner cleanup disarms before revoking and verifies zero approval", async () => {
  const f = fixture();
  expect(await cleanupAllowance(f.io)).toEqual({
    disarmed: true,
    revoked: true,
  });
  expect(f.calls).toEqual(["disarm", "revoke"]);
});
test("a rejected disarm never advances to revoke", async () => {
  const f = fixture({ rejectDisarm: true });
  await expect(cleanupAllowance(f.io)).rejects.toThrow("rejected disarm");
  expect(f.calls).toEqual(["disarm"]);
});
test("partial cleanup reports failure and can retry after disarming", async () => {
  const f = fixture({ rejectRevoke: true });
  await expect(cleanupAllowance(f.io)).rejects.toThrow("position was disarmed");
  const retry = fixture({ armed: false });
  await cleanupAllowance(retry.io);
  expect(retry.calls).toEqual(["revoke"]);
});
test("a successful receipt with nonzero approval is not reported as revoked", async () => {
  await expect(cleanupAllowance(fixture({ stuck: true }).io)).rejects.toThrow(
    "not confirmed revoked",
  );
});
test("an already disarmed position with zero allowance needs no transaction", async () => {
  const f = fixture({ armed: false, allowance: 0n });
  expect((await cleanupAllowance(f.io)).revoked).toBe(true);
  expect(f.calls).toEqual([]);
});
test("cleanup calldata is exactly disarm(position) and approve(router,0)", () => {
  const d = decodeFunctionData({
    abi: parseAbi(["function disarm(bytes32)"]),
    data: disarmTx(A, H).data,
  });
  expect(d.args).toEqual([H]);
  const r = revokeTx(A, A);
  expect(r.to).toBe(A);
  expect(
    decodeFunctionData({
      abi: parseAbi(["function approve(address,uint256)"]),
      data: r.data,
    }).args,
  ).toEqual([A, 0n]);
});
