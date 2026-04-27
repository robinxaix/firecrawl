import { PostgresMetadataStore } from "../storage-pg";
import { CacheEntry, CacheStorageError } from "../types";

const makePool = () => {
  const release = jest.fn();
  const clientQuery: jest.Mock = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query: clientQuery, release });
  const poolQuery: jest.Mock = jest.fn();
  return {
    pool: { query: poolQuery, connect } as never,
    poolQuery,
    clientQuery,
    release,
    connect,
  };
};

const fixtureRow = {
  cache_key: "k1",
  normalized_url: "https://example.com/",
  domain: "example.com",
  oss_path: "docs/2026/04/27/k1.json.gz",
  status_code: 200,
  content_type: "text/html",
  size_bytes: 1024,
  formats: ["markdown"],
  cached_at: new Date("2026-04-27T00:00:00Z"),
  expires_at: new Date("2026-04-28T00:00:00Z"),
};

const fixtureEntry: CacheEntry = {
  cacheKey: "k1",
  normalizedUrl: "https://example.com/",
  domain: "example.com",
  ossPath: "docs/2026/04/27/k1.json.gz",
  statusCode: 200,
  contentType: "text/html",
  sizeBytes: 1024,
  formats: ["markdown"],
  cachedAt: new Date("2026-04-27T00:00:00Z"),
  expiresAt: new Date("2026-04-28T00:00:00Z"),
};

describe("PostgresMetadataStore.lookup", () => {
  it("returns entry on hit", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockResolvedValueOnce({ rows: [fixtureRow] });
    const store = new PostgresMetadataStore(pool);

    const got = await store.lookup("k1");
    expect(got).toEqual(fixtureEntry);
    expect(poolQuery.mock.calls[0][1]).toEqual(["k1"]);
  });

  it("returns null on miss", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const store = new PostgresMetadataStore(pool);

    expect(await store.lookup("missing")).toBeNull();
  });

  it("wraps errors as CacheStorageError", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockRejectedValueOnce(new Error("connection refused"));
    const store = new PostgresMetadataStore(pool);

    await expect(store.lookup("k1")).rejects.toBeInstanceOf(CacheStorageError);
  });
});

describe("PostgresMetadataStore.saveMetadata", () => {
  it("runs insert in a transaction", async () => {
    const { pool, clientQuery, release } = makePool();
    clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresMetadataStore(pool);

    await store.saveMetadata(fixtureEntry);

    const calls = clientQuery.mock.calls.map(c => c[0] as string);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toMatch(/INSERT INTO scrape_cache/);
    expect(calls[2]).toBe("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("rolls back on error and releases client", async () => {
    const { pool, clientQuery, release } = makePool();
    clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error("unique violation")) // INSERT
      .mockResolvedValueOnce({}); // ROLLBACK
    const store = new PostgresMetadataStore(pool);

    await expect(store.saveMetadata(fixtureEntry)).rejects.toBeInstanceOf(
      CacheStorageError,
    );
    const calls = clientQuery.mock.calls.map(c => c[0] as string);
    expect(calls).toContain("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });
});

describe("PostgresMetadataStore.bumpHit", () => {
  it("issues UPDATE bumping hit_count", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const store = new PostgresMetadataStore(pool);

    await store.bumpHit("k1");
    expect(poolQuery.mock.calls[0][0]).toMatch(/UPDATE scrape_cache/);
    expect(poolQuery.mock.calls[0][1]).toEqual(["k1"]);
  });

  it("swallows errors (non-fatal)", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockRejectedValueOnce(new Error("timeout"));
    const store = new PostgresMetadataStore(pool);

    // Must not throw.
    await expect(store.bumpHit("k1")).resolves.toBeUndefined();
  });
});

describe("PostgresMetadataStore.deleteExpired", () => {
  it("returns oss_paths of deleted rows", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockResolvedValueOnce({
      rows: [{ oss_path: "docs/a.gz" }, { oss_path: "docs/b.gz" }],
    });
    const store = new PostgresMetadataStore(pool);

    expect(await store.deleteExpired(100)).toEqual(["docs/a.gz", "docs/b.gz"]);
    expect(poolQuery.mock.calls[0][1]).toEqual([100]);
  });
});

describe("PostgresMetadataStore.countRows", () => {
  it("coerces bigint to number", async () => {
    const { pool, poolQuery } = makePool();
    poolQuery.mockResolvedValueOnce({ rows: [{ n: "42" }] });
    const store = new PostgresMetadataStore(pool);

    expect(await store.countRows()).toBe(42);
  });
});
