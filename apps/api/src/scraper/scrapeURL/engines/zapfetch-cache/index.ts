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
import { shouldSkipWriteback } from "./should-skip-writeback";
import {
  getDefaultMaxAge,
  getWritebackTtl,
  getZapfetchCacheStorage,
} from "./storage";

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
 * Build the writeback handler with injected storage. Mirrors the engine's
 * factory pattern so unit tests can mock storage + clock + TTL without
 * loading the module-level singleton.
 *
 * Skipped when:
 *   - shouldSkipWriteback(meta) — read-side rules (minus maxAge=0) plus
 *     storeInCache=false, actions, location
 *   - cache is the winnerEngine (don't write what we just read)
 *   - lockdown / zeroDataRetention flags set
 *   - statusCode non-2xx
 *   - empty html
 *
 * The fire-and-forget Promise is RETURNED via deps.onWrite so tests can
 * await it. In production we drop it on the floor (writes never block).
 */
export function makeSendDocumentToZapfetchCache(deps: {
  metadata: CacheMetadataStore;
  content: CacheContentStore;
  now?: () => Date;
  writebackTtlMs?: number;
  /** Test hook — receives the in-flight write Promise so callers can await. */
  onWrite?: (p: Promise<void>) => void;
}): (
  meta: Meta,
  document: import("../../../../controllers/v1/types").Document,
) => Promise<import("../../../../controllers/v1/types").Document> {
  const now = deps.now ?? (() => new Date());
  const writebackTtlMs = deps.writebackTtlMs ?? getWritebackTtl();

  return async function sendDocumentToZapfetchCache(meta, document) {
    if (meta.winnerEngine === "zapfetch-cache") return document;

    const skip = shouldSkipWriteback(meta);
    if (skip.skip) return document;

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

    // Fire-and-forget — never block scrape response on cache write.
    const writePromise = (async () => {
      try {
        const key = computeCacheKey(meta);
        const url = normalizeUrl(meta.rewrittenUrl ?? meta.url);
        const domain = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "unknown";
          }
        })();
        const writtenAt = now();
        const datePath = writtenAt
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, "/"); // YYYY/MM/DD
        const ossPath = `${config.CACHE_OSS_PREFIX}${datePath}/${key}.html.gz`;

        const content = Buffer.from(html, "utf8");

        await deps.content.put(ossPath, content);
        await deps.metadata.saveMetadata({
          cacheKey: key,
          normalizedUrl: url,
          domain,
          ossPath,
          statusCode: status,
          contentType: document.metadata?.contentType,
          sizeBytes: content.byteLength,
          formats: extractFormatNames(meta),
          cachedAt: writtenAt,
          expiresAt: new Date(writtenAt.getTime() + writebackTtlMs),
        });

        meta.logger.debug("zapfetch-cache: wrote", {
          cacheKey: key,
          sizeBytes: content.byteLength,
        });
      } catch (err) {
        meta.logger.warn("zapfetch-cache: write failed (non-fatal)", { err });
      }
    })();

    if (deps.onWrite) {
      deps.onWrite(writePromise);
    } else {
      void writePromise;
    }
    return document;
  };
}

/**
 * Write-back transformer. Saves the freshly-scraped document to PG+OSS
 * fire-and-forget so cache hits become available for next requests.
 * Module-level wrapper around the factory; resolves storage singleton.
 */
export async function sendDocumentToZapfetchCache(
  meta: Meta,
  document: import("../../../../controllers/v1/types").Document,
): Promise<import("../../../../controllers/v1/types").Document> {
  const storage = getZapfetchCacheStorage();
  const handler = makeSendDocumentToZapfetchCache(storage);
  return handler(meta, document);
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
