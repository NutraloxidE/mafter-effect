import { describe, expect, it } from "vitest";
import {
  angularWipeMask,
  linearWipeMask,
  phaseToSeed,
  sizeToFrequency,
  turbulenceDisplace,
  wavelengthToFrequency,
} from "../src/runtime/effectSvg";

describe("effectSvg helpers", () => {
  it("wavelengthToFrequency inverts wavelength", () => {
    expect(wavelengthToFrequency(50)).toBeCloseTo(0.02);
    expect(wavelengthToFrequency(100)).toBeCloseTo(0.01);
  });

  it("sizeToFrequency decreases with larger size", () => {
    expect(sizeToFrequency(10)).toBeGreaterThan(sizeToFrequency(100));
  });

  it("phaseToSeed is deterministic", () => {
    expect(phaseToSeed(90)).toBe(phaseToSeed(90));
    expect(phaseToSeed(0)).not.toBe(phaseToSeed(180));
  });

  it("turbulenceDisplace emits feTurbulence and feDisplacementMap", () => {
    const s = turbulenceDisplace({ scale: 10, baseFrequencyX: 0.02, baseFrequencyY: 0.02, seed: 42 });
    expect(s).toContain("feTurbulence");
    expect(s).toContain('scale="10"');
  });

  it("linearWipeMask returns empty string at completion 0 (AE: inert)", () => {
    expect(linearWipeMask(0, 0, 0, 1920, 1080)).toBe("");
  });

  it("linearWipeMask converts luminance to alpha for partial completion", () => {
    const s = linearWipeMask(0.5, 0, 0, 1920, 1080);
    expect(s).toContain("luminanceToAlpha");
    expect(s).toContain('operator="in"');
  });

  it("linearWipeMask accepts angles outside 0..360", () => {
    const neg = linearWipeMask(0.5, -45, 0, 1920, 1080);
    const over = linearWipeMask(0.5, 405, 0, 1920, 1080);
    expect(neg).toContain("rotate(-45");
    expect(over).toContain("rotate(405");
    expect(neg).toContain("luminanceToAlpha");
    expect(over).toContain("luminanceToAlpha");
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
});
