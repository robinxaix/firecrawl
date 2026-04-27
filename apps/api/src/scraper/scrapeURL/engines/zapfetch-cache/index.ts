import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { IndexMissError } from "../../error";
import {
  CacheContentStore,
  CacheMetadataStore,
} from "../../../../zapfetch/cache";
import { computeCacheKey } from "./key";
import { shouldSkipCache } from "./should-skip";

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

    const maxAge = meta.options.maxAge;
    if (typeof maxAge !== "number" || maxAge <= 0) {
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

export function zapfetchCacheMaxReasonableTime(_meta: Meta): number {
  // Cache lookup is bounded by PG query (<100ms typical) + OSS get
  // (<500ms typical) + ungzip (<50ms). Give 10s as the hard ceiling so
  // transient OSS hiccups don't block a request that could fall through
  // to a real scrape engine.
  return 10_000;
}
