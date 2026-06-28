import { describe, expect, it } from "vitest";
import { bendPhase, polaritySign, pulseCycleT, pulseModulation, PULSE_BEND_GAIN } from "../src/runtime/pulseScaleWave";

describe("pulseScaleWave", () => {
  it("bendPhase is neutral at 0", () => {
    expect(bendPhase(0.25, 0)).toBe(0.25);
  });

  it("stronger bend gain separates +/- on sawtooth ramp", () => {
    const t = 0.25;
    const neutral = pulseModulation("sawtooth", 0, t);
    const plus = pulseModulation("sawtooth", 0.5, t);
    const minus = pulseModulation("sawtooth", -0.5, t);
    expect(plus).toBeGreaterThan(neutral);
    expect(minus).toBeLessThan(neutral);
    // gain=4 で ±0.5 でも明確な差
    expect(plus - neutral).toBeGreaterThan(0.15);
    expect(neutral - minus).toBeGreaterThan(0.15);
  });

  it("bend at ±1 uses PULSE_BEND_GAIN in exponent", () => {
    expect(bendPhase(0.5, 1)).toBeCloseTo(Math.pow(0.5, 1 / (1 + PULSE_BEND_GAIN)), 8);
    expect(bendPhase(0.5, -1)).toBeCloseTo(Math.pow(0.5, 1 + PULSE_BEND_GAIN), 8);
  });

  it("phase offsets cycle position in degrees", () => {
    expect(pulseCycleT(0, 1, 0)).toBeCloseTo(0, 8);
    expect(pulseCycleT(0, 1, 90)).toBeCloseTo(0.25, 8);
    expect(pulseCycleT(0, 1, 360)).toBeCloseTo(0, 8);
    expect(pulseCycleT(0, 1, 450)).toBeCloseTo(0.25, 8);
  });

  it("polarity flips modulation sign", () => {
    const t = 0.25;
    expect(pulseModulation("sine", 0, t, "+")).toBeGreaterThan(0);
    expect(pulseModulation("sine", 0, t, "-")).toBeLessThan(0);
    expect(polaritySign("+")).toBe(1);
    expect(polaritySign("-")).toBe(-1);
  });
});
