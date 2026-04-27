import { computeCacheKey, normalizeUrl } from "../key";
import { Meta } from "../../..";

const baseMeta = (overrides: Record<string, unknown> = {}): Meta =>
  ({
    url: "https://example.com/page",
    options: {
      formats: ["markdown"],
      onlyMainContent: false,
      mobile: false,
      skipTlsVerification: false,
      ...overrides,
    },
  }) as unknown as Meta;

describe("normalizeUrl", () => {
  it("lowercases scheme and host but preserves path case", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Foo")).toBe(
      "https://example.com/Foo",
    );
  });

  it("strips fragment", () => {
    expect(normalizeUrl("https://example.com/x#section")).toBe(
      "https://example.com/x",
    );
  });

  it("preserves query string", () => {
    expect(normalizeUrl("https://example.com/?q=hi&a=1")).toBe(
      "https://example.com/?q=hi&a=1",
    );
  });

  it("strips default ports", () => {
    expect(normalizeUrl("https://example.com:443/x")).toBe(
      "https://example.com/x",
    );
    expect(normalizeUrl("http://example.com:80/x")).toBe(
      "http://example.com/x",
    );
  });

  it("preserves non-default ports", () => {
    expect(normalizeUrl("https://example.com:8443/x")).toBe(
      "https://example.com:8443/x",
    );
  });

  it("returns input verbatim when unparseable", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("computeCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeCacheKey(baseMeta());
    const b = computeCacheKey(baseMeta());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores fragment differences", () => {
    const a = computeCacheKey(baseMeta());
    const meta2 = {
      ...baseMeta({}),
      url: "https://example.com/page#frag",
    } as unknown as Meta;
    expect(a).toBe(computeCacheKey(meta2));
  });

  it("ignores host case differences", () => {
    const a = computeCacheKey(baseMeta());
    const meta2 = {
      ...baseMeta({}),
      url: "https://Example.COM/page",
    } as unknown as Meta;
    expect(a).toBe(computeCacheKey(meta2));
  });

  it("ignores format ordering", () => {
    const a = computeCacheKey(baseMeta({ formats: ["markdown", "html"] }));
    const b = computeCacheKey(baseMeta({ formats: ["html", "markdown"] }));
    expect(a).toBe(b);
  });

  it("differs when format set differs", () => {
    const a = computeCacheKey(baseMeta({ formats: ["markdown"] }));
    const b = computeCacheKey(baseMeta({ formats: ["html"] }));
    expect(a).not.toBe(b);
  });

  it("differs when URL path differs", () => {
    const a = computeCacheKey(baseMeta());
    const meta2 = {
      ...baseMeta({}),
      url: "https://example.com/other",
    } as unknown as Meta;
    expect(a).not.toBe(computeCacheKey(meta2));
  });

  it("differs when onlyMainContent differs", () => {
    const a = computeCacheKey(baseMeta({ onlyMainContent: true }));
    const b = computeCacheKey(baseMeta({ onlyMainContent: false }));
    expect(a).not.toBe(b);
  });

  it("ignores maxAge differences (maxAge is hit-decision, not key)", () => {
    const a = computeCacheKey(baseMeta({ maxAge: 1000 }));
    const b = computeCacheKey(baseMeta({ maxAge: 9999 }));
    expect(a).toBe(b);
  });

  it("uses rewrittenUrl when present", () => {
    const meta1 = baseMeta();
    const meta2 = {
      ...baseMeta({}),
      url: "https://different.com/x",
      rewrittenUrl: "https://example.com/page",
    } as unknown as Meta;
    expect(computeCacheKey(meta1)).toBe(computeCacheKey(meta2));
  });

  it("supports format objects with .type", () => {
    const a = computeCacheKey(baseMeta({ formats: ["screenshot"] }));
    const b = computeCacheKey(
      baseMeta({ formats: [{ type: "screenshot", fullPage: true }] }),
    );
    expect(a).toBe(b);
  });

  it("ignores includeTags ordering", () => {
    const a = computeCacheKey(baseMeta({ includeTags: ["a", "b"] }));
    const b = computeCacheKey(baseMeta({ includeTags: ["b", "a"] }));
    expect(a).toBe(b);
  });
});
