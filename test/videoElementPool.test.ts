import { describe, expect, it } from "vitest";
import { KeyedElementPool } from "../src/runtime/videoElementPool";

// §11.4 カット境界の <video> 要素再利用プール（DOM 非依存の keyed stack）。
describe("KeyedElementPool — stash / acquire", () => {
  it("stash した要素を同一 key で acquire できる（カット境界の同一アセット再利用）", () => {
    const pool = new KeyedElementPool<string>();
    pool.stash("assetA", "elA1");
    expect(pool.acquire("assetA")).toBe("elA1");
  });

  it("空き不足は null を返す（同時表示は新規生成へフォールバック・重複利用しない）", () => {
    const pool = new KeyedElementPool<string>();
    pool.stash("assetA", "elA1");
    expect(pool.acquire("assetA")).toBe("elA1");
    // 2 つ目のレイヤーが同時に同一アセットを要求 → 空 → null（呼び出し側は createComponentEl）。
    expect(pool.acquire("assetA")).toBeNull();
  });

  it("未知 key は null", () => {
    const pool = new KeyedElementPool<string>();
    expect(pool.acquire("nope")).toBeNull();
  });

  it("key ごとに独立（別アセットの要素を取り違えない）", () => {
    const pool = new KeyedElementPool<string>();
    pool.stash("assetA", "elA1");
    pool.stash("assetB", "elB1");
    expect(pool.acquire("assetB")).toBe("elB1");
    expect(pool.acquire("assetA")).toBe("elA1");
  });

  it("同一 key の複数退避は LIFO で取り出す", () => {
    const pool = new KeyedElementPool<string>();
    pool.stash("assetA", "elA1");
    pool.stash("assetA", "elA2");
    expect(pool.acquire("assetA")).toBe("elA2");
    expect(pool.acquire("assetA")).toBe("elA1");
    expect(pool.acquire("assetA")).toBeNull();
  });

  it("drain は全要素を返してプールを空にする（dispose teardown）", () => {
    const pool = new KeyedElementPool<string>();
    pool.stash("assetA", "elA1");
    pool.stash("assetA", "elA2");
    pool.stash("assetB", "elB1");
    expect(pool.size()).toBe(3);
    const drained = pool.drain().sort();
    expect(drained).toEqual(["elA1", "elA2", "elB1"]);
    expect(pool.size()).toBe(0);
    expect(pool.acquire("assetA")).toBeNull();
  });

  it("has / remove — 先読み warm-up の重複投入防止と明示破棄", () => {
    const pool = new KeyedElementPool<string>();
    expect(pool.has("assetA")).toBe(false);
    pool.stash("assetA", "elA1");
    expect(pool.has("assetA")).toBe(true);
    expect(pool.remove("assetA", "elA1")).toBe(true);
    expect(pool.has("assetA")).toBe(false);
    expect(pool.remove("assetA", "elA1")).toBe(false);
  });
});
