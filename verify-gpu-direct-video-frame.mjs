// GPU compositor の最終 WebGL canvas と従来の Canvas2D copy から作った VideoFrame が一致するか検証する。
// `npm run dev` 起動後に実行。非透過 video export の encoder 直結回帰ゲート。

import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });

const result = await page.evaluate(async () => {
  const { WebGl2Compositor } = await import("/src/runtime/compositor/WebGL2Compositor.ts");
  const W = 320, H = 180;
  const layer = (paint) => {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    paint(canvas.getContext("2d"));
    return canvas;
  };
  const a = layer((g) => {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#d22b7d"); grad.addColorStop(1, "#146dd8");
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
  });
  const b = layer((g) => {
    g.fillStyle = "rgba(40,230,120,.72)"; g.fillRect(37, 24, 210, 116);
    g.fillStyle = "rgba(250,180,20,.43)"; g.beginPath(); g.arc(220, 92, 63, 0, Math.PI * 2); g.fill();
  });

  const snapshot = async (direct, blend) => {
    const compositor = new WebGl2Compositor(W, H, "#10131a");
    if (blend) {
      compositor.drawLayerBlend(a, "normal");
      compositor.drawLayerBlend(b, "overlay");
    } else {
      compositor.drawLayer(a, "normal");
      compositor.drawLayer(b, "normal");
    }
    const frame = new VideoFrame(compositor.finish(!direct), { timestamp: 0 });
    try {
      const bytes = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
      await frame.copyTo(bytes, { format: "RGBA" });
      return bytes;
    } finally {
      frame.close();
    }
  };

  const compare = async (blend) => {
    const direct = await snapshot(true, blend);
    const copied = await snapshot(false, blend);
    let maxAbs = 0, sum = 0, differing = 0;
    for (let i = 0; i < direct.length; i++) {
      const d = Math.abs(direct[i] - copied[i]);
      maxAbs = Math.max(maxAbs, d); sum += d;
      if (d !== 0) differing++;
    }
    return { maxAbs, meanAbs: sum / direct.length, differing, samples: direct.length };
  };

  return { normal: await compare(false), blend: await compare(true) };
});

await browser.close();
console.log(JSON.stringify(result, null, 2));
const failed = Object.values(result).some((r) => r.maxAbs !== 0 || r.differing !== 0);
if (failed) {
  console.error("GPU DIRECT VIDEOFRAME PARITY FAIL");
  process.exit(1);
}
console.log("GPU DIRECT VIDEOFRAME PARITY PASS");
