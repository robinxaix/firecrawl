import { Pool } from "pg";
import { config } from "../../../../config";
import {
  CacheContentStore,
  CacheMetadataStore,
  OssClient,
  OssContentStore,
  PostgresMetadataStore,
} from "../../../../zapfetch/cache";

/**
 * Lazy module-level storage singleton.
 *
 * The engine handler signature is `(meta) => Promise<EngineScrapeResult>` —
 * no place to inject deps at call time. This module owns construction of
 * the PG pool + OSS client and exposes them to the engine + the write-back
 * transformer through a single getter.
 *
 * Tests should NOT use this; they use `makeScrapeURLWithZapfetchCache`
 * directly with mocked stores.
 */

let cached: {
  metadata: CacheMetadataStore;
  content: CacheContentStore;
} | null = null;

export function isZapfetchCacheConfigured(): boolean {
  return Boolean(
    config.ZAPFETCH_USE_CACHE &&
      config.CACHE_DATABASE_URL &&
      config.CACHE_OSS_BUCKET &&
      config.CACHE_OSS_ACCESS_KEY_ID &&
      config.CACHE_OSS_ACCESS_KEY_SECRET,
  );
}

export function getZapfetchCacheStorage(): {
  metadata: CacheMetadataStore;
  content: CacheContentStore;
} {
  if (cached) return cached;
  if (!isZapfetchCacheConfigured()) {
    throw new Error("zapfetch-cache: storage not configured");
  }

  const pool = new Pool({
    connectionString: config.CACHE_DATABASE_URL,
    // Sane bounded pool — cache lookups should be sub-100ms; a small pool
    // is enough and avoids exhausting RDS connection slots.
    max: 8,
    idleTimeoutMillis: 30_000,
  });
  const metadata = new PostgresMetadataStore(pool);

  const ossFactory = (): OssClient => {
    // Lazy require so deploys with caching disabled don't pull ali-oss
    // into the import graph.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OSS = require("ali-oss");
    return new OSS({
      region: config.CACHE_OSS_REGION,
      bucket: config.CACHE_OSS_BUCKET,
      accessKeyId: config.CACHE_OSS_ACCESS_KEY_ID,
      accessKeySecret: config.CACHE_OSS_ACCESS_KEY_SECRET,
    });
  };
  const content = new OssContentStore(ossFactory);

  cached = { metadata, content };
  return cached;
}

/**
 * Default cache TTL (ms) when caller didn't supply maxAge.
 *
 * ZF-2 design: 24h applied to all v2 requests that don't set maxAge=0.
 * Override via ZAPFETCH_CACHE_DEFAULT_MAX_AGE_MS env. Set to 0 to
 * effectively disable cache for callers that don't opt in.
 */
export function getDefaultMaxAge(): number {
  return config.ZAPFETCH_CACHE_DEFAULT_MAX_AGE_MS ?? 24 * 60 * 60 * 1000;
}
