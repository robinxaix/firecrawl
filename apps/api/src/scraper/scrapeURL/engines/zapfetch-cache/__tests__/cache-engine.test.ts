import { makeScrapeURLWithZapfetchCache } from "../index";
import { computeCacheKey } from "../key";
import {
  CacheContentStore,
  CacheEntry,
  CacheMetadataStore,
} from "../../../../../zapfetch/cache";
import { IndexMissError } from "../../../error";
import { Meta } from "../../..";

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

  it("throws IndexMissError when maxAge is undefined", async () => {
    const stores = makeStores();
    const engine = makeScrapeURLWithZapfetchCache({ ...stores, now: fixedNow });

    await expect(engine(meta({ maxAge: undefined }))).rejects.toBeInstanceOf(
      IndexMissError,
    );
    expect(stores.metadataLookup).not.toHaveBeenCalled();
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
