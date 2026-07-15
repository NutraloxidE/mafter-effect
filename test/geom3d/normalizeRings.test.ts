import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseFont, type Font } from "opentype.js";
import { describe, expect, it } from "vitest";
import { normalizeRingsNonzero } from "../../src/runtime/geom3d/normalizeRings";
import { flattenPathCommandsToRings } from "../../src/runtime/geom3d/outlineProvider";
import type { Vec2 } from "../../src/runtime/geom3d/geom3dTypes";

/**
 * §5.5f 輪郭の nonzero 正規化。回帰の核心は 2 点:
 *  1. 出力リングが互いに交差しない（下流の earcut / 入れ子深度判定 / bevel inset の前提）
 *  2. 塗り領域が入力の nonzero winding と等価（グリフの見た目が変わらない）
 * 実フォントで検証する — 合成テストケースでは「フォントが実際に何をしてくるか」を捉えられない。
 */

function loadFont(file: string): Font {
  const buf = readFileSync(path.resolve(__dirname, `../../public/fonts/${file}`));
  return parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function glyphRings(font: Font, ch: string): Vec2[][] {
  return flattenPathCommandsToRings(font.getPath(ch, 0, 0, 100).commands, 8);
}

/** 真の交差のみ（端点の接触・共線は数えない）。 */
function segmentsProperlyCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function ringsCross(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsProperlyCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return false;
}

function selfIntersects(r: Vec2[]): boolean {
  const n = r.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsProperlyCross(r[i]!, r[(i + 1) % n]!, r[j]!, r[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

/** 点 pt のリング列に対する winding number（フォントの塗り規則そのもの）。 */
function windingNumber(pt: Vec2, rings: Vec2[][]): number {
  let w = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const side = (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y);
      if (a.y <= pt.y) {
        if (b.y > pt.y && side > 0) w++;
      } else if (b.y <= pt.y && side < 0) w--;
    }
  }
  return w;
}

/** 正規化前後で「塗られる領域」が一致する割合をグリッドサンプルで測る。 */
function fillMismatchRatio(raw: Vec2[][], norm: Vec2[][], grid = 48): number {
  const pts = raw.flat();
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const y1 = Math.max(...pts.map((p) => p.y));
  let mismatch = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      // 頂点・辺にちょうど乗って判定が不定になるのを避けるため、格子を半端にずらす。
      const pt = { x: x0 + (x1 - x0) * ((gx + 0.37) / grid), y: y0 + (y1 - y0) * ((gy + 0.41) / grid) };
      if ((windingNumber(pt, raw) !== 0) !== (windingNumber(pt, norm) !== 0)) mismatch++;
    }
  }
  return mismatch / (grid * grid);
}

describe("normalizeRingsNonzero", () => {
  it("returns input unchanged for an empty ring list", () => {
    expect(normalizeRingsNonzero([])).toEqual([]);
  });

  it("keeps a simple triangle a single ring", () => {
    const tri: Vec2[][] = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]];
    const out = normalizeRingsNonzero(tri);
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(3);
  });

  it("merges two overlapping squares into one ring (nonzero union)", () => {
    const square = (ox: number): Vec2[] => [
      { x: ox, y: 0 }, { x: ox + 10, y: 0 }, { x: ox + 10, y: 10 }, { x: ox, y: 10 },
    ];
    const out = normalizeRingsNonzero([square(0), square(5)]);
    expect(out.length).toBe(1);
    // union の外形は x=0..15 に広がる（重なりが潰れていない）。
    const xs = out[0]!.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(15, 6);
  });

  it("preserves a genuine hole (outer ring + reverse-wound inner ring)", () => {
    const outer: Vec2[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const hole: Vec2[] = [{ x: 5, y: 15 }, { x: 15, y: 15 }, { x: 15, y: 5 }, { x: 5, y: 5 }];
    const out = normalizeRingsNonzero([outer, hole]);
    expect(out.length).toBe(2);
    // 穴の中心は塗られないままであること（union で埋めてしまっていない）。
    expect(windingNumber({ x: 10, y: 10 }, out)).toBe(0);
    expect(windingNumber({ x: 2, y: 10 }, out)).not.toBe(0);
  });

  // 本命の回帰: 生アウトラインが重なる実グリフ。fix 前はここが壊れていた。
  const cases: Array<[string, string]> = [
    ["NotoSansJP-Regular.ttf", "日本語国鬱"],
    ["Roboto-Variable.ttf", "AB8gq%"],
    ["NotoSans-Regular.ttf", "ABO8i%"],
    ["Anton-Regular.ttf", "ABO8"],
    ["Tinos-Regular.ttf", "ABO8gW"],
    ["Cousine-Regular.ttf", "ABO8@#"],
  ];

  for (const [file, chars] of cases) {
    describe(file, () => {
      const font = loadFont(file);
      for (const ch of chars) {
        it(`'${ch}': output rings are non-crossing and preserve the nonzero fill`, () => {
          const raw = glyphRings(font, ch);
          expect(raw.length).toBeGreaterThan(0);
          const norm = normalizeRingsNonzero(raw);

          for (let i = 0; i < norm.length; i++) {
            expect(selfIntersects(norm[i]!), `ring ${i} self-intersects`).toBe(false);
            for (let j = i + 1; j < norm.length; j++) {
              expect(ringsCross(norm[i]!, norm[j]!), `rings ${i}/${j} cross`).toBe(false);
            }
          }
          expect(fillMismatchRatio(raw, norm)).toBeLessThan(0.01);
        });
      }
    });
  }

  it("resolves 日 into solid strokes, not punched-out holes (the reported bug)", () => {
    const font = loadFont("NotoSansJP-Regular.ttf");
    const raw = glyphRings(font, "日");
    // 生アウトラインは「枠 + 横棒 2 本」の重なりで、穴を 1 つも持たない。
    expect(raw.length).toBe(3);
    const norm = normalizeRingsNonzero(raw);
    // 横棒の中心は実体＝塗られていなければならない（旧実装はここを穴と誤判定して抜いていた）。
    const barCenters = raw.slice(1).map((bar) => {
      const xs = bar.map((p) => p.x);
      const ys = bar.map((p) => p.y);
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    });
    for (const c of barCenters) expect(windingNumber(c, norm)).not.toBe(0);
  });
});
