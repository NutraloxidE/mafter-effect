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

  it("linearWipeMask returns empty string at completion 1", () => {
    expect(linearWipeMask(1, 0, 0, 1920, 1080)).toBe("");
  });

  it("angularWipeMask includes path for partial completion", () => {
    const s = angularWipeMask(0.5, 0, 0.5, 0.5, 0, 1920, 1080);
    expect(s).toContain("path");
    expect(s).toContain("feComposite");
  });
});
