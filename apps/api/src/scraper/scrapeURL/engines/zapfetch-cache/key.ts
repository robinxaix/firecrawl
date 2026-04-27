import crypto from "crypto";
import { Meta } from "../..";

/**
 * Compute the cache key for a scrape request.
 *
 * Three components, all stable-stringified:
 *   - normalized URL (lowercase host, lowercase scheme, drop fragment)
 *   - format options (sorted, since {markdown,html} == {html,markdown})
 *   - scraping flags that materially change the response
 *
 * Excluded on purpose:
 *   - maxAge: only decides cache HIT, never key. A 4h request and a 24h
 *     request for the same URL hit the same row.
 *   - headers: requests with auth headers are skipped via shouldSkipCache,
 *     never cached, so headers cannot affect the key.
 *   - timeout: a request that timed out vs succeeded should not differ
 *     in caching behavior; the success vs failure is captured in
 *     statusCode which is stored separately.
 */
export function computeCacheKey(meta: Meta): string {
  const url = normalizeUrl(meta.rewrittenUrl ?? meta.url);
  const formats = stableStringify(formatNamesFromMeta(meta));
  const flags = stableStringify({
    onlyMainContent: meta.options.onlyMainContent,
    includeTags: sorted(meta.options.includeTags),
    excludeTags: sorted(meta.options.excludeTags),
    mobile: meta.options.mobile,
    skipTlsVerification: meta.options.skipTlsVerification,
    waitFor: meta.options.waitFor,
  });
  return crypto
    .createHash("sha256")
    .update(`${url}|${formats}|${flags}`)
    .digest("hex");
}

/**
 * Lowercase scheme + host, strip default ports, drop fragment, preserve query.
 * Does NOT touch path case (/Foo and /foo are different resources per RFC 3986).
 */
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    // If we can't parse, return verbatim — caller already validated upstream.
    return input;
  }
  u.hash = "";
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // Drop default port for canonicalization
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  return u.toString();
}

/**
 * meta.options.formats is an array of either strings or objects with .type.
 * Pull just the type names so two different format option objects with the
 * same type name produce the same cache key (e.g. screenshot with different
 * fullPage settings still cache together if we don't care about that here).
 */
function formatNamesFromMeta(meta: Meta): string[] {
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

function sorted<T>(arr: T[] | undefined): T[] | undefined {
  if (arr === undefined) return undefined;
  return [...arr].sort();
}

/**
 * Deterministic JSON: sort keys recursively so {a:1,b:2} and {b:2,a:1}
 * produce the same string.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          k =>
            JSON.stringify(k) +
            ":" +
            stableStringify((obj as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(obj);
}
