import { describe, it, expect } from "vitest";
import type { Component } from "../src/core/schema";
import { rescaleFootageSourceOffset } from "../src/editor/layerSourceOffset";

describe("rescaleFootageSourceOffset (fps 違いコンプ間のコピペ)", () => {
  it("audio の trimStart を貼り付け先 fps 単位へ換算する（媒体時刻を保つ）", () => {
    // mafter-project(19) の実データ: 30fps の audio-master で trimStart=351（= 11.7s）を
    // カットし、15fps の audio-separated へコピペした状態。
    const src: Component[] = [{ type: "audio", props: { asset: "snd", trimStart: 351 } }];
    const out = rescaleFootageSourceOffset(src, 30, 15);
    expect(out).not.toBeNull();
    const trimStart = out![0]!.props.trimStart as number;
    expect(trimStart).toBe(176); // round(351 * 15 / 30) — 換算前は 351/15 = 23.4s から再生していた
    expect(trimStart / 15).toBeCloseTo(351 / 30, 1);
  });

  it("comp レイヤーの trimStart は子コンプ単位なので触らない", () => {
    const src: Component[] = [{ type: "comp", props: { compId: "inner", trimStart: 351 } }];
    expect(rescaleFootageSourceOffset(src, 30, 15)).toBeNull();
  });

  it("同 fps・trimStart=0 は変更なし（null）", () => {
    const same: Component[] = [{ type: "audio", props: { asset: "snd", trimStart: 351 } }];
    expect(rescaleFootageSourceOffset(same, 30, 30)).toBeNull();
    const zero: Component[] = [{ type: "video", props: { asset: "clip", trimStart: 0 } }];
    expect(rescaleFootageSourceOffset(zero, 30, 15)).toBeNull();
  });
});
