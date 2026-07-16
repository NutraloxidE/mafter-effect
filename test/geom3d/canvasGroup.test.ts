import { describe, expect, it } from "vitest";
import { isTransparentToGeom3DChain, resolveGeom3DCanvasHosts, toGeom3DLayerInfo, type Geom3DLayerInfo } from "../../src/runtime/geom3d/geom3dCanvasGroup";

// zOrder 昇順 = 下→上（resolve.ts と同じ規約）。
function webgl(id: string, zOrder: number, share: boolean): Geom3DLayerInfo {
  return { id, zOrder, transparentToChain: false, webgl: true, share };
}
function plain(id: string, zOrder: number): Geom3DLayerInfo {
  return { id, zOrder, transparentToChain: false, webgl: false, share: false };
}
function passthrough(id: string, zOrder: number): Geom3DLayerInfo {
  return { id, zOrder, transparentToChain: true, webgl: false, share: false };
}

describe("resolveGeom3DCanvasHosts (§5.5f-1)", () => {
  it("share OFF は常に自分が host", () => {
    const hosts = resolveGeom3DCanvasHosts([webgl("a", 0, false), webgl("b", 1, false)]);
    expect(hosts.get("a")).toBe("a");
    expect(hosts.get("b")).toBe("b");
  });

  it("share ON は直上の WebGL レイヤーへ合流し、最上位まで推移的に解決する", () => {
    const hosts = resolveGeom3DCanvasHosts([webgl("a", 0, true), webgl("b", 1, true), webgl("c", 2, false)]);
    expect(hosts.get("a")).toBe("c");
    expect(hosts.get("b")).toBe("c");
    expect(hosts.get("c")).toBe("c");
  });

  it("Null / 音声のみのレイヤーは透過してスキップする", () => {
    const hosts = resolveGeom3DCanvasHosts([webgl("a", 0, true), passthrough("null", 1), webgl("top", 2, false)]);
    expect(hosts.get("a")).toBe("top");
  });

  it("間に非 WebGL の描画レイヤーがあるとチェーンが切れ、自分が host になる", () => {
    const hosts = resolveGeom3DCanvasHosts([webgl("a", 0, true), plain("solid", 1), webgl("top", 2, false)]);
    expect(hosts.get("a")).toBe("a");
  });

  it("share ON でも最上位なら自分が host", () => {
    const hosts = resolveGeom3DCanvasHosts([plain("solid", 0), webgl("a", 1, true)]);
    expect(hosts.get("a")).toBe("a");
  });

  it("非 WebGL レイヤーはキーに含まれない", () => {
    const hosts = resolveGeom3DCanvasHosts([plain("solid", 0), webgl("a", 1, true)]);
    expect(hosts.has("solid")).toBe(false);
  });

  it("入力順に依存せず zOrder で解決する", () => {
    const hosts = resolveGeom3DCanvasHosts([webgl("c", 2, false), webgl("a", 0, true), webgl("b", 1, true)]);
    expect(hosts.get("a")).toBe("c");
    expect(hosts.get("b")).toBe("c");
  });
});

describe("toGeom3DLayerInfo", () => {
  const text = (props: Record<string, unknown>) => ({ type: "text", props });

  it("geomEnabled の text レイヤーを WebGL として拾い share を読む", () => {
    const info = toGeom3DLayerInfo({
      id: "a", zOrder: 3, components: [text({ geomEnabled: true, geomShareCanvas: true })],
    });
    expect(info).toEqual({ id: "a", zOrder: 3, transparentToChain: false, webgl: true, share: true });
  });

  it("geomEnabled=false の text は WebGL ではない（share も立たない）", () => {
    const info = toGeom3DLayerInfo({
      id: "a", zOrder: 0, components: [text({ geomEnabled: false, geomShareCanvas: true })],
    });
    expect(info.webgl).toBe(false);
    expect(info.share).toBe(false);
  });

  it("Null レイヤーは透過扱いになる", () => {
    expect(toGeom3DLayerInfo({ id: "n", zOrder: 1, isNull: true, components: [] }).transparentToChain).toBe(true);
  });
});

describe("isTransparentToGeom3DChain", () => {
  it("Null レイヤーは透過", () => {
    expect(isTransparentToGeom3DChain(true, ["solid"])).toBe(true);
  });
  it("全 component が audio なら透過", () => {
    expect(isTransparentToGeom3DChain(false, ["audio"])).toBe(true);
  });
  it("audio + 描画 component の混在は透過しない", () => {
    expect(isTransparentToGeom3DChain(false, ["audio", "video"])).toBe(false);
  });
  it("component 無しは透過しない（描画レイヤー扱い）", () => {
    expect(isTransparentToGeom3DChain(false, [])).toBe(false);
  });
});
