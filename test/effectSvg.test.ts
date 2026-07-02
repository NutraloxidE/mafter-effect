import { describe, expect, it } from "vitest";
import {
  angularWipeMask,
  bayerMaskSvg,
  ditherDissolveMask,
  lightPixelSortDisplaceMapSvg,
  lightPixelSortFilter,
  linearWipeGradientCoords,
  linearWipeMask,
  phaseToSeed,
  evolutionToOffsetPx,
  displacementPadFromScale,
  DISPLACEMENT_EFFECT_TYPES,
  displaceWithMap,
  fastRippleDisplace,
  fastTurbulentDisplace,
  fastWaveDisplace,
  rippleDisplaceMap,
  rippleDisplacementSample,
  rippleMapDims,
  RIPPLE_MAP_MAX_DIM,
  sizeToFrequency,
  svgDisplaceFilterMarkup,
  waveDisplaceMapSvg,
  FRACTAL_NOISE_G_BIAS_INTERCEPT,
  TURBULENCE_CHANNEL_BIAS_INTERCEPT,
  turbulenceDisplace,
  wavelengthToFrequency,
} from "../src/runtime/effectSvg";
import { rgbaToPngDataUri } from "../src/runtime/pngDataUri";
import {
  RIPPLE_EFFECT_DEF,
  TURBULENT_DISPLACE_EFFECT_DEF,
  WAVE_EFFECT_DEF,
} from "../src/runtime/builtinEffects";

/** PNG data URI の IHDR から width/height を読む（テスト用）。 */
function pngDims(uri: string): { w: number; h: number } {
  const bytes = Uint8Array.from(atob(uri.split(",")[1]!), (c) => c.charCodeAt(0));
  const dv = new DataView(bytes.buffer);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/** SVG data URI 内の <stop 個数を数える（テスト用）。 */
function countStops(uri: string): number {
  return decodeURIComponent(uri.split(",")[1]!).split("<stop").length - 1;
}

/** SVG primitives 文字列から numOctaves 属性値を読む（テスト用）。 */
function numOctavesOf(primitives: string): number {
  const m = primitives.match(/numOctaves="(\d+)"/);
  return m ? Number(m[1]) : NaN;
}

describe("effectSvg helpers", () => {
  it("wavelengthToFrequency inverts wavelength", () => {
    expect(wavelengthToFrequency(50)).toBeCloseTo(0.02);
    expect(wavelengthToFrequency(100)).toBeCloseTo(0.01);
  });

  it("sizeToFrequency is inverse of AE Size (px wavelength)", () => {
    expect(sizeToFrequency(100)).toBeCloseTo(0.01);
    expect(sizeToFrequency(10)).toBeGreaterThan(sizeToFrequency(100));
  });

  it("displacementPadFromScale grows with amount", () => {
    expect(displacementPadFromScale(100)).toBeGreaterThan(displacementPadFromScale(10));
  });

  it("svgDisplaceFilterMarkup emits userSpaceOnUse region with pad", () => {
    const m = svgDisplaceFilterMarkup("f1", "<feTurbulence/>", 320, 240, 50);
    expect(m).toContain('id="f1"');
    expect(m).toContain('filterUnits="userSpaceOnUse"');
    expect(m).toContain('width="374"');
  });

  it("svgDisplaceFilterMarkup compFixed clamps region to layer bounds (no pad) — §27.12 改定3 Fast* live region", () => {
    const m = svgDisplaceFilterMarkup("f1", "<feTurbulence/>", 320, 240, 50, true);
    expect(m).toContain('x="0" y="0" width="320" height="240"');
    // pad された幅 374 が出ない（クランプの確証）。
    expect(m).not.toContain('width="374"');
  });

  it("evolutionToOffsetPx is continuous and non-zero for non-zero evolution", () => {
    const a = evolutionToOffsetPx(45, 100);
    const b = evolutionToOffsetPx(90, 100);
    expect(a.dx).not.toBe(b.dx);
    expect(Math.hypot(a.dx, a.dy)).toBeGreaterThan(0);
  });

  it("phaseToSeed is deterministic", () => {
    expect(phaseToSeed(90)).toBe(phaseToSeed(90));
    expect(phaseToSeed(0)).not.toBe(phaseToSeed(180));
  });

  it("turbulenceDisplace emits feTurbulence and feDisplacementMap with layer bounds", () => {
    const s = turbulenceDisplace({
      scale: 10,
      baseFrequencyX: 0.02,
      baseFrequencyY: 0.02,
      seed: 42,
      w: 320,
      h: 240,
    });
    expect(s).toContain("feTurbulence");
    expect(s).toContain('scale="10"');
    expect(s).toContain('width="320"');
    expect(s).toContain('stitchTiles="stitch"');
    expect(s).toContain("feComponentTransfer");
    expect(s).toContain("noiseRaw");
    expect(s).toContain("noiseBalanced");
    expect(s).toContain(`intercept="${TURBULENCE_CHANNEL_BIAS_INTERCEPT}"`);
  });

  it("turbulenceDisplace balances fractalNoise G channel bias", () => {
    const s = turbulenceDisplace({
      scale: 10,
      baseFrequencyX: 0.02,
      baseFrequencyY: 0.02,
      seed: 0,
      type: "fractalNoise",
      w: 100,
      h: 100,
    });
    expect(s).toContain('intercept="0"');
    expect(s).toContain(`intercept="${FRACTAL_NOISE_G_BIAS_INTERCEPT}"`);
  });

  it("turbulenceDisplace uses feOffset for evolution pan", () => {
    const s = turbulenceDisplace({
      scale: 10,
      baseFrequencyX: 0.01,
      baseFrequencyY: 0.01,
      seed: 0,
      w: 100,
      h: 100,
      evolutionOffsetX: 12,
      evolutionOffsetY: 5,
    });
    expect(s).toContain("feOffset");
    expect(s).toContain('dx="12"');
    expect(s).toContain('dy="5"');
  });

  it("linearWipeMask returns empty string at completion 0 (AE: inert)", () => {
    expect(linearWipeMask(0, 0, 0, 1920, 1080)).toBe("");
  });

  it("ditherDissolveMask returns empty at full reveal", () => {
    expect(ditherDissolveMask(1, 320, 240)).toBe("");
  });

  it("ditherDissolveMask uses pattern and luminanceToAlpha at partial reveal", () => {
    const s = ditherDissolveMask(0.5, 320, 240);
    expect(s).toContain("feImage");
    expect(s).toContain("luminanceToAlpha");
    expect(s).toContain('operator="in"');
    expect(s).not.toContain("feTile");
  });

  it("bayerMaskSvg tiles 8x8 pattern across layer", () => {
    const svg = bayerMaskSvg(64, 64, 0.5);
    expect(svg).toContain('patternUnits="userSpaceOnUse"');
    expect(svg).toContain('width="8" height="8"');
  });

  it("linearWipeMask converts luminance to alpha for partial completion", () => {
    const s = linearWipeMask(0.5, 0, 0, 1920, 1080);
    expect(s).toContain("luminanceToAlpha");
    expect(s).toContain('operator="in"');
  });

  it("linearWipeMask accepts angles outside 0..360", () => {
    const neg = linearWipeMask(0.5, -45, 0, 1920, 1080);
    const over = linearWipeMask(0.5, 405, 0, 1920, 1080);
    expect(neg).toContain("userSpaceOnUse");
    expect(over).toContain("userSpaceOnUse");
    expect(neg).toContain("luminanceToAlpha");
    expect(over).toContain("luminanceToAlpha");
  });

  it("linearWipeGradientCoords spans rectangle corners for diagonal angle", () => {
    const w = 400;
    const h = 300;
    const { x1, y1, x2, y2 } = linearWipeGradientCoords(45, w, h);
    const rad = (45 * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
    let minP = Infinity;
    let maxP = -Infinity;
    for (const [x, y] of corners) {
      const p = x * dx + y * dy;
      minP = Math.min(minP, p);
      maxP = Math.max(maxP, p);
    }
    const proj = (x: number, y: number) => x * dx + y * dy;
    expect(proj(x1, y1)).toBeCloseTo(minP, 5);
    expect(proj(x2, y2)).toBeCloseTo(maxP, 5);
  });

  it("linearWipeMask at high completion uses gradient (not early all-black shortcut)", () => {
    const s = linearWipeMask(0.99, 45, 0, 400, 300);
    expect(s).toContain("userSpaceOnUse");
    expect(s).toContain("1.000%25%22%20stop-color%3D%22black");
  });

  it("angularWipeMask includes path for partial completion", () => {
    const s = angularWipeMask(0.5, 0, 0.5, 0.5, 0, 1920, 1080);
    expect(s).toContain("path");
    expect(s).toContain("feComposite");
    expect(s).toContain("luminanceToAlpha");
  });

  it("angularWipeMask is inert at completion 0", () => {
    expect(angularWipeMask(0, 0, 0.5, 0.5, 0, 1920, 1080)).toBe("");
  });

  it("angularWipeMask accepts start angles outside 0..360", () => {
    const neg = angularWipeMask(0.5, -90, 0.5, 0.5, 0, 1920, 1080);
    const over = angularWipeMask(0.5, 450, 0.5, 0.5, 0, 1920, 1080);
    expect(neg).toContain("path");
    expect(over).toContain("path");
    expect(neg).toContain("luminanceToAlpha");
    expect(over).toContain("luminanceToAlpha");
  });

  it("lightPixelSortDisplaceMapSvg is deterministic for same phase", () => {
    const a = lightPixelSortDisplaceMapSvg(90, 0.5, 64, 8, 1, 0, 320, 240);
    const b = lightPixelSortDisplaceMapSvg(90, 0.5, 64, 8, 1, 0, 320, 240);
    expect(a.uri).toBe(b.uri);
    expect(a.scale).toBe(128);
  });

  it("lightPixelSortDisplaceMapSvg changes with phase", () => {
    const a = lightPixelSortDisplaceMapSvg(90, 0.5, 64, 8, 1, 0, 320, 240);
    const b = lightPixelSortDisplaceMapSvg(90, 0.5, 64, 8, 1, 90, 320, 240);
    expect(a.uri).not.toBe(b.uri);
  });

  it("lightPixelSortFilter emits feDisplacementMap and luminance gate with base preserve", () => {
    const s = lightPixelSortFilter(90, 0.5, 64, 8, 1, 0, 320, 240);
    expect(s).toContain("feDisplacementMap");
    expect(s).toContain("luminanceToAlpha");
    expect(s).toContain('operator="in"');
    expect(s).toContain("feMerge");
    expect(s).toContain('in="base"');
    expect(s).toContain('scale="128"');
  });

  it("lightPixelSortFilter is inert when streakLength or intensity is 0", () => {
    expect(lightPixelSortFilter(90, 0.5, 0, 8, 1, 0, 320, 240)).toBe("");
    expect(lightPixelSortFilter(90, 0.5, 64, 8, 0, 0, 320, 240)).toBe("");
  });
});

describe("ripple radial displacement (§27.3)", () => {
  const R = 200;
  const FREQ = 5;

  it("displacement vector points along the radius (not a spiral)", () => {
    // 渦バグの回帰: 変位ベクトルは (dx,dy) と平行（外積≈0）でなければならない。
    const cases: [number, number][] = [[30, 0], [0, -40], [50, 70], [-90, 25], [-15, -120]];
    for (const [dx, dy] of cases) {
      const { x, y } = rippleDisplacementSample(dx, dy, R, FREQ, 0);
      const cross = dx * y - dy * x; // 平行なら 0
      const scale = Math.hypot(dx, dy) * Math.hypot(x, y);
      expect(Math.abs(cross)).toBeLessThanOrEqual(scale * 1e-9 + 1e-9);
    }
  });

  it("is zero at the center and outside the radius", () => {
    expect(rippleDisplacementSample(0, 0, R, FREQ, 0)).toEqual({ x: 0, y: 0 });
    expect(rippleDisplacementSample(R + 1, 0, R, FREQ, 0)).toEqual({ x: 0, y: 0 });
    expect(rippleDisplacementSample(R, 0, R, FREQ, 0)).toEqual({ x: 0, y: 0 });
  });

  it("magnitude decays toward the radius (envelope)", () => {
    // 同位相サンプルで内側の方が振幅が大きい（1 − dist/radius 包絡）。
    const inner = rippleDisplacementSample(R * 0.25, 0, R, 1, Math.PI / 2);
    const outer = rippleDisplacementSample(R * 0.75, 0, R, 1, Math.PI / 2);
    expect(Math.hypot(inner.x, inner.y)).toBeGreaterThan(Math.hypot(outer.x, outer.y));
  });

  it("rippleDisplaceMap emits a PNG feImage map with scale=2·amplitude", () => {
    const { uri, scale } = rippleDisplaceMap(R, 13, FREQ, 0.5, 0.5, 640, 480);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(scale).toBe(26);
  });

  it("rippleDisplaceMap caps map resolution but moves with center", () => {
    const a = rippleDisplaceMap(R, 10, FREQ, 0.25, 0.5, 1920, 1080);
    const b = rippleDisplaceMap(R, 10, FREQ, 0.75, 0.5, 1920, 1080);
    expect(a.uri).not.toBe(b.uri);
    // 長辺 1920 でも RIPPLE_MAP_MAX_DIM 以下に縮小されている（PNG が巨大化しない）。
    expect(RIPPLE_MAP_MAX_DIM).toBeLessThanOrEqual(256);
  });
});

describe("rgbaToPngDataUri (pure PNG encoder)", () => {
  it("produces a valid PNG signature and IHDR dimensions", () => {
    const w = 3;
    const h = 2;
    const rgba = new Uint8Array(w * h * 4).fill(200);
    const uri = rgbaToPngDataUri(rgba, w, h);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(uri.split(",")[1]!), (c) => c.charCodeAt(0));
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width/height（offset 16..24, big-endian）。
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(16)).toBe(w);
    expect(dv.getUint32(20)).toBe(h);
    // 末尾 IEND。
    expect([...bytes.slice(-8)]).toEqual([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });

  it("is deterministic", () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 9, 8, 7, 255]);
    expect(rgbaToPngDataUri(rgba, 2, 1)).toBe(rgbaToPngDataUri(rgba, 2, 1));
  });
});

describe("§27.4 distortion quality knob", () => {
  const ctx = { width: 1920, height: 1080, frame: 0 };

  it("rippleMapDims shrinks the generated map as quality drops (q=1 unchanged)", () => {
    const full = rippleMapDims(1920, 1080, 1);
    const half = rippleMapDims(1920, 1080, 0.5);
    const low = rippleMapDims(1920, 1080, 0.3);
    // q=1 は従来どおり長辺 RIPPLE_MAP_MAX_DIM 付近に張り付く。
    expect(Math.max(full.mw, full.mh)).toBe(RIPPLE_MAP_MAX_DIM);
    expect(Math.max(half.mw, half.mh)).toBeLessThan(Math.max(full.mw, full.mh));
    expect(Math.max(low.mw, low.mh)).toBeLessThan(Math.max(half.mw, half.mh));
    // 下限 16 を割らない。
    expect(Math.max(...Object.values(rippleMapDims(1920, 1080, 0.1)))).toBeGreaterThanOrEqual(16);
  });

  it("rippleDisplaceMap PNG resolution follows quality", () => {
    const full = pngDims(rippleDisplaceMap(200, 10, 5, 0.5, 0.5, 1920, 1080, 0, 1).uri);
    const low = pngDims(rippleDisplaceMap(200, 10, 5, 0.5, 0.5, 1920, 1080, 0, 0.3).uri);
    expect(Math.max(low.w, low.h)).toBeLessThan(Math.max(full.w, full.h));
  });

  it("rippleDisplaceMap is backward-compatible: omitted quality == quality 1", () => {
    const omitted = rippleDisplaceMap(200, 13, 5, 0.4, 0.6, 640, 480);
    const explicit = rippleDisplaceMap(200, 13, 5, 0.4, 0.6, 640, 480, 0, 1);
    expect(omitted.uri).toBe(explicit.uri);
    expect(omitted.scale).toBe(explicit.scale);
  });

  it("waveDisplaceMapSvg uses fewer gradient stops at lower quality (q=1 unchanged)", () => {
    const full = countStops(waveDisplaceMapSvg(20, 50, "horizontal", 0, 1920, 1080, 1).uri);
    const low = countStops(waveDisplaceMapSvg(20, 50, "horizontal", 0, 1920, 1080, 0.3).uri);
    expect(low).toBeLessThan(full);
    expect(low).toBeGreaterThanOrEqual(2);
  });

  it("waveDisplaceMapSvg is backward-compatible: omitted quality == quality 1", () => {
    const omitted = waveDisplaceMapSvg(20, 50, "horizontal", 30, 1920, 1080);
    const explicit = waveDisplaceMapSvg(20, 50, "horizontal", 30, 1920, 1080, 1);
    expect(omitted.uri).toBe(explicit.uri);
  });

  it("turbulentDisplace reduces numOctaves as quality drops (complexity·q)", () => {
    const full = TURBULENT_DISPLACE_EFFECT_DEF.apply({ amount: 50, complexity: 4, quality: 1 }, ctx);
    const low = TURBULENT_DISPLACE_EFFECT_DEF.apply({ amount: 50, complexity: 4, quality: 0.3 }, ctx);
    expect(full?.kind).toBe("svg");
    expect(low?.kind).toBe("svg");
    const fullOct = numOctavesOf((full as { primitives: string }).primitives);
    const lowOct = numOctavesOf((low as { primitives: string }).primitives);
    expect(fullOct).toBe(4); // complexity·1
    expect(lowOct).toBe(Math.max(1, Math.round(4 * 0.3))); // = 1
    expect(lowOct).toBeLessThan(fullOct);
  });

  it("turbulentDisplace octaves never drop below 1", () => {
    const r = TURBULENT_DISPLACE_EFFECT_DEF.apply({ amount: 50, complexity: 1, quality: 0.1 }, ctx);
    expect(numOctavesOf((r as { primitives: string }).primitives)).toBe(1);
  });

  it("effect defs are backward-compatible: omitted quality == quality 1", () => {
    const waveA = WAVE_EFFECT_DEF.apply({ amplitude: 20, wavelength: 50 }, ctx);
    const waveB = WAVE_EFFECT_DEF.apply({ amplitude: 20, wavelength: 50, quality: 1 }, ctx);
    expect(waveA).toEqual(waveB);

    const ripA = RIPPLE_EFFECT_DEF.apply({ amplitude: 10, radius: 200 }, ctx);
    const ripB = RIPPLE_EFFECT_DEF.apply({ amplitude: 10, radius: 200, quality: 1 }, ctx);
    expect(ripA).toEqual(ripB);

    const turbA = TURBULENT_DISPLACE_EFFECT_DEF.apply({ amount: 50, complexity: 3 }, ctx);
    const turbB = TURBULENT_DISPLACE_EFFECT_DEF.apply({ amount: 50, complexity: 3, quality: 1 }, ctx);
    expect(turbA).toEqual(turbB);
  });

  it("exposes a quality param on all three distortion effects", () => {
    for (const def of [WAVE_EFFECT_DEF, RIPPLE_EFFECT_DEF, TURBULENT_DISPLACE_EFFECT_DEF]) {
      const p = def.params.find((p) => p.key === "quality");
      expect(p).toBeDefined();
      expect(p?.default).toBe(1);
      expect(p?.min).toBe(0.1);
      expect(p?.max).toBe(1);
    }
  });
});

describe("§27.5 Fast distortion (approximate)", () => {
  it("DISPLACEMENT_EFFECT_TYPES includes fast variants", () => {
    expect(DISPLACEMENT_EFFECT_TYPES.has("fastWave")).toBe(true);
    expect(DISPLACEMENT_EFFECT_TYPES.has("fastRipple")).toBe(true);
    expect(DISPLACEMENT_EFFECT_TYPES.has("fastTurbulentDisplace")).toBe(true);
  });

  it("displaceWithMap antiAlias toggles feGaussianBlur", () => {
    const uri = "data:image/svg+xml,test";
    const on = displaceWithMap(uri, 20, 100, 100, true);
    const off = displaceWithMap(uri, 20, 100, 100, false);
    expect(on).toContain("feGaussianBlur");
    expect(off).not.toContain("feGaussianBlur");
  });

  it("§27.5 改定4: fastWaveDisplace は feTurbulence 直結（feImage なし）", () => {
    const p = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 0, w: 320, h: 240 });
    expect(p).toContain("feTurbulence");
    expect(p).toContain('type="fractalNoise"');
    expect(p).toContain("feDisplacementMap");
    expect(p).not.toContain("feImage");
    expect(p).not.toContain("data:image/svg+xml");
    // scale = 2·amplitude
    expect(p).toContain('scale="40"');
  });

  it("§27.5 改定4: fastWave direction で baseFrequency の異方軸が入れ替わる", () => {
    const horiz = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 0, w: 320, h: 240 });
    const vert = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "vertical", phaseDeg: 0, w: 320, h: 240 });
    const bf = (s: string) => /baseFrequency="([\d.]+) ([\d.]+)"/.exec(s);
    const mh = bf(horiz);
    const mv = bf(vert);
    expect(mh).not.toBeNull();
    expect(mv).not.toBeNull();
    // horizontal: 進行方向(X)が高周波。vertical: Y が高周波 → 軸が入れ替わる。
    expect(mh![1]).toBe(mv![2]);
    expect(mh![2]).toBe(mv![1]);
  });

  it("§27.5 改定4: fastWave phase は feOffset パンを生む", () => {
    const p0 = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 0, w: 320, h: 240 });
    const p180 = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 180, w: 320, h: 240 });
    expect(p0).not.toContain("feOffset");
    expect(p180).toContain("feOffset");
  });

  it("§27.5 改定4: fastRippleDisplace は feTurbulence 直結（feImage/PNG なし）", () => {
    const p = fastRippleDisplace({ radius: 100, amplitude: 10, frequency: 5, centerX: 0.5, centerY: 0.5, w: 640, h: 480 });
    expect(p).toContain("feTurbulence");
    expect(p).toContain('type="fractalNoise"');
    expect(p).toContain("feDisplacementMap");
    expect(p).not.toContain("feImage");
    expect(p).not.toContain("data:image");
    expect(p).toContain('scale="20"');
  });

  it("§27.5 改定4: fastRipple center は feOffset パンを生む", () => {
    const centered = fastRippleDisplace({ radius: 100, amplitude: 10, frequency: 5, centerX: 0.5, centerY: 0.5, w: 640, h: 480 });
    const offCenter = fastRippleDisplace({ radius: 100, amplitude: 10, frequency: 5, centerX: 0.8, centerY: 0.3, w: 640, h: 480 });
    expect(centered).not.toContain("feOffset");
    expect(offCenter).toContain("feOffset");
  });

  it("fastTurbulentDisplace uses fractalNoise with G bias", () => {
    const off = fastTurbulentDisplace({
      amount: 50, size: 100, complexity: 6, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0, w: 320, h: 240, antiAlias: false,
    });
    expect(off).toContain('type="fractalNoise"');
    expect(off).toContain('numOctaves="2"');
    expect(off).toContain(`intercept="${FRACTAL_NOISE_G_BIAS_INTERCEPT}"`);
    expect(off).toContain("feComponentTransfer");
    // 改定5: fastTurbulent は既存 region/stitch/pan を維持（map smoothing のみ追加）。
    expect(off).toContain('stitchTiles="stitch"');
    expect(off).toContain('width="320"'); // regionPad なし（生成域 = layer 実寸）
  });

  // ── §27.5 改定5: 見た目の動きを滑らかに（map smoothing 常時・phase 連続・regionPad） ──

  it("§27.5 改定5: Fast 3 種は antiAlias なしでも map smoothing(feGaussianBlur) を含む", () => {
    const wave = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 0, w: 320, h: 240 });
    const ripple = fastRippleDisplace({ radius: 100, amplitude: 10, frequency: 5, centerX: 0.5, centerY: 0.5, w: 640, h: 480 });
    const turb = fastTurbulentDisplace({ amount: 50, size: 100, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0, w: 320, h: 240 });
    for (const p of [wave, ripple, turb]) {
      expect(p).toContain("feGaussianBlur");
      // 軽量維持の回帰ガード: feImage / data URI を一切含まない。
      expect(p).not.toContain("feImage");
      expect(p).not.toContain("data:image");
    }
  });

  it("§27.5 改定5: fastWave は stitch を外した座標安定場（stitchTiles なし）", () => {
    const p = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 90, w: 320, h: 240 });
    expect(p).not.toContain("stitchTiles");
  });

  it("§27.5 改定5: fastWave phase パンに合わせ feTurbulence 生成域が対称拡張する", () => {
    // phaseDeg=180 → pan=(180/360)*50=25px → padX=27 → feTurbulence x="-27"。
    const p = fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: 180, w: 320, h: 240 });
    const m = /<feTurbulence[^>]*\bx="(-?\d+)"[^>]*\bwidth="(\d+)"/.exec(p);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(0); // 左へ拡張
    expect(Number(m![2])).toBeGreaterThan(320); // layer より広い
  });

  it("§27.5 改定5: fastWave phase は連続パン（旧 %360 折返しの段差ジャンプなし）", () => {
    const dxOf = (deg: number) => {
      const m = /<feOffset[^>]*\bdx="(-?[\d.]+)"/.exec(
        fastWaveDisplace({ amplitude: 20, wavelength: 50, direction: "horizontal", phaseDeg: deg, w: 320, h: 240 }),
      );
      return m ? Number(m[1]) : 0;
    };
    // 旧実装は 350°→370° で pan が ~λ 跳んだ。連続パンなら差は 1 周期分(λ)未満の小さな増分。
    const jump = Math.abs(dxOf(370) - dxOf(350));
    expect(jump).toBeLessThan(50 / 2);
  });

  it("§27.5 改定5: fastRipple は生成域を定数 pad 拡張し stitch を維持する", () => {
    const p = fastRippleDisplace({ radius: 100, amplitude: 10, frequency: 5, centerX: 0.5, centerY: 0.5, w: 640, h: 480 });
    expect(p).toContain('stitchTiles="stitch"');
    const m = /<feTurbulence[^>]*\bwidth="(\d+)"/.exec(p);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(640); // 0.5·w pad で layer より広い
  });
});
