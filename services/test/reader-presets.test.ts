import { test, expect } from "bun:test";
import { readerPresets, orderedDetectors } from "../src/api/readerPresets";
import { Kind } from "../src/api/presets";
const pool = "0x0000000000000000000000000000000000000001",
  reader = "0x0000000000000000000000000000000000000002";
test("reserve alarms cannot be offered without their independent quorum", () => {
  const [p] = readerPresets(pool, [
    {
      pool,
      reader,
      kind: "reserve",
      threshold: "7501",
      heartbeat: 60,
      reviewUrl: "https://example.com/review",
    },
  ]);
  expect(p!.detector.kind).toBe(Kind.BOTH);
  expect(orderedDetectors([p!]).map((d) => d.kind)).toEqual([
    Kind.PRICE_BELOW,
    Kind.QUORUM,
    Kind.BOTH,
  ]);
  expect(readerPresets(pool, [])).toEqual([]);
  expect(() =>
    readerPresets(pool, [
      {
        pool,
        reader,
        kind: "price",
        threshold: "0",
        heartbeat: 60,
        reviewUrl: "https://example.com/review",
      },
    ]),
  ).toThrow();
});
import { reserveSignal } from "../src/detectors/lp";
test("LP reserve changes need history and two separated low observations, and stay soft", () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({
    at: 1000 + i * 60,
    reserve0: 1000n,
    reserve1: 1000n,
  }));
  expect(reserveSignal(pool, rows, 3040)).toBeNull();
  const single = [...rows, { at: 3100, reserve0: 100n, reserve1: 1000n }];
  expect(reserveSignal(pool, single, 3100)).toBeNull();
  const twice = [...single, { at: 3160, reserve0: 100n, reserve1: 1000n }];
  expect(reserveSignal(pool, twice, 3160)?.severity).toBe("soft");
  expect(reserveSignal(pool, twice, 4000)).toBeNull();
});
