import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbFs } from "../src/fs/IndexedDbFs";

describe("IndexedDbFs: closed connection", () => {
  it("reopens instead of throwing 'Failed to execute transaction on IDBDatabase'", async () => {
    const fs = new IndexedDbFs("test-reopen-1");
    await fs.write("project.json", "{}");

    // ブラウザが接続を閉じた状況（versionchange / 強制クローズ）を再現。
    const db = await (fs as unknown as { dbPromise: Promise<IDBDatabase> }).dbPromise;
    db.close();

    await fs.write("project.json", "{\"a\":1}");
    expect(await fs.readText("project.json")).toBe("{\"a\":1}");
  });
});
