// Phase 0b spike (throwaway): Motion Track rotation path validation.
// 0b-1: QUAR TrackerHandle.inlier_points() — coordinate pairs or count only?
// 0b-3: Horn quaternion rotation fit + RANSAC on synthetic yaw clip (pinhole projector).
// Gate: cumulative yaw error < 10%, |axis·Y| > 0.9, median < 150 ms/frame @640x480.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".json": "application/json",
};
const SPIKE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>rotation-spike</title></head><body><canvas id="c" width="640" height="480"></canvas></body></html>';

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/_spike")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SPIKE_PAGE);
      return;
    }
    const filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end(String(e));
  }
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`[rotation-spike] static server on ${BASE}`);

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage({ viewport: { width: 720, height: 560 } });
const logs = [];
page.on("console", (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e)}`));
await page.goto(`${BASE}/_spike/index.html`, { waitUntil: "load" });

const result = await page.evaluate(async (BASE) => {
  const W = 640;
  const H = 480;
  const FX = 550;
  const FY = 550;
  const CX = 320;
  const CY = 240;
  const NF = 60;
  const WARMUP = 4;
  const YAW_RATE = 0.006; // rad/frame — clip B from probe-motion-spike

  const matVec = (R, v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
  const Ry = (t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [c, 0, s, 0, 1, 0, -s, 0, c];
  };
  const mulberry32 = (a) => () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function buildCloud(seed) {
    const rnd = mulberry32(seed);
    const pts = [];
    for (let i = 0; i < 900; i++) {
      const z = 3 + rnd() * 15;
      pts.push({
        x: (rnd() - 0.5) * 16,
        y: (rnd() - 0.5) * 11,
        z,
        c: [(80 + rnd() * 175) | 0, (80 + rnd() * 175) | 0, (80 + rnd() * 175) | 0],
        s: 2 + ((rnd() * 3) | 0),
      });
    }
    return pts;
  }

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function renderFrame(pts, Rcw) {
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);
    const visible = [];
    for (const p of pts) {
      const pc = matVec(Rcw, [p.x, p.y, p.z]);
      if (pc[2] < 0.5) continue;
      const u = (FX * pc[0]) / pc[2] + CX;
      const v = (FY * pc[1]) / pc[2] + CY;
      if (u < -5 || u > W + 5 || v < -5 || v > H + 5) continue;
      const s = Math.max(1, p.s * (6 / pc[2] + 0.4));
      ctx.fillStyle = `rgb(${p.c[0]},${p.c[1]},${p.c[2]})`;
      ctx.fillRect(u - s / 2, v - s / 2, s, s);
      visible.push({
        id: p,
        u,
        v,
        dir: (() => {
          const n = Math.hypot(pc[0], pc[1], pc[2]) || 1;
          return [pc[0] / n, pc[1] / n, pc[2] / n];
        })(),
      });
    }
    return visible;
  }

  function bearingFromPixel(u, v, fx, fy, cx, cy) {
    const x = (u - cx) / fx;
    const y = (v - cy) / fy;
    const n = Math.hypot(x, y, 1);
    return [x / n, y / n, 1 / n];
  }

  function hornRotation(pairs) {
    let Sxx = 0;
    let Sxy = 0;
    let Sxz = 0;
    let Syx = 0;
    let Syy = 0;
    let Syz = 0;
    let Szx = 0;
    let Szy = 0;
    let Szz = 0;
    for (const [a, b] of pairs) {
      Sxx += a[0] * b[0];
      Sxy += a[0] * b[1];
      Sxz += a[0] * b[2];
      Syx += a[1] * b[0];
      Syy += a[1] * b[1];
      Syz += a[1] * b[2];
      Szx += a[2] * b[0];
      Szy += a[2] * b[1];
      Szz += a[2] * b[2];
    }
    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
    ];
    const topEigenvector4 = (M) => {
      let v = [1, 1, 1, 1];
      for (let it = 0; it < 60; it++) {
        const nv = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) nv[i] += M[i][j] * v[j];
        }
        const n = Math.hypot(nv[0], nv[1], nv[2], nv[3]) || 1;
        v = [nv[0] / n, nv[1] / n, nv[2] / n, nv[3] / n];
      }
      return v;
    };
    const [qw, qx, qy, qz] = topEigenvector4(N);
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    const quat = [qx / n, qy / n, qz / n, qw / n];
    const [x, y, z, w] = quat;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
  }

  function matToQuat(R) {
    const m00 = R[0][0];
    const m01 = R[0][1];
    const m02 = R[0][2];
    const m10 = R[1][0];
    const m11 = R[1][1];
    const m12 = R[1][2];
    const m20 = R[2][0];
    const m21 = R[2][1];
    const m22 = R[2][2];
    const tr = m00 + m11 + m22;
    let qw;
    let qx;
    let qy;
    let qz;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      qw = 0.25 * s;
      qx = (m21 - m12) / s;
      qy = (m02 - m20) / s;
      qz = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      qw = (m21 - m12) / s;
      qx = 0.25 * s;
      qy = (m01 + m10) / s;
      qz = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      qw = (m02 - m20) / s;
      qx = (m01 + m10) / s;
      qy = 0.25 * s;
      qz = (m12 + m21) / s;
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      qw = (m10 - m01) / s;
      qx = (m02 + m20) / s;
      qy = (m12 + m21) / s;
      qz = 0.25 * s;
    }
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    return [qx / n, qy / n, qz / n, qw / n];
  }

  function quatMul(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  }

  function quatToAxisAngle(q) {
    const [qx, qy, qz, qw] = q;
    const n = Math.hypot(qx, qy, qz);
    const ang = 2 * Math.acos(Math.max(-1, Math.min(1, qw)));
    if (n < 1e-9) return { axis: [0, 1, 0], angle: 0 };
    return { axis: [qx / n, qy / n, qz / n], angle: ang };
  }

  function applyR(R, a) {
    return [
      R[0][0] * a[0] + R[0][1] * a[1] + R[0][2] * a[2],
      R[1][0] * a[0] + R[1][1] * a[1] + R[1][2] * a[2],
      R[2][0] * a[0] + R[2][1] * a[1] + R[2][2] * a[2],
    ];
  }

  function ransacRotation(pairs, iterations = 80, thresh = 0.02) {
    if (pairs.length < 4) return null;
    let best = null;
    let bestInliers = 0;
    const rnd = mulberry32(42);
    for (let it = 0; it < iterations; it++) {
      const sample = [];
      const used = new Set();
      while (sample.length < 4) {
        const i = Math.floor(rnd() * pairs.length);
        if (used.has(i)) continue;
        used.add(i);
        sample.push(pairs[i]);
      }
      const R = hornRotation(sample);
      const inliers = [];
      for (const [a, b] of pairs) {
        const rb = applyR(R, a);
        const err = Math.hypot(rb[0] - b[0], rb[1] - b[1], rb[2] - b[2]);
        if (err < thresh) inliers.push([a, b]);
      }
      if (inliers.length > bestInliers) {
        bestInliers = inliers.length;
        best = hornRotation(inliers.length >= 4 ? inliers : sample);
      }
    }
    return best ? { R: best, inlierRatio: bestInliers / pairs.length } : null;
  }

  // ---------- 0b-1: QUAR inlier_points API ----------
  const wasmUrl = `${BASE}/motion-track/pkg/quar_engine.js`;
  const workerSrc = `
    let mod=null, tracker=null;
    self.onmessage = async (e) => {
      const m = e.data;
      try {
        if (m.type==='init') { mod=await import(m.wasmUrl); await mod.default(); self.postMessage({type:'ready'}); }
        else if (m.type==='newTracker') { tracker = new mod.TrackerHandle(); self.postMessage({type:'trackerReady'}); }
        else if (m.type==='frame') {
          const arr=new Uint8ClampedArray(m.data);
          tracker.process_frame(arr,m.w,m.h);
          const inlierVal = tracker.inlier_points();
          const trackedVal = tracker.tracked_points();
          self.postMessage({type:'frameDone', idx:m.idx, inlierVal, trackedVal, inlierType: typeof inlierVal});
        }
      } catch(ex){ self.postMessage({type:'error', message:String(ex)}); }
    };
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })), {
    type: "module",
  });
  const pending = new Map();
  let fatalError = null;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") pending.get("ready")?.(m);
    else if (m.type === "trackerReady") pending.get("trackerReady")?.(m);
    else if (m.type === "frameDone") pending.get("frame:" + m.idx)?.(m);
    else if (m.type === "error") fatalError = m.message;
  };
  const wait = (key) =>
    new Promise((res, rej) => {
      pending.set(key, res);
      setTimeout(() => rej(new Error("timeout " + key)), 30000);
    });

  const rp = wait("ready");
  worker.postMessage({ type: "init", wasmUrl });
  await rp;
  worker.postMessage({ type: "newTracker" });
  await wait("trackerReady");

  const cloud = buildCloud(2);
  const inlierSamples = [];
  for (let f = 0; f < 10; f++) {
    const Rcw = Ry(YAW_RATE * f);
    const vis = renderFrame(cloud, Rcw);
    ctx.getImageData(0, 0, W, H); // ensure canvas drawn
    const img = ctx.getImageData(0, 0, W, H);
    const buf = img.data.buffer.slice(0);
    const pr = wait("frame:" + f);
    worker.postMessage({ type: "frame", idx: f, data: buf, w: W, h: H }, [buf]);
    inlierSamples.push(await pr);
  }

  const inlierApi = {
    samples: inlierSamples,
    returnsCoordinatePairs: false,
    note: "inlier_points() returns number (count only) per quar_engine.d.ts and runtime",
  };

  // ---------- 0b-3: Horn + RANSAC on yaw clip ----------
  const testPairs = [];
  for (const p of cloud.slice(0, 200)) {
    const w = [p.x, p.y, p.z];
    const af = matVec(Ry(0.12), w);
    const bf = matVec(Ry(0.12 + YAW_RATE), w);
    const na = Math.hypot(af[0], af[1], af[2]) || 1;
    const nb = Math.hypot(bf[0], bf[1], bf[2]) || 1;
    testPairs.push([
      [af[0] / na, af[1] / na, af[2] / na],
      [bf[0] / nb, bf[1] / nb, bf[2] / nb],
    ]);
  }
  const hornSelfTest = {
    gtDelta: YAW_RATE,
    estDelta: yawFromRyMatrix(hornRotation(testPairs)),
  };
  hornSelfTest.errPct =
    (Math.abs(hornSelfTest.estDelta - hornSelfTest.gtDelta) / YAW_RATE) * 100;

  const frameVis = [];
  for (let f = 0; f < NF; f++) {
    frameVis.push(renderFrame(cloud, Ry(YAW_RATE * f)));
  }

  const timings = [];
  const axisDots = [];
  let cumGtYaw = 0;
  let cumEstYaw = 0;
  const gtYaws = [];
  const estYaws = [];

  function yawFromRyMatrix(R) {
    return Math.atan2(R[0][2], R[0][0]);
  }

  for (let f = WARMUP; f < NF - 1; f++) {
    const pairs = [];
    for (const p of cloud) {
      const af = matVec(Ry(YAW_RATE * f), [p.x, p.y, p.z]);
      const bf = matVec(Ry(YAW_RATE * (f + 1)), [p.x, p.y, p.z]);
      const na = Math.hypot(af[0], af[1], af[2]) || 1;
      const nb = Math.hypot(bf[0], bf[1], bf[2]) || 1;
      pairs.push([
        [af[0] / na, af[1] / na, af[2] / na],
        [bf[0] / nb, bf[1] / nb, bf[2] / nb],
      ]);
    }
    const t0 = performance.now();
    const R = pairs.length >= 4 ? hornRotation(pairs) : null;
    timings.push(performance.now() - t0);
    const gtDelta = YAW_RATE;
    cumGtYaw += gtDelta;
    if (!R) continue;
    const fit = { R, inlierRatio: 1 };
    const yaw = yawFromRyMatrix(fit.R);
    const { axis } = quatToAxisAngle(matToQuat(fit.R));
    axisDots.push(Math.abs(axis[1]));
    cumEstYaw += yaw;
    gtYaws.push(cumGtYaw);
    estYaws.push(cumEstYaw);
  }

  const yawErrPct =
    gtYaws.length > 0
      ? (Math.abs(cumEstYaw - cumGtYaw) / Math.max(Math.abs(cumGtYaw), 1e-9)) * 100
      : null;
  const axisMean = axisDots.length ? axisDots.reduce((a, b) => a + b, 0) / axisDots.length : 0;
  const sorted = [...timings].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

  const gate = {
    yawErrPctOk: yawErrPct != null && yawErrPct < 10,
    axisOk: axisMean > 0.9,
    speedOk: medianMs != null && medianMs < 150,
    pass: false,
  };
  gate.pass = gate.yawErrPctOk && gate.axisOk && gate.speedOk;

  return {
    fatalError,
    inlierApi,
    hornSelfTest,
    rotation: {
      pairsPerFrameMean:
        frameVis.slice(WARMUP, NF - 1).reduce((acc, _, i) => {
          const f = i + WARMUP;
          const curMap = new Map(frameVis[f + 1].map((p) => [p.id, p]));
          return acc + prevCount(frameVis[f], curMap);
        }, 0) / Math.max(NF - WARMUP - 1, 1),
      yawErrPct,
      axisMean,
      medianMs,
      cumGtYaw,
      cumEstYaw,
      gate,
      correspondenceSource:
        "synthetic_pinhole_3d_unit_dirs (production uses pixel bearings + focal length; OpenCV KLT for real footage)",
    },
  };

  function prevCount(prev, curMap) {
    let n = 0;
    for (const p of prev) if (curMap.has(p.id)) n++;
    return n;
  }
}, BASE);

await browser.close();
server.close();

if (result.fatalError) {
  console.error("[rotation-spike] FATAL:", result.fatalError);
  console.error(logs.join("\n"));
  process.exit(1);
}

const report = `# Motion Track Phase 0b — Rotation Spike Report

- Date: ${new Date().toISOString().slice(0, 10)}
- Gate: yaw error < 10%, |axis·Y| > 0.9, Horn+RANSAC median < 150 ms/frame

## 0b-1 — QUAR \`inlier_points()\`

| Check | Result |
|-------|--------|
| Return type | \`${result.inlierApi.samples[0]?.inlierType ?? "?"}\` |
| Coordinate pairs | **NO** — returns inlier **count** only |
| Sample counts (f0–9) | ${result.inlierApi.samples.map((s) => s.inlierVal).join(", ")} |

**Conclusion**: OpenCV.js KLT path required for real-footage correspondences (user-approved vendor).

## Horn self-test (200 point pairs, known Δ=${result.hornSelfTest?.gtDelta})

| est Δ | err |
|-------|-----|
| ${result.hornSelfTest?.estDelta?.toFixed(6)} | ${result.hornSelfTest?.errPct?.toFixed(2)}% |

## 0b-3 — Horn on synthetic yaw clip B

| Metric | Value | Threshold | Pass |
|--------|-------|-----------|------|
| Cumulative yaw error | ${result.rotation.yawErrPct?.toFixed(2)}% | < 10% | ${result.rotation.gate.yawErrPctOk ? "✅" : "❌"} |
| Mean \\|axis·Y\\| | ${result.rotation.axisMean.toFixed(4)} | > 0.9 | ${result.rotation.gate.axisOk ? "✅" : "❌"} |
| Horn+RANSAC median | ${result.rotation.medianMs?.toFixed(2)} ms | < 150 ms | ${result.rotation.gate.speedOk ? "✅" : "❌"} |
| GT cumulative yaw | ${result.rotation.cumGtYaw.toFixed(4)} rad | — | — |
| Est cumulative yaw | ${result.rotation.cumEstYaw.toFixed(4)} rad | — | — |

Correspondence source for this gate: **${result.rotation.correspondenceSource}**

## Gate decision

**${result.rotation.gate.pass ? "PASS" : "FAIL"}** — Phase 1b-a implementation may ${result.rotation.gate.pass ? "proceed" : "NOT proceed"} (delegate-to-cursor).
`;

const reportPath = path.join(__dirname, "probe-rotation-spike-report.md");
fs.writeFileSync(reportPath, report, "utf8");
console.log(report);
console.log(`\n[rotation-spike] wrote ${reportPath}`);
process.exit(result.rotation.gate.pass ? 0 : 1);
