import { describe, expect, test } from "bun:test";
import { REGION_NOTICE } from "../src/copy/text";
import { isStockToken, regionNoticesFor, STOCK_TOKEN_ASSETS } from "../src/region";
import { CHAINS } from "../src/config";
import { findBanned } from "../../tools/banned-words";

describe("region notices", () => {
  test("a vault shows the Stock Token notice only when its asset is on the list", () => {
    expect(regionNoticesFor({ asset: "TSLA" }, ["tsla"])).toEqual(["stock"]);
    expect(regionNoticesFor({ asset: "USDG" }, ["tsla"])).toEqual([]);
    expect(isStockToken({ asset: "0xAbC" }, ["0xabc"])).toBe(true);
  });
  test("no launch vault is a Stock Token today, so no notice shows", () => {
    for (const c of CHAINS) for (const v of c.vaults) expect(regionNoticesFor(v, STOCK_TOKEN_ASSETS)).toEqual([]);
  });
  test("the wording names the regions and passes the banned-word gate", () => {
    for (const r of ["US", "Canada", "UK", "Switzerland"]) expect(REGION_NOTICE.stock).toContain(r);
    for (const r of ["US", "UK", "Canada", "Switzerland", "UAE", "Singapore"]) expect(REGION_NOTICE.perps).toContain(r);
    for (const t of Object.values(REGION_NOTICE)) expect(findBanned(t)).toEqual([]);
  });
});
