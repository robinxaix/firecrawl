export type {
  CacheEntry,
  CacheMetadataStore,
  CacheContentStore,
} from "./types";
// CacheStorageError is intentionally NOT re-exported from this barrel.
// It's a storage-internal sentinel; engine code catches all errors and
// rethrows IndexMissError, so external callers don't need to discriminate.

export { PostgresMetadataStore } from "./storage-pg";
export { OssContentStore } from "./storage-oss";
export type { OssClient } from "./storage-oss";
