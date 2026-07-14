// 4 方向すべてで「帯が引いたソース列/行」と「smear の起点(seam)」を計測し、
// 要求ライン(line=round(linePos*n)) とのズレを出す。left/up は index 減少側なので
// 符号・丸めの非対称バグが出やすい。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5177";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 500 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");

  // 軸に沿って index を色符号化した source を作る（horiz は x, vert は y を符号化）。
  function makeSource(W, H, axis) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const idx = axis === "x" ? x : y;
      id.data[o] = idx % 256;
      id.data[o + 1] = 0;
      id.data[o + 2] = idx >= 256 ? 255 : 0;
      id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    return cv.toDataURL("image/png");
  }

  async function run(direction) {
    const horiz = direction === "right" || direction === "left";
    const W = horiz ? 400 : 20;
    const H = horiz ? 20 : 400;
    const n = horiz ? W : H;
    const linePos = 0.5, length = 120, density = 1;
    const line = Math.round(linePos * n);
    const src = makeSource(W, H, horiz ? "x" : "y");
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const rc = canvas.getContext("2d");
    const px = rc.getImageData(0, 0, W, H).data;
    const decode = (i) => {
      const [x, y] = horiz ? [i, H >> 1] : [W >> 1, i];
      const o = (y * W + x) * 4;
      return px[o + 3] === 0 ? -1 : px[o] + (px[o + 2] > 127 ? 256 : 0);
    };
    const decoded = [];
    for (let i = 0; i < n; i++) decoded.push(decode(i));
    // 帯側（forward=right/down は line 以降、left/up は line 以前）が引いた index の中央値
    const forward = direction === "right" || direction === "down";
    const samples = [];
    if (forward) for (let i = line + 20; i <= line + length - 20; i += 5) samples.push(decoded[i]);
    else for (let i = line - length + 20; i <= line - 20; i += 5) samples.push(decoded[i]);
    samples.sort((a, b) => a - b);
    const bandSrc = samples.length ? samples[samples.length >> 1] : null;
    return {
      direction, line, bandSrc,
      bandSrcMinusLine: bandSrc == null ? null : bandSrc - line,
      around: decoded.slice(line - 5, line + 6),
    };
  }

  return {
    right: await run("right"),
    left: await run("left"),
    down: await run("down"),
    up: await run("up"),
  };
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
