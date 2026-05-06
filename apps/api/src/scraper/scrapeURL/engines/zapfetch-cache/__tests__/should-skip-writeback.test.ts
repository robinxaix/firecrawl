import { shouldSkipWriteback } from "../should-skip-writeback";
import { Meta } from "../../..";

const meta = (overrides: Record<string, unknown> = {}): Meta =>
  ({
    url: "https://example.com/page",
    options: { maxAge: 3600000, headers: undefined, ...overrides },
  }) as unknown as Meta;

describe("shouldSkipWriteback", () => {
  it("does NOT skip a clean request", () => {
    expect(shouldSkipWriteback(meta()).skip).toBe(false);
  });

  it("does NOT skip when maxAge=0 (read-side carve-out)", () => {
    // maxAge=0 forces a fresh fetch for THIS request, but writeback for
    // future readers stays open. ZF-2 codex challenge round 2.
    expect(shouldSkipWriteback(meta({ maxAge: 0 })).skip).toBe(false);
  });

  it("skips when Authorization header present (auth-headers from read side)", () => {
    const r = shouldSkipWriteback(
      meta({ headers: { Authorization: "Bearer x" } }),
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("auth-headers");
  });

  it("skips when profile is set (read-side leak prevention)", () => {
    const r = shouldSkipWriteback(meta({ profile: { name: "p1" } }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("profile");
  });

  it("skips when storeInCache=false (caller opt-out)", () => {
    const r = shouldSkipWriteback(meta({ storeInCache: false }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("storeInCache=false");
  });

  it("does NOT skip when storeInCache=true (default)", () => {
    expect(shouldSkipWriteback(meta({ storeInCache: true })).skip).toBe(false);
  });

  it("skips when actions array is non-empty", () => {
    const r = shouldSkipWriteback(
      meta({ actions: [{ type: "click", selector: "#btn" }] }),
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("actions");
  });

  it("does NOT skip when actions is empty array", () => {
    expect(shouldSkipWriteback(meta({ actions: [] })).skip).toBe(false);
  });

  it("does NOT skip when actions is undefined", () => {
    expect(shouldSkipWriteback(meta({ actions: undefined })).skip).toBe(false);
  });

  it("skips when location.country is set (geo-pinned scrape)", () => {
    const r = shouldSkipWriteback(meta({ location: { country: "JP" } }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("location");
  });

  it("skips when location.languages is non-empty", () => {
    const r = shouldSkipWriteback(meta({ location: { languages: ["fr"] } }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("location");
  });

  it("does NOT skip when location is empty object", () => {
    // Schema allows {} — neither country nor languages set.
    expect(shouldSkipWriteback(meta({ location: {} })).skip).toBe(false);
  });

  it("does NOT skip when location.languages is empty array", () => {
    expect(
      shouldSkipWriteback(meta({ location: { languages: [] } })).skip,
    ).toBe(false);
  });

  it("read-side skip with non-maxAge=0 reason wins (sensitive query param)", () => {
    const r = shouldSkipWriteback({
      url: "https://example.com/x?token=abc",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("sensitive-param:token");
  });
});
