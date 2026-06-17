import { describe, expect, it } from "vitest";
import type { AnimatedProp } from "../src/core/schema";
import { applyEaseModeToProp } from "../src/editor/easingApply";

function propWithKfs(): AnimatedProp<number> {
  return {
    value: 0,
    keyframes: [
      { frame: 0, value: 0, easing: { type: "linear" } },
      { frame: 10, value: 100, easing: { type: "linear" } },
      { frame: 20, value: 200, easing: { type: "linear" } },
    ],
  };
}

const PRESET: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

describe("applyEaseModeToProp (§24.2)", () => {
  it("out: sets selected KF easing to full bezier (not last KF)", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([10]), "out", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[0]!.easing).toEqual({ type: "linear" });
    expect(next.keyframes[1]!.easing).toEqual({ type: "bezier", bezier: PRESET });
    expect(next.keyframes[2]!.easing).toEqual({ type: "linear" });
  });

  it("out: no-op on last KF", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([20]), "out", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[2]!.easing).toEqual({ type: "linear" });
  });

  it("in: replaces previous KF (x2,y2) after linear→bezier conversion", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([10]), "in", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[0]!.easing).toEqual({
      type: "bezier",
      bezier: [0, 0, PRESET[2], PRESET[3]],
    });
  });

  it("in: no-op on first KF", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([0]), "in", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[0]!.easing).toEqual({ type: "linear" });
  });

  it("both: applies in and out on middle KF", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([10]), "both", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[0]!.easing).toEqual({
      type: "bezier",
      bezier: [0, 0, PRESET[2], PRESET[3]],
    });
    expect(next.keyframes[1]!.easing).toEqual({ type: "bezier", bezier: PRESET });
  });

  it("out linear preset sets { type: linear }", () => {
    const next = applyEaseModeToProp(propWithKfs(), new Set([0]), "out", { kind: "linear" });
    expect(next.keyframes[0]!.easing).toEqual({ type: "linear" });
  });
});

describe("applyEaseModeToProp — hold conversion (§24.2 / §22.1)", () => {
  it("in: converts hold on previous KF to bezier before (x2,y2) replace", () => {
    const prop: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 0, value: 0, easing: { type: "hold" } },
        { frame: 10, value: 100, easing: { type: "linear" } },
      ],
    };
    const next = applyEaseModeToProp(prop, new Set([10]), "in", { kind: "bezier", bezier: PRESET });
    expect(next.keyframes[0]!.easing).toEqual({
      type: "bezier",
      bezier: [0, 0, PRESET[2], PRESET[3]],
    });
  });
});
