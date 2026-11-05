import { expect, test } from "bun:test";
import type { Log } from "viem";
import { alarmName, decodeExits, formatAmount, formatDelay, parseFragment, receiptLink } from "../src/receipt";
import { CONFIG, type Chain } from "../src/config";

// The router's own logs from a real exit on Robinhood Chain (4663): block 106382397, 2 seconds after the alarm fired.
// Transaction 0x7aa786941a8fa88ee8937cdff9ce93a273025c1bd6dd7b80cc2d3758c9c8598f
const ROUTER = CONFIG.router!;
const real = (logIndex: number, topics: string[], data: string, address = ROUTER) =>
  ({ address, topics, data, logIndex, blockNumber: 106382397n, transactionHash: "0x7aa786941a8fa88ee8937cdff9ce93a273025c1bd6dd7b80cc2d3758c9c8598f" }) as unknown as Log;
const PAID = real(78,
  ["0x0e517cc89be95e3eb86597ec0a346cda195b4e6a29996c2a5fae1dd0403a53b4", "0x0000000000000000000000000000000000000000000000000000000000000001", "0x000000000000000000000000abababababababababababababababababababab"],
  "0x0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d16800000000000000000000000000000000000000000000000000000000009896800000000000000000000000000000000000000000000000000000000000000000");
const EXITED = real(79,
  ["0x062c3357b1434c13cd4b37bc4a03285412d4e0d5a787f1209dd75a92f7cefa2f", "0x0000000000000000000000000000000000000000000000000000000000000001", "0x4764dc279be33376be22069125aa4411839f21af1676de17f98270af6880c19a", "0x000000000000000000000000abababababababababababababababababababab"],
  "0x000000000000000000000000ca11bde05977b3631167028862be2a173976ca1179f6490339aabff151385ed17d342c8e34ca12919ca7bcfc606063fac6519d660000000000000000000000000000000000000000000000000000000000000001");
// An ERC-20 Transfer from the same transaction. It is not the router's and must be ignored.
const TRANSFER = real(77, ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "00".repeat(32), "0x" + "00".repeat(32)], "0x" + "00".repeat(32), "0x5fc5360d0400a0fd4f2af552add042d716f1d168");

test("decodes the real exit: alarm, position and what was paid", () => {
  const [one, ...rest] = decodeExits([TRANSFER, PAID, EXITED], ROUTER);
  expect(rest).toEqual([]);
  expect(one!.exit.exitId).toBe(1n);
  expect(one!.exit.posId).toBe("0x4764dc279be33376be22069125aa4411839f21af1676de17f98270af6880c19a");
  expect(one!.exit.alarmKey).toBe("0x79f6490339aabff151385ed17d342c8e34ca12919ca7bcfc606063fac6519d66");
  expect(one!.exit.viaAlarm).toBe(true);
  expect(one!.payouts.map((p) => ({ ...p, token: p.token.toLowerCase() }))).toEqual([{ token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", amount: 10_000_000n, swapped: false, held: false }]);
});

test("a transaction with no Exited log from the router is not an exit", () => {
  expect(decodeExits([TRANSFER], ROUTER)).toEqual([]);
  expect(decodeExits([], ROUTER)).toEqual([]);
  // The same logs from some other contract do not count.
  expect(decodeExits([PAID, EXITED].map((l) => ({ ...l, address: "0x00000000000000000000000000000000000000a1" }) as Log), ROUTER)).toEqual([]);
});

test("the fragment must be a 32-byte transaction hash", () => {
  const h = "0x7aa786941a8fa88ee8937cdff9ce93a273025c1bd6dd7b80cc2d3758c9c8598f";
  expect(parseFragment("")).toEqual({ kind: "none" });
  expect(parseFragment("#")).toEqual({ kind: "none" });
  expect(parseFragment("#" + h)).toEqual({ kind: "ok", hash: h, chain: CONFIG });
  expect(parseFragment("#" + h.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "ok", hash: h, chain: CONFIG });
  expect(parseFragment("#0x1234").kind).toBe("bad");
  expect(parseFragment("#" + h + "00").kind).toBe("bad");
  expect(parseFragment("#nothex").kind).toBe("bad");
});

test("alarm names are plain, and unknown alarms fall back to their kind", () => {
  const key = "0x79f6490339aabff151385ed17d342c8e34ca12919ca7bcfc606063fac6519d66";
  expect(alarmName(key, 0, "0xBeEff033F34C046626B8D0A041844C5d1A5409dd")).toBe("Price fell below a set level");
  expect(alarmName(key, null, null)).toBe("Custom alarm");
  expect(alarmName(key, 99, null)).toBe("Custom alarm");
});

test("delays and amounts read naturally", () => {
  expect(formatDelay(2)).toBe("2 seconds");
  expect(formatDelay(1)).toBe("1 second");
  expect(formatDelay(0)).toBe("the same second");
  expect(formatDelay(90)).toBe("2 minutes");
  expect(formatDelay(3900)).toBe("1 hour 5 minutes");
  expect(formatAmount(10_000_000n, 6)).toBe("10.00");
  expect(formatAmount(1_234_567_890n, 6)).toBe("1,234.56789");
  expect(formatAmount(1n, 18)).toBe("< 0.00000001");
  expect(formatAmount(0n, 6)).toBe("0.00");
});

test("a receipt link names a network other than the first, and an unknown network is refused", () => {
  const h = "0x7aa786941a8fa88ee8937cdff9ce93a273025c1bd6dd7b80cc2d3758c9c8598f";
  const first = { key: "robinhood" } as Chain, second = { key: "base" } as Chain, list = [first, second];
  expect(receiptLink(first, h, list)).toBe("receipt.html#" + h);
  expect(receiptLink(second, h, list)).toBe("receipt.html#base:" + h);
  expect(parseFragment("#base:" + h, list)).toEqual({ kind: "ok", hash: h, chain: second });
  expect(parseFragment("#BASE:" + h, list)).toEqual({ kind: "ok", hash: h, chain: second });
  expect(parseFragment("#" + h, list)).toEqual({ kind: "ok", hash: h, chain: first });
  expect(parseFragment("#solana:" + h, list).kind).toBe("bad");
  expect(parseFragment("#base:0x1234", list).kind).toBe("bad");
  expect(parseFragment("#base:", list).kind).toBe("bad");
});
