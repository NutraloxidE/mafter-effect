import { describe, expect, it } from "vitest";
import {
  compTreeHasVideo,
  isMultiRenderContextEnabled,
  multiRenderContextCount,
  runOrderedMultiContext,
} from "../src/runtime/multiRenderContext";
import type { Project, TimelineComposition } from "../src/core/schema";

// canvas は不要なので識別用のタグ付きダミーを使う（driver は canvas を透過的に運ぶだけ）。
function fakeCanvas(frame: number): HTMLCanvasElement {
  return { __frame: frame } as unknown as HTMLCanvasElement;
}

function makeComp(id: string, objects: TimelineComposition["objects"]): TimelineComposition {
  return {
    id,
    kind: "timeline",
    name: id,
    width: 100,
    height: 100,
    fps: 30,
    duration: 60,
    background: { r: 0, g: 0, b: 0, a: 1 },
    objects,
  } as unknown as TimelineComposition;
}

function objWith(type: string, props: Record<string, unknown> = {}): TimelineComposition["objects"][number] {
  return { id: `o-${type}-${Math.random()}`, components: [{ type, props }] } as unknown as TimelineComposition["objects"][number];
}

describe("multiRenderContext flags", () => {
  it("isMultiRenderContextEnabled reflects the global flag", () => {
    const g = globalThis as { __mafterMultiRenderContext?: unknown };
    delete g.__mafterMultiRenderContext;
    expect(isMultiRenderContextEnabled()).toBe(false);
    g.__mafterMultiRenderContext = true;
    expect(isMultiRenderContextEnabled()).toBe(true);
    delete g.__mafterMultiRenderContext;
  });

  it("multiRenderContextCount clamps to 2..4 with default 2", () => {
    const g = globalThis as { __mafterMultiRenderContextCount?: unknown };
    delete g.__mafterMultiRenderContextCount;
    expect(multiRenderContextCount()).toBe(2);
    g.__mafterMultiRenderContextCount = 1;
    expect(multiRenderContextCount()).toBe(2);
    g.__mafterMultiRenderContextCount = 3;
    expect(multiRenderContextCount()).toBe(3);
    g.__mafterMultiRenderContextCount = 99;
    expect(multiRenderContextCount()).toBe(4);
    g.__mafterMultiRenderContextCount = 2.9;
    expect(multiRenderContextCount()).toBe(2);
    delete g.__mafterMultiRenderContextCount;
  });
});

describe("compTreeHasVideo", () => {
  it("detects a direct video component", () => {
    const comp = makeComp("c1", [objWith("solid"), objWith("video", { asset: "a1" })]);
    const project = { compositions: [comp] } as unknown as Project;
    expect(compTreeHasVideo(project, comp)).toBe(true);
  });

  it("returns false for video-less comps", () => {
    const comp = makeComp("c1", [objWith("solid"), objWith("text")]);
    const project = { compositions: [comp] } as unknown as Project;
    expect(compTreeHasVideo(project, comp)).toBe(false);
  });

  it("detects video nested through a comp reference", () => {
    const inner = makeComp("inner", [objWith("video", { asset: "a1" })]);
    const outer = makeComp("outer", [objWith("comp", { compId: "inner" })]);
    const project = { compositions: [inner, outer] } as unknown as Project;
    expect(compTreeHasVideo(project, outer)).toBe(true);
  });

  it("does not infinite-loop on cyclic comp references", () => {
    const a = makeComp("a", [objWith("comp", { compId: "b" })]);
    const b = makeComp("b", [objWith("comp", { compId: "a" })]);
    const project = { compositions: [a, b] } as unknown as Project;
    expect(compTreeHasVideo(project, a)).toBe(false);
  });
});

describe("runOrderedMultiContext", () => {
  it("emits frames in ascending order regardless of producer completion order", async () => {
    const total = 12;
    const N = 3;
    const emitted: number[] = [];
    // producer c ほど遅い。動的 pull なので担当は固定されず、速い producer が多く引く。
    const producers = Array.from({ length: N }, (_, c) => async (frame: number) => {
      await new Promise((r) => setTimeout(r, (c + 1) * 3 + ((frame * 7) % 5)));
      return fakeCanvas(frame);
    });
    const res = await runOrderedMultiContext({
      producers,
      totalFrames: total,
      startFrame: 100,
      onFrame: async (fi, canvas) => {
        expect((canvas as unknown as { __frame: number }).__frame).toBe(100 + fi);
        emitted.push(fi);
      },
      checkAbort: () => {},
    });
    expect(emitted).toEqual(Array.from({ length: total }, (_, i) => i));
    // 動的 pull: 合計は必ず全 frame で、速度差はそのまま担当数の差になる（静的な各 4 ではない）。
    expect(res.contextFrameCounts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(res.contextFrameCounts[0]!).toBeGreaterThanOrEqual(res.contextFrameCounts[2]!);
  });

  it("respects the bounded reorder window (never renders too far ahead of emit)", async () => {
    const total = 20;
    const N = 2;
    const maxReorderAhead = 4;
    let maxRenderedIndex = -1;
    let nextEmit = 0;
    let violation = false;
    const producers = Array.from({ length: N }, (_, c) => async (frame: number) => {
      const fi = frame; // startFrame 0
      maxRenderedIndex = Math.max(maxRenderedIndex, fi);
      // レンダリング着手時点で emit 済み位置から maxReorderAhead 以上先を描いていないこと。
      if (fi - nextEmit >= maxReorderAhead) violation = true;
      await new Promise((r) => setTimeout(r, c === 0 ? 1 : 8));
      return fakeCanvas(fi);
    });
    await runOrderedMultiContext({
      producers,
      totalFrames: total,
      startFrame: 0,
      maxReorderAhead,
      onFrame: async (fi) => {
        await new Promise((r) => setTimeout(r, 2));
        nextEmit = fi + 1;
      },
      checkAbort: () => {},
    });
    expect(violation).toBe(false);
    expect(maxRenderedIndex).toBe(total - 1);
  });

  it("propagates a producer error and stops", async () => {
    const producers = [
      // producer 0 は偶数 frame を担当。担当 frame の一つで throw する。
      async (frame: number) => {
        if (frame === 4) throw new Error("boom");
        return fakeCanvas(frame);
      },
      async (frame: number) => fakeCanvas(frame),
    ];
    await expect(runOrderedMultiContext({
      producers,
      totalFrames: 10,
      startFrame: 0,
      onFrame: async () => {},
      checkAbort: () => {},
    })).rejects.toThrow("boom");
  });

  it("propagates an abort thrown from checkAbort", async () => {
    let calls = 0;
    const producers = [
      async (frame: number) => fakeCanvas(frame),
      async (frame: number) => fakeCanvas(frame),
    ];
    await expect(runOrderedMultiContext({
      producers,
      totalFrames: 10,
      startFrame: 0,
      onFrame: async () => {
        calls++;
        if (calls >= 2) throw new Error("aborted");
      },
      checkAbort: () => {},
    })).rejects.toThrow("aborted");
  });

  it("takes work off a stalled producer once the queue is empty", async () => {
    const total = 32;
    const rendered: number[][] = [[], []];
    let release: null | (() => void) = null;
    const setRelease = (fn: () => void): void => { release = fn; };
    const producers = [
      // Producer 0 stalls partway through its block until the test releases it.
      async (frame: number) => {
        rendered[0]!.push(frame);
        if (frame === 1) await new Promise<void>((r) => setRelease(r));
        return fakeCanvas(frame);
      },
      async (frame: number) => {
        rendered[1]!.push(frame);
        return fakeCanvas(frame);
      },
    ];

    const emitted: number[] = [];
    const run = runOrderedMultiContext({
      producers,
      totalFrames: total,
      startFrame: 0,
      blockFrames: 8,
      maxReorderAhead: 64,
      onFrame: async (fi) => { emitted.push(fi); },
      checkAbort: () => {},
    });
    // Release only once the fast producer has drained every unclaimed block and had to steal.
    for (let i = 0; i < 200 && rendered[1]!.length < total - 8; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    (release as null | (() => void))?.();
    await run;

    expect(emitted).toEqual(Array.from({ length: total }, (_, i) => i));
    // Every frame produced exactly once, across both producers.
    const all = [...rendered[0]!, ...rendered[1]!].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: total }, (_, i) => i));
    // The fast producer ended up with far more than its blocks, i.e. it stole.
    expect(rendered[1]!.length).toBeGreaterThan(total * 0.6);
    // The stalled producer keeps the frame it was on and loses only untouched ones.
    expect(rendered[0]!).toContain(1);
  });
});
