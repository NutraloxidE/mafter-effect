import { describe, expect, it, vi } from "vitest";
import {
  dispatchSplitAlphaComposite,
  shouldCreateGlAlphaCompositor,
  type GlAlphaCompositor,
} from "../src/runtime/videoAlphaGl";

describe("shouldCreateGlAlphaCompositor", () => {
  it("does not recreate when a compositor already exists for the canvas", () => {
    expect(
      shouldCreateGlAlphaCompositor({
        alreadyHasCompositor: true,
        activeCount: 0,
        maxContexts: 8,
        killSwitchActive: false,
      }),
    ).toBe(false);
  });

  it("refuses when the kill switch is active, even with budget available", () => {
    expect(
      shouldCreateGlAlphaCompositor({
        alreadyHasCompositor: false,
        activeCount: 0,
        maxContexts: 8,
        killSwitchActive: true,
      }),
    ).toBe(false);
  });

  it("allows creation when under budget and no kill switch", () => {
    expect(
      shouldCreateGlAlphaCompositor({
        alreadyHasCompositor: false,
        activeCount: 3,
        maxContexts: 8,
        killSwitchActive: false,
      }),
    ).toBe(true);
  });

  it("refuses once the active count reaches the budget (safety margin against the browser's context limit)", () => {
    expect(
      shouldCreateGlAlphaCompositor({
        alreadyHasCompositor: false,
        activeCount: 8,
        maxContexts: 8,
        killSwitchActive: false,
      }),
    ).toBe(false);
  });
});

function fakeCompositor(broken: boolean): GlAlphaCompositor {
  return {
    compositeSplit: vi.fn(() => true),
    compositePacked: vi.fn(() => true),
    broken,
    dispose: vi.fn(),
  };
}

describe("dispatchSplitAlphaComposite", () => {
  it("uses the GL thunk when a live (non-broken) compositor is present", () => {
    const gl = fakeCompositor(false);
    const glThunk = vi.fn(() => true);
    const cpuThunk = vi.fn(() => true);
    const result = dispatchSplitAlphaComposite(gl, glThunk, cpuThunk);
    expect(result).toBe(true);
    expect(glThunk).toHaveBeenCalledTimes(1);
    expect(cpuThunk).not.toHaveBeenCalled();
  });

  it("falls back to CPU once the compositor is broken (context lost)", () => {
    const gl = fakeCompositor(true);
    const glThunk = vi.fn(() => true);
    const cpuThunk = vi.fn(() => true);
    const result = dispatchSplitAlphaComposite(gl, glThunk, cpuThunk);
    expect(result).toBe(true);
    expect(glThunk).not.toHaveBeenCalled();
    expect(cpuThunk).toHaveBeenCalledTimes(1);
  });

  it("falls back to CPU when no compositor was ever created (getContext failed / killswitch / over budget)", () => {
    const glThunk = vi.fn(() => true);
    const cpuThunk = vi.fn(() => true);
    const result = dispatchSplitAlphaComposite(null, glThunk, cpuThunk);
    expect(result).toBe(true);
    expect(glThunk).not.toHaveBeenCalled();
    expect(cpuThunk).toHaveBeenCalledTimes(1);
  });

  it("propagates a false (not-ready) result from the GL thunk without falling back to CPU", () => {
    // 両ソース ready でないときの false は「CPU にフォールバック」ではなく「この回は未描画」の意味。
    // compositeSplitAlpha は GL canvas 上で 2D コンテキストを取れないため CPU 経路には落とせない。
    const gl = fakeCompositor(false);
    const glThunk = vi.fn(() => false);
    const cpuThunk = vi.fn(() => true);
    const result = dispatchSplitAlphaComposite(gl, glThunk, cpuThunk);
    expect(result).toBe(false);
    expect(glThunk).toHaveBeenCalledTimes(1);
    expect(cpuThunk).not.toHaveBeenCalled();
  });
});
