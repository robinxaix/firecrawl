import { shouldSkipCache } from "../should-skip";
import { Meta } from "../../..";

const meta = (overrides: Record<string, unknown> = {}): Meta =>
  ({
    url: "https://example.com/page",
    options: { maxAge: 3600000, headers: undefined, ...overrides },
  }) as unknown as Meta;

describe("shouldSkipCache", () => {
  it("does NOT skip a clean request", () => {
    expect(shouldSkipCache(meta()).skip).toBe(false);
  });

  it("skips when maxAge=0", () => {
    const r = shouldSkipCache(meta({ maxAge: 0 }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("maxAge=0");
  });

  it("does NOT skip when maxAge is undefined (engine handles separately)", () => {
    expect(shouldSkipCache(meta({ maxAge: undefined })).skip).toBe(false);
  });

  it("skips when Authorization header present", () => {
    const r = shouldSkipCache(
      meta({ headers: { Authorization: "Bearer xxx" } }),
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("auth-headers");
  });

  it("skips when Cookie header present (case-insensitive)", () => {
    const r = shouldSkipCache(meta({ headers: { COOKIE: "session=abc" } }));
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("auth-headers");
  });

  it("does NOT skip on benign custom headers", () => {
    const r = shouldSkipCache(meta({ headers: { "X-Custom": "ok" } }));
    expect(r.skip).toBe(false);
  });

  it("skips when URL has token query param", () => {
    const r = shouldSkipCache({
      url: "https://example.com/x?token=abc",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("sensitive-param:token");
  });

  it("skips when URL has signature query param (case-insensitive)", () => {
    const r = shouldSkipCache({
      url: "https://example.com/x?Signature=abc",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("sensitive-param:Signature");
  });

  it("does NOT skip on benign query params", () => {
    const r = shouldSkipCache({
      url: "https://example.com/search?q=hello&page=2",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(false);
  });

  it("skips on invalid URL (defensive)", () => {
    const r = shouldSkipCache({
      url: "not a url",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("invalid-url");
  });

  it("uses rewrittenUrl when present", () => {
    const r = shouldSkipCache({
      url: "https://example.com/x",
      rewrittenUrl: "https://example.com/x?apikey=secret",
      options: { maxAge: 3600000 },
    } as unknown as Meta);
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("sensitive-param:apikey");
  });
});
