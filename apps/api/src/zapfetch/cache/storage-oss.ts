import { gzipSync, gunzipSync } from "zlib";
import { CacheContentStore, CacheStorageError } from "./types";

/**
 * Aliyun OSS-backed content store. Ali-oss SDK is dynamically required so
 * this module can be imported in environments where OSS isn't configured
 * (e.g. tests with mock store).
 */
// Minimal subset of ali-oss client surface that we actually call.
// Exported so tests can produce conformant mocks.
export interface OssClient {
  put(name: string, file: Buffer): Promise<unknown>;
  get(name: string): Promise<{ content: Buffer }>;
  delete(name: string): Promise<unknown>;
  deleteMulti(names: string[], options?: { quiet?: boolean }): Promise<unknown>;
}

type OssClientFactory = () => OssClient;

export class OssContentStore implements CacheContentStore {
  private clientCache?: OssClient;

  constructor(private readonly factory: OssClientFactory) {}

  private client(): OssClient {
    if (!this.clientCache) this.clientCache = this.factory();
    return this.clientCache;
  }

  async put(ossPath: string, content: Buffer): Promise<void> {
    try {
      const compressed = gzipSync(content);
      await this.client().put(ossPath, compressed);
    } catch (err) {
      throw new CacheStorageError(`OSS put failed for ${ossPath}`, err);
    }
  }

  async get(ossPath: string): Promise<Buffer | null> {
    try {
      const { content } = await this.client().get(ossPath);
      return gunzipSync(content);
    } catch (err) {
      // ali-oss throws err with .code === 'NoSuchKey' on 404
      const code = (err as { code?: string }).code;
      if (code === "NoSuchKey") return null;
      throw new CacheStorageError(`OSS get failed for ${ossPath}`, err);
    }
  }

  async delete(ossPath: string): Promise<void> {
    try {
      await this.client().delete(ossPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "NoSuchKey") return; // idempotent
      throw new CacheStorageError(`OSS delete failed for ${ossPath}`, err);
    }
  }

  async deleteMany(ossPaths: string[]): Promise<void> {
    if (ossPaths.length === 0) return;
    // ali-oss limit: 1000 keys per call. Chunk if larger.
    const CHUNK = 1000;
    for (let i = 0; i < ossPaths.length; i += CHUNK) {
      const chunk = ossPaths.slice(i, i + CHUNK);
      try {
        await this.client().deleteMulti(chunk, { quiet: true });
      } catch (err) {
        throw new CacheStorageError(
          `OSS deleteMulti failed (chunk ${i}-${i + chunk.length})`,
          err,
        );
      }
    }
  }
}

// Note: a default ali-oss factory is intentionally NOT exported here.
// Task C.3 will inline the construction at the point of use:
//
//   new OssContentStore(() => {
//     const OSS = require('ali-oss');
//     return new OSS({ region, bucket, accessKeyId, accessKeySecret });
//   });
//
// This keeps the import-graph weight off services that don't enable caching.
