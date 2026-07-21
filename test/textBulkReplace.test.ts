import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { AnimatedProp, SceneObject } from "../src/core/schema";
import {
  buildReplacedObjects,
  computeReadingOrder,
  planBulkReplace,
  tokenize,
} from "../src/editor/macros/textBulkReplace";

function textObject(id: string, text: unknown): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "text", props: { text } }],
  };
}

describe("tokenize", () => {
  it("char mode splits into single characters (Japanese)", () => {
    expect(tokenize("りんご", "char")).toEqual(["り", "ん", "ご"]);
  });
  it("word mode splits on whitespace (English)", () => {
    expect(tokenize("  the  quick brown ", "word")).toEqual(["the", "quick", "brown"]);
  });
  it("empty input yields no tokens", () => {
    expect(tokenize("   ", "char")).toEqual([]);
    expect(tokenize("", "word")).toEqual([]);
  });
});

describe("planBulkReplace — number = 1-based token index", () => {
  it("char mode assigns each character to its numbered layer", () => {
    const objs = [textObject("a", staticProp("1")), textObject("b", staticProp("2")), textObject("c", staticProp("3"))];
    const plan = planBulkReplace(objs, "あいう", "char");
    expect(plan.assignments.map((x) => [x.number, x.newText])).toEqual([
      [1, "あ"],
      [2, "い"],
      [3, "う"],
    ]);
    expect(plan.unmatchedNumbers).toEqual([]);
    expect(plan.unusedTokens).toEqual([]);
  });

  it("word mode assigns words by number", () => {
    const objs = [textObject("a", staticProp("1")), textObject("b", staticProp("2")), textObject("c", staticProp("3"))];
    const plan = planBulkReplace(objs, "a b c", "word");
    expect(plan.assignments.map((x) => x.newText)).toEqual(["a", "b", "c"]);
  });

  it("gaps: layer numbered 3 still gets token[2] even if 2 is missing", () => {
    const objs = [textObject("a", staticProp("1")), textObject("c", staticProp("3"))];
    const plan = planBulkReplace(objs, "x y z", "word");
    expect(plan.assignments.map((x) => [x.number, x.newText])).toEqual([
      [1, "x"],
      [3, "z"],
    ]);
    // "y" (index 1) went to no layer → unused
    expect(plan.unusedTokens).toEqual(["y"]);
  });

  it("duplicate numbers get the same token", () => {
    const objs = [textObject("a", staticProp("2")), textObject("b", staticProp("2"))];
    const plan = planBulkReplace(objs, "p q r", "word");
    expect(plan.assignments.map((x) => x.newText)).toEqual(["q", "q"]);
  });

  it("more layers than tokens: extra numbers unmatched", () => {
    const objs = [textObject("a", staticProp("1")), textObject("b", staticProp("2")), textObject("c", staticProp("3"))];
    const plan = planBulkReplace(objs, "only", "word");
    expect(plan.assignments.map((x) => x.newText)).toEqual(["only"]);
    expect(plan.unmatchedNumbers).toEqual([2, 3]);
    expect(plan.targetCount).toBe(3);
  });

  it("non-integer text and mixed like '1a' are not targets", () => {
    const objs = [textObject("a", staticProp("abc")), textObject("b", staticProp("1a")), textObject("c", staticProp(" 1 "))];
    const plan = planBulkReplace(objs, "w x y z", "word");
    // only "c" (trims to "1") is a target
    expect(plan.assignments.map((x) => x.objectId)).toEqual(["c"]);
    expect(plan.assignments[0]!.newText).toBe("w");
  });

  it("keyframed or expression text is skipped with reason", () => {
    const kf: AnimatedProp<string> = { value: "1", keyframes: [{ frame: 0, value: "1" } as never] };
    const expr: AnimatedProp<string> = { value: "2", keyframes: [], expression: { source: "x" } as never };
    const objs = [textObject("a", kf), textObject("b", expr), textObject("c", staticProp("3"))];
    const plan = planBulkReplace(objs, "p q r", "word");
    expect(plan.skipped.map((s) => [s.number, s.reason])).toEqual([
      [1, "animated"],
      [2, "expression"],
    ]);
    expect(plan.assignments.map((x) => x.objectId)).toEqual(["c"]);
  });

  it("supports raw string text prop (not AnimatedProp)", () => {
    const objs = [textObject("a", "1"), textObject("b", "2")];
    const plan = planBulkReplace(objs, "hi", "char");
    expect(plan.assignments.map((x) => x.newText)).toEqual(["h", "i"]);
  });
});

describe("computeReadingOrder — top-left → row → bottom-right", () => {
  it("orders a 2x2 grid row-major regardless of input order", () => {
    const entries = [
      { objectId: "br", x: 100, y: 100 },
      { objectId: "tl", x: 0, y: 0 },
      { objectId: "tr", x: 100, y: 0 },
      { objectId: "bl", x: 0, y: 100 },
    ];
    expect(computeReadingOrder(entries)).toEqual(["tl", "tr", "bl", "br"]);
  });

  it("treats near-equal y (within tolerance) as the same row", () => {
    const entries = [
      { objectId: "a", x: 0, y: 0 },
      { objectId: "b", x: 50, y: 10 }, // jitter < 24 → same row
      { objectId: "c", x: 0, y: 200 },
    ];
    expect(computeReadingOrder(entries, 24)).toEqual(["a", "b", "c"]);
  });

  it("splits rows when y differs beyond tolerance", () => {
    const entries = [
      { objectId: "low", x: 0, y: 40 },
      { objectId: "high", x: 100, y: 0 },
    ];
    // high (y=0) is its own row above low (y=40)
    expect(computeReadingOrder(entries, 24)).toEqual(["high", "low"]);
  });

  it("is deterministic for identical positions (tiebreak by id)", () => {
    const entries = [
      { objectId: "z", x: 0, y: 0 },
      { objectId: "a", x: 0, y: 0 },
    ];
    expect(computeReadingOrder(entries)).toEqual(["a", "z"]);
  });
});

describe("planBulkReplace — reading order mode", () => {
  it("numbers non-numeric text layers by reading order and replaces", () => {
    const objs = [
      textObject("br", staticProp("dog")),
      textObject("tl", staticProp("apple")),
      textObject("tr", staticProp("banana")),
    ];
    const positions = new Map([
      ["br", { x: 100, y: 100 }],
      ["tl", { x: 0, y: 0 }],
      ["tr", { x: 100, y: 0 }],
    ]);
    const plan = planBulkReplace(objs, "one two three", "word", "reading", positions);
    // reading order: tl(#1), tr(#2), br(#3) — assignments 配列は object 順なので number でソートして検証
    const sorted = [...plan.assignments].sort((a, b) => a.number - b.number);
    expect(sorted.map((a) => [a.objectId, a.number, a.newText])).toEqual([
      ["tl", 1, "one"],
      ["tr", 2, "two"],
      ["br", 3, "three"],
    ]);
  });

  it("excludes layers with no position (not visible at frame)", () => {
    const objs = [textObject("a", staticProp("x")), textObject("b", staticProp("y"))];
    const positions = new Map([["a", { x: 0, y: 0 }]]); // b missing
    const plan = planBulkReplace(objs, "p q", "word", "reading", positions);
    expect(plan.assignments.map((a) => a.objectId)).toEqual(["a"]);
    expect(plan.targetCount).toBe(1);
  });

  it("skips keyframed/expression text even in reading mode", () => {
    const kf = { value: "x", keyframes: [{ frame: 0, value: "x" } as never] };
    const objs = [textObject("a", kf), textObject("b", staticProp("y"))];
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 0, y: 100 }],
    ]);
    const plan = planBulkReplace(objs, "p q", "word", "reading", positions);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["animated"]);
    expect(plan.assignments.map((a) => [a.objectId, a.newText])).toEqual([["b", "p"]]);
  });
});

describe("buildReplacedObjects — preserves shape & other props", () => {
  it("replaces only value of AnimatedProp text, keeps keyframes array reference shape", () => {
    const objs = [textObject("a", { value: "1", keyframes: [], expression: undefined } as AnimatedProp<string>)];
    const plan = planBulkReplace(objs, "z", "char");
    const next = buildReplacedObjects(objs, plan.assignments);
    const prop = next[0]!.components[0]!.props["text"] as AnimatedProp<string>;
    expect(prop.value).toBe("z");
    expect(prop.keyframes).toEqual([]);
    // original untouched (immutability)
    expect((objs[0]!.components[0]!.props["text"] as AnimatedProp<string>).value).toBe("1");
  });

  it("no assignments returns the same array reference", () => {
    const objs = [textObject("a", staticProp("abc"))];
    const plan = planBulkReplace(objs, "z", "char");
    expect(buildReplacedObjects(objs, plan.assignments)).toBe(objs);
  });

  it("replaces raw string text prop", () => {
    const objs = [textObject("a", "1")];
    const plan = planBulkReplace(objs, "q", "char");
    const next = buildReplacedObjects(objs, plan.assignments);
    expect(next[0]!.components[0]!.props["text"]).toBe("q");
  });
});
