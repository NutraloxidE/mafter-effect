// stage2 が drop される条件（maxAbs===0 で stage1 単独 = len/255 ドリフト露出）を density×length で探索。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const H = 20;
  const rows = [];
  const lengths = [300, 600, 1000, 1500, 2000];
  const densities = [1, 0.98, 0.9, 0.75, 0.5, 0.25, 0.1, 0];
  for (const length of lengths) {
    const W = Math.max(600, Math.round(length * 2.2 + 300));
    for (const density of densities) {
      const m = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction: "right", linePos: 0.5, length, density });
      rows.push({ length, density, scale1: m.stage1.scale, hasStage2: !!m.stage2, stage2Scale: m.stage2?.scale ?? null });
    }
  }
  // stage2 が無く scale1>255（=len/255 ドリフト露出）のケースを抽出
  const drifting = rows.filter((r) => !r.hasStage2 && r.scale1 > 255);
  return { drifting, all: rows };
});
console.log("=== stage2-dropped WITH scale1>255 (len/255 drift exposed) ===");
console.log(JSON.stringify(out.drifting, null, 2));
console.log("=== full grid ===");
console.log(out.all.map((r) => `len=${r.length} dens=${r.density} s1=${r.scale1} stage2=${r.hasStage2}${r.hasStage2 ? "(s2=" + r.stage2Scale + ")" : ""}`).join("\n"));
await browser.close();
