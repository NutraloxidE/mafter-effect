import { describe, expect, it } from "vitest";
import type { AnimatedProp } from "../src/core/schema";
import { staticProp } from "../src/core/props";
import { sampleScalar } from "../src/runtime/interpolate";
import { readGainProp, sampleGain, scheduleGainAutomation } from "../src/runtime/footageAudio";

/** setValueAtTime を記録する AudioParam スタブ。 */
function fakeParam() {
  const calls: { value: number; time: number }[] = [];
  return {
    value: 1,
    setValueAtTime(value: number, time: number) {
      this.value = value;
      calls.push({ value, time });
    },
    calls,
  };
}

const fps = 30;

describe("readGainProp / sampleGain (§11.4 / §11.5)", () => {
  it("normalizes a plain number to staticProp (backward compat)", () => {
    const prop = readGainProp(0.5);
    expect(prop).toEqual({ value: 0.5, keyframes: [] });
    expect(sampleGain(0.5, 0)).toBe(0.5);
  });

  it("defaults missing / non-numeric gain to 1", () => {
    expect(readGainProp(undefined)).toEqual({ value: 1, keyframes: [] });
    expect(readGainProp("x")).toEqual({ value: 1, keyframes: [] });
    expect(sampleGain(undefined, 0)).toBe(1);
  });

  it("passes through an AnimatedProp<number>", () => {
    const prop: AnimatedProp<number> = { value: 0.2, keyframes: [] };
    expect(readGainProp(prop)).toBe(prop);
  });

  it("clamps to 0..1", () => {
    expect(sampleGain(2, 0)).toBe(1);
    expect(sampleGain(-1, 0)).toBe(0);
  });
});

describe("scheduleGainAutomation frame-step parity with sampleScalar", () => {
  it("matches sampleScalar at every frame boundary for a linear ramp", () => {
    const gainProp: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 0, value: 0, easing: { type: "linear" } },
        { frame: 30, value: 1, easing: { type: "linear" } },
      ],
    };
    const param = fakeParam();
    scheduleGainAutomation(param, gainProp, { fps, exportStartFrame: 0, exportEndFrame: 30 });
    expect(param.calls).toHaveLength(30);
    for (const { value, time } of param.calls) {
      const f = Math.round(time * fps);
      expect(value).toBeCloseTo(Math.max(0, Math.min(1, sampleScalar(gainProp, f))), 6);
    }
  });

  it("flattens a hold segment (no ramp between KFs)", () => {
    const gainProp: AnimatedProp<number> = {
      value: 0.25,
      keyframes: [
        { frame: 0, value: 0.25, easing: { type: "hold" } },
        { frame: 15, value: 0.9, easing: { type: "linear" } },
      ],
    };
    const param = fakeParam();
    scheduleGainAutomation(param, gainProp, { fps, exportStartFrame: 0, exportEndFrame: 15 });
    // hold 区間は同一値の連打 → すべて 0.25
    for (const { value } of param.calls) {
      expect(value).toBeCloseTo(0.25, 6);
    }
  });

  it("works with a plain number gain (constant)", () => {
    const param = fakeParam();
    scheduleGainAutomation(param, readGainProp(0.5), { fps, exportStartFrame: 10, exportEndFrame: 13 });
    expect(param.calls.map((c) => c.value)).toEqual([0.5, 0.5, 0.5]);
    expect(param.calls.map((c) => c.time)).toEqual([0, 1 / fps, 2 / fps]);
  });

  it("honors a static default of 1", () => {
    const param = fakeParam();
    scheduleGainAutomation(param, staticProp(1), { fps, exportStartFrame: 0, exportEndFrame: 2 });
    expect(param.calls.every((c) => c.value === 1)).toBe(true);
  });
});
