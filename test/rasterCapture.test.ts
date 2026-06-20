import { describe, expect, it } from "vitest";
import { buildFilteredImageSvg } from "../src/runtime/rasterCapture";

// §27 Blur 回帰: raster/displacement と blur を併用すると blur（CSS filter token）が
// rasterizeFilteredImage で捨てられていた（filter="url(#id)" 単一参照 + 引数 _filterStr 無視）。
// 修正後は filter chain 全体を <image> の CSS filter property に通す。
describe("buildFilteredImageSvg — filter chain は捨てられない（§27 Blur 回帰）", () => {
  it("CSS filter token（blur）と url(#svg) 参照の両方を image の filter に通す", () => {
    const svg = buildFilteredImageSvg(
      "data:image/png;base64,AAAA",
      100,
      80,
      `<filter id="fx-wave"><feDisplacementMap/></filter>`,
      "blur(28px) url(#fx-wave)",
    );
    expect(svg).toContain('style="filter:blur(28px) url(#fx-wave)"');
    // 単一 filterId 参照（filter="url(#id)" だけ）へ退行していないこと
    expect(svg).not.toContain('filter="url(#fx-wave)"');
  });

  it("displacement のみ（CSS token なし）でも url 参照を保つ", () => {
    const svg = buildFilteredImageSvg("data:x", 10, 10, "<filter id='w'></filter>", "url(#w)");
    expect(svg).toContain('style="filter:url(#w)"');
  });

  it("複数 filter を記述順（左→右）でそのまま並べる", () => {
    const svg = buildFilteredImageSvg("data:x", 10, 10, "", "url(#w) blur(4px)");
    expect(svg).toContain('style="filter:url(#w) blur(4px)"');
  });

  it("defs に filtersMarkup を埋め込み、寸法を反映する", () => {
    const svg = buildFilteredImageSvg("data:x", 64, 48, "<filter id='w'>M</filter>", "url(#w)");
    expect(svg).toContain("<defs><filter id='w'>M</filter></defs>");
    expect(svg).toContain('width="64" height="48"');
  });
});
