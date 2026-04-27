import { Pool, PoolClient } from "pg";
import { CacheEntry, CacheMetadataStore, CacheStorageError } from "./types";

/**
 * Postgres-backed metadata store for response cache.
 *
 * All queries use prepared statements (no string concat). Failures are
 * wrapped in CacheStorageError so the engine layer can downgrade to
 * cache-miss without leaking PG errors to users.
 */
export class PostgresMetadataStore implements CacheMetadataStore {
  constructor(private readonly pool: Pool) {}

  async lookup(cacheKey: string): Promise<CacheEntry | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT cache_key, normalized_url, domain, oss_path, status_code,
                content_type, size_bytes, formats, cached_at, expires_at
           FROM scrape_cache
          WHERE cache_key = $1`,
        [cacheKey],
      );
      if (rows.length === 0) return null;
      return rowToEntry(rows[0]);
    } catch (err) {
      throw new CacheStorageError(`scrape_cache lookup failed`, err);
    }
  }

  async saveMetadata(entry: CacheEntry): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // ON CONFLICT: take the LATER expires_at (don't shrink durability)
      // and refresh metadata in case scrape produced different size/etc.
      await client.query(
        `INSERT INTO scrape_cache
           (cache_key, normalized_url, domain, oss_path, status_code,
            content_type, size_bytes, formats, cached_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (cache_key) DO UPDATE SET
           oss_path = EXCLUDED.oss_path,
           status_code = EXCLUDED.status_code,
           content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes,
           cached_at = EXCLUDED.cached_at,
           expires_at = GREATEST(scrape_cache.expires_at, EXCLUDED.expires_at)`,
        [
          entry.cacheKey,
          entry.normalizedUrl,
          entry.domain,
          entry.ossPath,
          entry.statusCode,
          entry.contentType ?? null,
          entry.sizeBytes,
          entry.formats,
          entry.cachedAt,
          entry.expiresAt,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new CacheStorageError(`scrape_cache saveMetadata failed`, err);
    } finally {
      client.release();
    }
  }

  async bumpHit(cacheKey: string): Promise<void> {
    // Fire-and-forget caller; we still try-catch to keep errors local.
    try {
      await this.pool.query(
        `UPDATE scrape_cache
            SET hit_count = hit_count + 1,
                last_hit_at = NOW()
          WHERE cache_key = $1`,
        [cacheKey],
      );
    } catch (err) {
      // Swallow: hit_count is not load-bearing.
      // Caller already promised fire-and-forget semantics.
      // eslint-disable-next-line no-console
      console.warn("[cache] bumpHit failed (non-fatal)", cacheKey, err);
    }
  }

  async deleteExpired(limit: number): Promise<string[]> {
    try {
      const { rows } = await this.pool.query(
        `DELETE FROM scrape_cache
          WHERE cache_key IN (
            SELECT cache_key FROM scrape_cache
             WHERE expires_at < NOW()
             LIMIT $1
          )
          RETURNING oss_path`,
        [limit],
      );
      return rows.map(r => r.oss_path);
    } catch (err) {
      throw new CacheStorageError(`scrape_cache deleteExpired failed`, err);
    }
  }

  async countRows(): Promise<number> {
    try {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::bigint AS n FROM scrape_cache`,
      );
      return Number(rows[0].n);
    } catch (err) {
      throw new CacheStorageError(`scrape_cache countRows failed`, err);
    }
  }
}

type Row = {
  cache_key: string;
  normalized_url: string;
  domain: string;
  oss_path: string;
  status_code: number;
  content_type: string | null;
  size_bytes: number;
  formats: string[];
  cached_at: Date;
  expires_at: Date;
};

function rowToEntry(r: Row): CacheEntry {
  return {
    cacheKey: r.cache_key,
    normalizedUrl: r.normalized_url,
    domain: r.domain,
    ossPath: r.oss_path,
    statusCode: r.status_code,
    contentType: r.content_type ?? undefined,
    sizeBytes: r.size_bytes,
    formats: r.formats,
    cachedAt: r.cached_at,
    expiresAt: r.expires_at,
  };
}
