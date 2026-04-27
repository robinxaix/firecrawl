/**
 * @zapfetch/cache types — Postgres metadata + Aliyun OSS content storage.
 *
 * Refs: docs/response-cache-plan.md (ZF-2)
 */

export type CacheEntry = {
  cacheKey: string;
  normalizedUrl: string;
  domain: string;
  ossPath: string;
  statusCode: number;
  contentType?: string;
  sizeBytes: number;
  formats: string[];
  cachedAt: Date;
  expiresAt: Date;
};

/**
 * Storage adapter for the response cache.
 *
 * Splits metadata (Postgres) from content (object storage).
 * Implementations: PostgresMetadataStore + OssContentStore.
 */
export interface CacheMetadataStore {
  /**
   * Look up a cache entry by key. Does NOT check expiry — caller compares
   * cached_at against maxAge. Returns null if no row exists.
   */
  lookup(cacheKey: string): Promise<CacheEntry | null>;

  /**
   * Insert or update a cache entry's metadata. expires_at is taken as max(seen)
   * so a 24h client doesn't shorten an entry written for lockdown 2y.
   */
  saveMetadata(entry: CacheEntry): Promise<void>;

  /**
   * Fire-and-forget. Bumps hit_count + last_hit_at. Failure is non-fatal.
   */
  bumpHit(cacheKey: string): Promise<void>;

  /**
   * Bulk delete rows whose expires_at < now(). Used by daily cleaner cron
   * (Task C.7). Returns the OSS paths that were deleted so the caller can
   * sweep OSS too.
   */
  deleteExpired(limit: number): Promise<string[]>;

  /**
   * Counter for monitoring (zapfetch_cache_pg_rows_total).
   */
  countRows(): Promise<number>;
}

export interface CacheContentStore {
  /**
   * Upload gzipped content. Caller pre-computes oss_path.
   */
  put(ossPath: string, content: Buffer): Promise<void>;

  /**
   * Fetch + gunzip. Returns raw content bytes.
   */
  get(ossPath: string): Promise<Buffer | null>;

  /**
   * Delete an object. Used by daily cleaner. No-op if missing.
   */
  delete(ossPath: string): Promise<void>;

  /**
   * Bulk delete (efficiency for daily cleaner).
   */
  deleteMany(ossPaths: string[]): Promise<void>;
}

/**
 * Errors thrown by the storage layer. Engine layer catches these and returns
 * cache-miss to the fallback engine list — never user-visible.
 */
export class CacheStorageError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CacheStorageError";
  }
}
