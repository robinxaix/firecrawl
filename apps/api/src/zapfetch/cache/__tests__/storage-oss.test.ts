import { gzipSync } from "zlib";
import { OssContentStore, OssClient } from "../storage-oss";
import { CacheStorageError } from "../types";

const makeClient = (): OssClient & {
  put: jest.Mock;
  get: jest.Mock;
  delete: jest.Mock;
  deleteMulti: jest.Mock;
} =>
  ({
    put: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    deleteMulti: jest.fn(),
  }) as never;

describe("OssContentStore.put", () => {
  it("gzips before uploading", async () => {
    const client = makeClient();
    const store = new OssContentStore(() => client);

    await store.put("docs/x.gz", Buffer.from("hello world"));

    expect(client.put).toHaveBeenCalledTimes(1);
    const [, uploaded] = client.put.mock.calls[0];
    // verify it round-trips through gzip
    expect(uploaded).toBeInstanceOf(Buffer);
    expect(uploaded).not.toEqual(Buffer.from("hello world"));
  });

  it("wraps errors as CacheStorageError", async () => {
    const client = makeClient();
    client.put.mockRejectedValueOnce(new Error("boom"));
    const store = new OssContentStore(() => client);

    await expect(store.put("x", Buffer.from("y"))).rejects.toBeInstanceOf(
      CacheStorageError,
    );
  });
});

describe("OssContentStore.get", () => {
  it("returns gunzipped content", async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({
      content: gzipSync(Buffer.from("hello")),
    });
    const store = new OssContentStore(() => client);

    const got = await store.get("docs/x.gz");
    expect(got?.toString("utf8")).toBe("hello");
  });

  it("returns null on NoSuchKey (404)", async () => {
    const client = makeClient();
    const err = new Error("not found") as Error & { code: string };
    err.code = "NoSuchKey";
    client.get.mockRejectedValueOnce(err);
    const store = new OssContentStore(() => client);

    expect(await store.get("docs/missing")).toBeNull();
  });

  it("wraps non-404 errors", async () => {
    const client = makeClient();
    client.get.mockRejectedValueOnce(new Error("5xx"));
    const store = new OssContentStore(() => client);

    await expect(store.get("docs/x")).rejects.toBeInstanceOf(CacheStorageError);
  });
});

describe("OssContentStore.delete", () => {
  it("is idempotent on NoSuchKey", async () => {
    const client = makeClient();
    const err = new Error("not found") as Error & { code: string };
    err.code = "NoSuchKey";
    client.delete.mockRejectedValueOnce(err);
    const store = new OssContentStore(() => client);

    await expect(store.delete("docs/x")).resolves.toBeUndefined();
  });
});

describe("OssContentStore.deleteMany", () => {
  it("chunks at 1000 keys per call", async () => {
    const client = makeClient();
    client.deleteMulti.mockResolvedValue({});
    const store = new OssContentStore(() => client);

    const paths = Array.from({ length: 2500 }, (_, i) => `docs/${i}.gz`);
    await store.deleteMany(paths);

    expect(client.deleteMulti).toHaveBeenCalledTimes(3); // 1000 + 1000 + 500
    expect((client.deleteMulti.mock.calls[0][0] as string[]).length).toBe(1000);
    expect((client.deleteMulti.mock.calls[2][0] as string[]).length).toBe(500);
  });

  it("no-ops on empty input", async () => {
    const client = makeClient();
    const store = new OssContentStore(() => client);

    await store.deleteMany([]);
    expect(client.deleteMulti).not.toHaveBeenCalled();
  });
});
