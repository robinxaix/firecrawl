import {
  makeScrapeURLWithZapfetchCache,
  makeSendDocumentToZapfetchCache,
} from "../index";
import { computeCacheKey } from "../key";
import {
  CacheContentStore,
  CacheEntry,
  CacheMetadataStore,
} from "../../../../../zapfetch/cache";
import { IndexMissError } from "../../../error";
import { Meta } from "../../..";
import type { Document } from "../../../../../controllers/v1/types";

type DocumentOverride = Partial<Omit<Document, "metadata">> & {
  metadata?: Partial<Document["metadata"]>;
};

const meta = (overrides: Record<string, unknown> = {}): Meta =>
  ({
    url: "https://example.com/page",
    options: {
      formats: ["markdown"],
      maxAge: 3_600_000,
      onlyMainContent: false,
      mobile: false,
      skipTlsVerification: false,
      ...overrides,
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    },
  }) as unknown as Meta;

const fixtureEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  cacheKey: "k1",
  normalizedUrl: "https://example.com/page",
  domain: "example.com",
  ossPath: "docs/2026/04/27/k1.json.gz",
  statusCode: 200,
  contentType: "text/html",
  sizeBytes: 1024,
  formats: ["markdown"],
  cachedAt: new Date("2026-04-27T00:00:00Z"),
  expiresAt: new Date("2026-04-28T00:00:00Z"),
  ...overrides,
});

const makeStores = () => {
  const metadata: CacheMetadataStore = {
    lookup: jest.fn(),
    saveMetadata: jest.fn(),
    bumpHit: jest.fn().mockResolvedValue(undefined),
    deleteExpired: jest.fn(),
    countRows: jest.fn(),
  };
  const content: CacheContentStore = {
    put: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  return {
    metadata,
    content,
    metadataLookup: metadata.lookup as jest.Mock,
    metadataBumpHit: metadata.bumpHit as jest.Mock,
    contentGet: content.get as jest.Mock,
  };
};

describe("scrapeURLWithZapfetchCache", () => {
  const fixedNow = () => new Date("2026-04-27T01:00:00Z");

  it("throws IndexMissError when shouldSkipCache says skip", async () => {
    const stores = makeStores();
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta({ maxAge: 0 }))).rejects.toBeInstanceOf(
      IndexMissError,
    );
    expect(stores.metadataLookup).not.toHaveBeenCalled();
  });

  it("falls back to default maxAge when caller omits it", async () => {
    // ZF-2 behavior: if maxAge is undefined, the engine applies the default
    // (configured via ZAPFETCH_CACHE_DEFAULT_MAX_AGE_MS, fallback 24h) so the
    // request still goes to lookup. miss still propagates as IndexMissError.
    const stores = makeStores();
    stores.metadataLookup.mockResolvedValueOnce(null);
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta({ maxAge: undefined }))).rejects.toBeInstanceOf(
      IndexMissError,
    );
    expect(stores.metadataLookup).toHaveBeenCalled();
  });

  it("throws IndexMissError when metadata lookup returns null", async () => {
    const stores = makeStores();
    stores.metadataLookup.mockResolvedValueOnce(null);
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta())).rejects.toBeInstanceOf(IndexMissError);
  });

  it("throws IndexMissError when metadata lookup throws (graceful degrade)", async () => {
    const stores = makeStores();
    stores.metadataLookup.mockRejectedValueOnce(new Error("PG down"));
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta())).rejects.toBeInstanceOf(IndexMissError);
  });

  it("throws IndexMissError when entry is older than maxAge", async () => {
    const stores = makeStores();
    // entry cached 2 hours ago; maxAge is 1 hour
    stores.metadataLookup.mockResolvedValueOnce(
      fixtureEntry({ cachedAt: new Date("2026-04-27T00:00:00Z") }),
    );
    const engine = makeScrapeURLWithZapfetchCache({
      ...stores,
      now: () => new Date("2026-04-27T02:00:00Z"),
    });

    await expect(
      engine(meta({ maxAge: 60 * 60 * 1000 })),
    ).rejects.toBeInstanceOf(IndexMissError);
    expect(stores.contentGet).not.toHaveBeenCalled();
  });

  it("throws IndexMissError when content fetch returns null (orphan metadata)", async () => {
    const stores = makeStores();
    stores.metadataLookup.mockResolvedValueOnce(fixtureEntry());
    stores.contentGet.mockResolvedValueOnce(null);
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta())).rejects.toBeInstanceOf(IndexMissError);
  });

  it("throws IndexMissError when content fetch throws", async () => {
    const stores = makeStores();
    stores.metadataLookup.mockResolvedValueOnce(fixtureEntry());
    stores.contentGet.mockRejectedValueOnce(new Error("OSS 5xx"));
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta())).rejects.toBeInstanceOf(IndexMissError);
  });

  it("returns hit with correct fields when fresh", async () => {
    const stores = makeStores();
    const entry = fixtureEntry();
    stores.metadataLookup.mockResolvedValueOnce(entry);
    stores.contentGet.mockResolvedValueOnce(Buffer.from("<html>cached</html>"));

    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    const result = await engine(meta());

    expect(result.html).toBe("<html>cached</html>");
    expect(result.statusCode).toBe(200);
    expect(result.url).toBe(entry.normalizedUrl);
    expect(result.proxyUsed).toBe("basic");
    expect(result.cacheInfo?.created_at).toEqual(entry.cachedAt);
  });

  it("fires bumpHit on hit but does not block on its rejection", async () => {
    const stores = makeStores();
    stores.metadataLookup.mockResolvedValueOnce(fixtureEntry());
    stores.contentGet.mockResolvedValueOnce(Buffer.from("ok"));
    stores.metadataBumpHit.mockRejectedValueOnce(new Error("connection lost"));

    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });
    const m = meta();

    await expect(engine(m)).resolves.toMatchObject({ html: "ok" });
    // Engine computes its own cacheKey from the request and bumps that one,
    // not the fixture's cacheKey field — so we recompute here for the assert.
    expect(stores.metadataBumpHit).toHaveBeenCalledWith(computeCacheKey(m));
  });
});

describe("sendDocumentToZapfetchCache (writeback)", () => {
  const fixedNow = () => new Date("2026-04-27T01:23:45Z");

  // Build a Meta that mirrors the production shape relevant to writeback.
  // Only writeback-touched fields matter — defaults match a happy-path scrape.
  const writebackMeta = (overrides: Record<string, unknown> = {}): Meta =>
    ({
      url: "https://example.com/page",
      rewrittenUrl: undefined,
      winnerEngine: "playwright",
      options: {
        formats: ["markdown"],
        maxAge: undefined,
        onlyMainContent: false,
        mobile: false,
        skipTlsVerification: false,
        lockdown: false,
        ...((overrides.options as Record<string, unknown>) ?? {}),
      },
      internalOptions: {
        zeroDataRetention: false,
        ...((overrides.internalOptions as Record<string, unknown>) ?? {}),
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      },
      ...overrides,
    }) as unknown as Meta;

  const goodDocument = (overrides: DocumentOverride = {}): Document =>
    ({
      html: "<html>fresh content</html>",
      rawHtml: undefined,
      ...overrides,
      metadata: {
        statusCode: 200,
        contentType: "text/html",
        proxyUsed: "basic",
        ...(overrides.metadata ?? {}),
      },
    }) as unknown as Document;

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  // Helper that runs the writeback and yields the captured fire-and-forget
  // promise (resolved by then) so assertions can run after PG+OSS calls land.
  const runWriteback = async (
    deps: ReturnType<typeof makeStores>,
    meta: Meta,
    document: Document,
    opts: { writebackTtlMs?: number } = {},
  ): Promise<{ wrote: boolean }> => {
    let captured: Promise<void> | null = null;
    const handler = makeSendDocumentToZapfetchCache({
      metadata: deps.metadata,
      content: deps.content,
      now: fixedNow,
      writebackTtlMs: opts.writebackTtlMs,
      onWrite: p => {
        captured = p;
      },
    });
    await handler(meta, document);
    if (captured) {
      await captured;
      return { wrote: true };
    }
    return { wrote: false };
  };

  it("writes even when caller omits maxAge (default 24h applies)", async () => {
    // Win condition: this is the regression that PR fixes. Previously a
    // ConfigMap-injected default of 0 short-circuited writeback; now writeback
    // uses an independent TTL so the cache always populates regardless of
    // lookup defaults.
    const stores = makeStores();
    await runWriteback(stores, writebackMeta(), goodDocument());

    expect(stores.content.put).toHaveBeenCalledTimes(1);
    expect(stores.metadata.saveMetadata).toHaveBeenCalledTimes(1);
    const saved = (stores.metadata.saveMetadata as jest.Mock).mock.calls[0][0];
    expect(saved).toMatchObject({
      domain: "example.com",
      statusCode: 200,
      contentType: "text/html",
      formats: ["markdown"],
      cachedAt: fixedNow(),
      expiresAt: new Date(fixedNow().getTime() + TWENTY_FOUR_HOURS_MS),
    });
    // OSS path is keyed by the engine's computeCacheKey — assert shape only.
    expect(saved.ossPath).toMatch(
      /^docs\/2026\/04\/27\/[a-f0-9]{64}\.html\.gz$/,
    );
  });

  it("respects user-supplied maxAge=0 by skipping (shouldSkipCache contract)", async () => {
    // shouldSkipCache returns skip:true for explicit maxAge=0; writeback no
    // longer has its own gate, so this is the single source of opt-out.
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta({ options: { maxAge: 0, formats: ["markdown"] } }),
      goodDocument(),
    );
    expect(result.wrote).toBe(false);
    expect(stores.content.put).not.toHaveBeenCalled();
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("does not write when winnerEngine is the cache itself", async () => {
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta({ winnerEngine: "zapfetch-cache" }),
      goodDocument(),
    );
    expect(result.wrote).toBe(false);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("does not write on non-2xx status", async () => {
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta(),
      goodDocument({ metadata: { statusCode: 500, contentType: "text/html" } }),
    );
    expect(result.wrote).toBe(false);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("does not write on empty html", async () => {
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta(),
      goodDocument({ html: "", rawHtml: "" }),
    );
    expect(result.wrote).toBe(false);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("does not write when zeroDataRetention is set", async () => {
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta({ internalOptions: { zeroDataRetention: true } }),
      goodDocument(),
    );
    expect(result.wrote).toBe(false);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("does not write when lockdown is true", async () => {
    const stores = makeStores();
    const result = await runWriteback(
      stores,
      writebackMeta({ options: { lockdown: true, formats: ["markdown"] } }),
      goodDocument(),
    );
    expect(result.wrote).toBe(false);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });

  it("expires_at uses writebackTtlMs override regardless of caller maxAge", async () => {
    // Decoupling: writeback TTL is independent of lookup maxAge. A user
    // requesting maxAge=1h still gets a 24h-stored row; lookup-side staleness
    // is enforced separately by maxAge.
    const stores = makeStores();
    const overrideTtl = 6 * 60 * 60 * 1000; // 6h
    await runWriteback(
      stores,
      writebackMeta({
        options: { maxAge: 60 * 60 * 1000, formats: ["markdown"] }, // 1h
      }),
      goodDocument(),
      { writebackTtlMs: overrideTtl },
    );
    const saved = (stores.metadata.saveMetadata as jest.Mock).mock.calls[0][0];
    expect(saved.expiresAt).toEqual(
      new Date(fixedNow().getTime() + overrideTtl),
    );
  });

  it("swallows storage errors (writeback is never fatal)", async () => {
    const stores = makeStores();
    (stores.content.put as jest.Mock).mockRejectedValueOnce(
      new Error("OSS 5xx"),
    );
    // No throw expected — the wrapped promise catches and logs.
    const result = await runWriteback(stores, writebackMeta(), goodDocument());
    expect(result.wrote).toBe(true);
    expect(stores.metadata.saveMetadata).not.toHaveBeenCalled();
  });
});
