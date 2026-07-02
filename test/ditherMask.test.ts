import { describe, expect, it } from "vitest";
import { bayerMatrix, ditherVisible } from "../src/runtime/ditherMask";

// §5.4d / INV-1: Bayer 秩序ディザは完全決定論（Math.random 不要）。将来 effect 用に温存。
describe("ditherMask determinism", () => {
  it("8×8 Bayer は 0..63 の全階調を 1 度ずつ含む", () => {
    const m = bayerMatrix(8);
    const flat = m.flat().sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it("opacity が上がると可視テクセル数は単調増加", () => {
    const count = (op: number) => {
      let n = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (ditherVisible(x, y, op)) n++;
      return n;
    };
    expect(count(0)).toBe(0);
    expect(count(1)).toBe(64);
    expect(count(0.25)).toBeLessThan(count(0.75));
  });

  it("同 opacity は同一結果（決定論）", () => {
    expect(ditherVisible(3, 5, 0.5)).toBe(ditherVisible(3, 5, 0.5));
  });
});
