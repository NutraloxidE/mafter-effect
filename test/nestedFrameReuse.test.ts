import { afterEach, describe, expect, it } from "vitest";
import type { TimelineComposition } from "../src/core/schema";
import {
  canReuseNestedFrame,
  type NestedRenderEpochs,
  type NestedRenderState,
} from "../src/runtime/nestedFrameReuse";

const comp = { id: "01NESTED", kind: "timeline" } as TimelineComposition;
const epochs: NestedRenderEpochs = { mode: 2, resource: 3, evaluator: 4, context: 5 };
const state: NestedRenderState = { ...epochs, comp, childFrame: 12, completed: true };

afterEach(() => {
  delete (globalThis as { __mafterNestedFrameReuse?: unknown }).__mafterNestedFrameReuse;
});

describe("same-child-frame subtree reuse guard", () => {
  it("reuses only an identical completed state with ready resources", () => {
    expect(canReuseNestedFrame(state, comp, 12, epochs, true)).toBe(true);
    expect(canReuseNestedFrame({ ...state, completed: false }, comp, 12, epochs, true)).toBe(false);
    expect(canReuseNestedFrame(state, comp, 12, epochs, false)).toBe(false);
  });

  it.each(["mode", "resource", "evaluator", "context"] as const)(
    "invalidates when the %s epoch changes",
    (key) => {
      expect(canReuseNestedFrame(state, comp, 12, { ...epochs, [key]: epochs[key] + 1 }, true)).toBe(false);
    },
  );

  it("does not share state across comp identity or child frame", () => {
    expect(canReuseNestedFrame(state, { ...comp }, 12, epochs, true)).toBe(false);
    expect(canReuseNestedFrame(state, comp, 13, epochs, true)).toBe(false);
  });

  it("honors the runtime kill switch", () => {
    (globalThis as { __mafterNestedFrameReuse?: unknown }).__mafterNestedFrameReuse = false;
    expect(canReuseNestedFrame(state, comp, 12, epochs, true)).toBe(false);
  });
});
