import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { IndexMissError } from "../../error";
import {
  CacheContentStore,
  CacheMetadataStore,
} from "../../../../zapfetch/cache";
import { config } from "../../../../config";
import { computeCacheKey, normalizeUrl } from "./key";
import { shouldSkipCache } from "./should-skip";
import { getDefaultMaxAge, getZapfetchCacheStorage } from "./storage";

/**
 * Build the engine handler with injected storage.
 *
 * Why a factory: the storage adapters (PG + OSS) are constructed once at
 * service boot with env-derived config. The engine itself is stateless.
 * Tests use the factory to inject mock stores.
 */
export function makeScrapeURLWithZapfetchCache(deps: {
  metadata: CacheMetadataStore;
  content: CacheContentStore;
  now?: () => Date;
}): (meta: Meta) => Promise<EngineScrapeResult> {
  const now = deps.now ?? (() => new Date());

  return async function scrapeURLWithZapfetchCache(
    meta: Meta,
  ): Promise<EngineScrapeResult> {
    const skip = shouldSkipCache(meta);
    if (skip.skip) {
      meta.logger.debug("zapfetch-cache: skipping", { reason: skip.reason });
      throw new IndexMissError();
    }

    // Apply default maxAge if caller didn't pass one (ZF-2 fork default = 24h).
    // maxAge=0 means "explicitly skip cache" — already handled by shouldSkipCache above.
    const maxAge =
      typeof meta.options.maxAge === "number"
        ? meta.options.maxAge
        : getDefaultMaxAge();
    if (maxAge <= 0) {
      throw new IndexMissError();
    }

    const key = computeCacheKey(meta);

    let entry;
    try {
      entry = await deps.metadata.lookup(key);
    } catch (err) {
      // Storage layer failure must NOT crash the request — degrade to miss
      // and let the regular engine fallback take over.
      meta.logger.warn("zapfetch-cache: lookup failed, treating as miss", {
        err,
      });
      throw new IndexMissError();
    }

    if (!entry) {
      throw new IndexMissError();
    }

    const ageMs = now().getTime() - entry.cachedAt.getTime();
    if (ageMs > maxAge) {
      meta.logger.debug("zapfetch-cache: expired vs maxAge", {
        ageMs,
        maxAge,
      });
      throw new IndexMissError();
    }

    let content: Buffer | null;
    try {
      content = await deps.content.get(entry.ossPath);
    } catch (err) {
      meta.logger.warn(
        "zapfetch-cache: content fetch failed, treating as miss",
        { err, ossPath: entry.ossPath },
      );
      throw new IndexMissError();
    }
    if (!content) {
      // metadata exists but content is gone (OSS lifecycle ate it before
      // the cleaner cron got the row). Treat as miss; cleanup happens later.
      meta.logger.warn("zapfetch-cache: orphan metadata (OSS missing)", {
        cacheKey: key,
        ossPath: entry.ossPath,
      });
      throw new IndexMissError();
    }

    // Fire-and-forget hit counter bump. Failure is non-fatal and already
    // swallowed inside bumpHit, but we add an extra guard here for safety.
    deps.metadata.bumpHit(key).catch(() => {});

    meta.logger.info("zapfetch-cache: hit", {
      cacheKey: key,
      ageMs,
      domain: entry.domain,
    });

    return {
      url: entry.normalizedUrl,
      html: content.toString("utf8"),
      statusCode: entry.statusCode,
      contentType: entry.contentType,
      proxyUsed: "basic",
      cacheInfo: { created_at: entry.cachedAt },
    };
  };
}

/**
 * Engine handler that the engineHandlers map dispatches to. Resolves the
 * module-level storage singleton (constructed lazily on first use) and
 * delegates to the factory-built engine.
 */
export async function scrapeURLWithZapfetchCache(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const storage = getZapfetchCacheStorage();
  const handler = makeScrapeURLWithZapfetchCache(storage);
  return handler(meta);
}

/**
 * Write-back transformer. Saves the freshly-scraped document to PG+OSS
 * fire-and-forget so cache hits become available for next requests.
 *
 * Skipped when:
 *   - shouldSkipCache(meta) (auth headers, sensitive params, maxAge=0)
 *   - cache is the winnerEngine (don't write what we just read)
 *   - statusCode is non-2xx (don't cache failures)
 *   - lockdown / zeroDataRetention flags set
 *
 * Always returns the document unchanged — write failures must NOT block
 * the response.
 */
export async function sendDocumentToZapfetchCache(
  meta: Meta,
  document: import("../../../../controllers/v1/types").Document,
): Promise<import("../../../../controllers/v1/types").Document> {
  // Don't cache if we just read from cache.
  if (meta.winnerEngine === "zapfetch-cache") return document;

  // shouldSkipCache is the read-path predicate. Most of its skip reasons
  // (auth-headers, sensitive query params, invalid URL) are also valid
  // write-path skips — those reasons mean the response itself isn't
  // safe to share. But "maxAge=0" is a read-side signal: the caller
  // wanted a fresh fetch for their request, not a directive that the
  // cache shouldn't be populated for future readers. Without this
  // carve-out, callers passing maxAge=0 silently disable writeback —
  // which masked Phase-1 dormant deployments and was flagged in codex
  // challenge round 2.
  //
  // Stricter write-side eligibility (storeInCache:false, actions,
  // location, profile, etc.) is tracked separately in ZF-10.
  const skip = shouldSkipCache(meta);
  if (skip.skip && skip.reason !== "maxAge=0") return document;

  if (
    meta.internalOptions.zeroDataRetention ||
    meta.options.lockdown === true
  ) {
    return document;
  }

  const status = document.metadata?.statusCode;
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return document;
  }

  const html = document.rawHtml ?? document.html ?? "";
  if (!html) return document;

  // Writeback uses the fork-default TTL, NOT the caller's maxAge. Reason:
  //   - Caller's maxAge=0 means "force a fresh fetch" — that's a *read-side*
  //     signal about the response they want. It should not also disable
  //     populating the cache for future readers, which is shared infrastructure.
  //   - The kill-switch for writeback is the fork default itself: setting
  //     `ZAPFETCH_CACHE_DEFAULT_MAX_AGE_MS=0` (e.g. via ConfigMap) yields
  //     writebackTtl=0 below and skips writes. This is what Phase-1 dormant
  //     deployments rely on.
  // Pre-fix this function read meta.options.maxAge here, which silently
  // turned every caller-side maxAge=0 into a writeback skip — making the
  // ConfigMap-level kill-switch redundant and breaking Phase-1 "write-only"
  // intent. See ZF-2 followup.
  const writebackTtl = getDefaultMaxAge();
  if (writebackTtl <= 0) return document;

  // Fire-and-forget — never block scrape response on cache write.
  void (async () => {
    try {
      const storage = getZapfetchCacheStorage();
      const key = computeCacheKey(meta);
      const url = normalizeUrl(meta.rewrittenUrl ?? meta.url);
      const domain = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return "unknown";
        }
      })();
      const now = new Date();
      const datePath = now.toISOString().slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
      const ossPath = `${config.CACHE_OSS_PREFIX}${datePath}/${key}.html.gz`;

      const content = Buffer.from(html, "utf8");

      await storage.content.put(ossPath, content);
      await storage.metadata.saveMetadata({
        cacheKey: key,
        normalizedUrl: url,
        domain,
        ossPath,
        statusCode: status,
        contentType: document.metadata?.contentType,
        sizeBytes: content.byteLength,
        formats: extractFormatNames(meta),
        cachedAt: now,
        expiresAt: new Date(now.getTime() + writebackTtl),
      });

      meta.logger.debug("zapfetch-cache: wrote", {
        cacheKey: key,
        sizeBytes: content.byteLength,
      });
    } catch (err) {
      meta.logger.warn("zapfetch-cache: write failed (non-fatal)", { err });
    }
  })();

  return document;
}

function extractFormatNames(meta: Meta): string[] {
  const formats = meta.options.formats ?? [];
  const names: string[] = [];
  for (const f of formats) {
    if (typeof f === "string") names.push(f);
    else if (f && typeof f === "object" && "type" in f) {
      names.push(String((f as { type: unknown }).type));
    }
  }
  return names.slice().sort();
}

export function zapfetchCacheMaxReasonableTime(_meta: Meta): number {
  // Cache lookup is bounded by PG query (<100ms typical) + OSS get
  // (<500ms typical) + ungzip (<50ms). Give 10s as the hard ceiling so
  // transient OSS hiccups don't block a request that could fall through
  // to a real scrape engine.
  return 10_000;
}
