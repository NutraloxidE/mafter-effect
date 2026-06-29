import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetVideoWarmupCacheForTest,
  ensureVideosPrimed,
  evictVideoPrimed,
  peekVideoPrimed,
  type VideoPrimeTarget,
} from "../src/runtime/videoWarmupCache";

beforeEach(() => {
  _resetVideoWarmupCacheForTest();
});

function target(
  assetId: string,
  targetSec: number,
  prime: () => Promise<boolean>,
  fps = 30,
): VideoPrimeTarget {
  return { assetId, targetSec, fps, prime };
}

describe("peekVideoPrimed", () => {
  it("is false before priming and true after a successful prime", async () => {
    expect(peekVideoPrimed("a", 1, 30)).toBe(false);
    await ensureVideosPrimed([target("a", 1, () => Promise.resolve(true))]);
    expect(peekVideoPrimed("a", 1, 30)).toBe(true);
  });

  it("quantizes to frame granularity (same frame = primed, other frame = not)", async () => {
    await ensureVideosPrimed([target("a", 1, () => Promise.resolve(true))]);
    // 1s + 0.4 frame @30fps は同一フレーム（round 30.4 -> 30）。
    expect(peekVideoPrimed("a", 1 + 0.4 / 30, 30)).toBe(true);
    expect(peekVideoPrimed("a", 2, 30)).toBe(false);
  });

  it("does not record primed state when prime fails", async () => {
    await ensureVideosPrimed([target("a", 1, () => Promise.resolve(false))]);
    expect(peekVideoPrimed("a", 1, 30)).toBe(false);
  });
});

describe("ensureVideosPrimed inflight dedup", () => {
  it("coalesces concurrent primes of the same key into one call", async () => {
    let resolveFn: (v: boolean) => void = () => {};
    const prime = vi.fn(
      () => new Promise<boolean>((r) => { resolveFn = r; }),
    );
    const p1 = ensureVideosPrimed([target("a", 1, prime)]);
    const p2 = ensureVideosPrimed([target("a", 1, prime)]);
    resolveFn(true);
    await Promise.all([p1, p2]);
    expect(prime).toHaveBeenCalledTimes(1);
    expect(peekVideoPrimed("a", 1, 30)).toBe(true);
  });

  it("primes distinct keys independently", async () => {
    const primeA = vi.fn(() => Promise.resolve(true));
    const primeB = vi.fn(() => Promise.resolve(true));
    await ensureVideosPrimed([target("a", 1, primeA), target("b", 1, primeB)]);
    expect(primeA).toHaveBeenCalledTimes(1);
    expect(primeB).toHaveBeenCalledTimes(1);
  });

  it("skips re-priming an already-primed key", async () => {
    const prime = vi.fn(() => Promise.resolve(true));
    await ensureVideosPrimed([target("a", 1, prime)]);
    await ensureVideosPrimed([target("a", 1, prime)]);
    expect(prime).toHaveBeenCalledTimes(1);
  });

  it("returns false when any target fails", async () => {
    const r = await ensureVideosPrimed([
      target("a", 1, () => Promise.resolve(true)),
      target("b", 1, () => Promise.resolve(false)),
    ]);
    expect(r).toBe(false);
  });
});

describe("evictVideoPrimed", () => {
  it("drops all primed frames for an asset", async () => {
    await ensureVideosPrimed([
      target("a", 1, () => Promise.resolve(true)),
      target("a", 2, () => Promise.resolve(true)),
      target("b", 1, () => Promise.resolve(true)),
    ]);
    evictVideoPrimed("a");
    expect(peekVideoPrimed("a", 1, 30)).toBe(false);
    expect(peekVideoPrimed("a", 2, 30)).toBe(false);
    expect(peekVideoPrimed("b", 1, 30)).toBe(true);
  });
});
