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
  // Pre-RRSA: this also required CACHE_OSS_ACCESS_KEY_ID/_SECRET to be
  // present, treating empty AK envs as "cache disabled".
  //
  // Post-RRSA (ZF-9 stage 2+): the absence of static AK env is no longer
  // a "cache disabled" signal — it explicitly means "use the OIDC chain
  // injected by ack-pod-identity-webhook". The OSS client factory below
  // dispatches between the two paths based on whether AK envs are set.
  //
  // Whether actual OSS calls succeed gets validated at use time: bad
  // RRSA setup → SDK returns AccessDenied/STSError → engine fallback
  // takes over (graceful degrade). Same fallback for any transient
  // OSS failure today.
  return Boolean(
    config.ZAPFETCH_USE_CACHE &&
      config.CACHE_DATABASE_URL &&
      config.CACHE_OSS_BUCKET,
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

  // Dual-path OSS client factory:
  //  1. Static AK env present → legacy path (sealed-secret-injected env,
  //     unchanged from pre-RRSA).
  //  2. Static AK env absent → RRSA / OIDC path. Use @alicloud/credentials
  //     default chain which detects ALIBABA_CLOUD_ROLE_ARN /
  //     OIDC_PROVIDER_ARN / OIDC_TOKEN_FILE injected by ack-pod-identity-
  //     webhook and calls AssumeRoleWithOIDC for a temporary STS triple.
  //
  // Returns a Promise — credential resolution is async (HTTP roundtrip to
  // STS endpoint). OssContentStore awaits it on first call and caches.
  //
  // Lifecycle caveat (mirrors cleaner Go-side comment in
  // services/cleaner/oss.go): STS triple is captured ONCE at first OSS
  // call and frozen on the ali-oss client (no auto-refresh). STS TTL ≥ 1h
  // by RAM Role default. fc-api is a long-running daemon — at hour
  // boundaries the bound credentials will start failing. ZF-9 followup
  // will either upgrade ali-oss to a version with refreshable
  // credentials or wrap the factory with a periodic refresh interceptor.
  // For now: if you observe OSS auth errors after the pod has been up
  // >1h, restart the pod (rolling).
  const ossFactory = async (): Promise<OssClient> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OSS = require("ali-oss");

    if (config.CACHE_OSS_ACCESS_KEY_ID && config.CACHE_OSS_ACCESS_KEY_SECRET) {
      // Static AK path
      return new OSS({
        region: config.CACHE_OSS_REGION,
        bucket: config.CACHE_OSS_BUCKET,
        accessKeyId: config.CACHE_OSS_ACCESS_KEY_ID,
        accessKeySecret: config.CACHE_OSS_ACCESS_KEY_SECRET,
      });
    }

    // RRSA path. @alicloud/credentials default chain auto-detects the
    // OIDC env triple and performs AssumeRoleWithOIDC.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Credential = require("@alicloud/credentials").default;
    const cred = new Credential();
    const triple: {
      accessKeyId: string;
      accessKeySecret: string;
      securityToken: string;
    } = await cred.getCredential();
    return new OSS({
      region: config.CACHE_OSS_REGION,
      bucket: config.CACHE_OSS_BUCKET,
      accessKeyId: triple.accessKeyId,
      accessKeySecret: triple.accessKeySecret,
      stsToken: triple.securityToken,
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
