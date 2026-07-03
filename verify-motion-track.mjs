// Phase 1a+1b-a+3D Solve — Video Motion Track 実機検証。
// ffmpeg 生成クリップ → import → runMotionTrack / runRotationTrack / runSolveTrack → resolve チェック。
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const DEBUG_DIR = path.join("for-debug-data");
const CLIP_PATH = path.join(DEBUG_DIR, "motion-track-pan.mp4");
const DOLLY_CLIP_PATH = path.join(DEBUG_DIR, "motion-track-dolly.mp4");
const YAW_CLIP_PATH = path.join(DEBUG_DIR, "motion-track-yaw.mp4");
const HEADED = process.env.HEADED === "1";

function ensurePanClip() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (fs.existsSync(CLIP_PATH)) return;
  const vf = "crop=640:480:x='min(n*3\\,640)':y=0";
  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x480:rate=30:duration=2",
    "-vf", vf,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    CLIP_PATH,
  ].join(" ");
  console.log("[verify-motion-track] generating pan clip:", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function ensureDollyClip() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (fs.existsSync(DOLLY_CLIP_PATH)) return;
  // 中心からのスケールアップ（zoompan）でドリー（前進）を模擬。
  const vf = "scale=1280:960,zoompan=z='min(zoom+0.0015,1.3)':d=1:s=640x480:fps=30";
  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x960:rate=30:duration=2",
    "-vf", vf,
    "-frames:v", "60",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    DOLLY_CLIP_PATH,
  ].join(" ");
  console.log("[verify-motion-track] generating dolly clip:", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function ensureYawClip() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (fs.existsSync(YAW_CLIP_PATH)) return;
  const vf = "rotate=angle='0.008726646*n':c=black:ow=640:oh=480";
  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=800x600:rate=30:duration=2",
    "-vf", vf,
    "-frames:v", "60",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    YAW_CLIP_PATH,
  ].join(" ");
  console.log("[verify-motion-track] generating yaw clip:", cmd);
  execSync(cmd, { stdio: "inherit" });
}

ensurePanClip();
ensureDollyClip();
ensureYawClip();
const videoBytes = fs.readFileSync(CLIP_PATH);
const dollyBytes = fs.readFileSync(DOLLY_CLIP_PATH);
const yawBytes = fs.readFileSync(YAW_CLIP_PATH);

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// 3D Solve は全フレーム KLT + BA のため既存シナリオより長い。
page.setDefaultTimeout(600_000);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });

const result = await page.evaluate(async ({ panBytes, panName, dollyBytes, dollyName, yawBytes, yawName }) => {
  const storeMod = await import("/src/editor/store.ts");
  const {
    runMotionTrack,
    finalizeMotionTrackBake,
    runRotationTrack,
    finalizeRotationTrackBake,
    runSolveTrack,
  } = await import("/src/editor/motionTrack/quarTracker.ts");
  const {
    applyMotionTrackToProject,
    applyRotationTrackToProject,
    applySolveTrackToProject,
  } = await import("/src/editor/motionTrack/applyMotionTrack.ts");
  const { sampleVec3 } = await import("/src/runtime/interpolate.ts");
  const { resolve } = await import("/src/runtime/resolve.ts");

  const S = () => storeMod.useEditorStore.getState();
  for (let i = 0; i < 120 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }

  async function trackAndBake({ bytes, name, targetKind, userScale }) {
    await S().newProject();
    const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
    const assetId = await S().importVideoAsset(file);
    if (!assetId) throw new Error("importVideoAsset failed");
    const videoLayerId = S().addVideoLayer(assetId, "motion-track-src");
    if (!videoLayerId) throw new Error("addVideoLayer failed");
    const targetId =
      targetKind === "camera" ? S().addCamera("motion-track-cam") : S().addNullLayer("motion-track-target");
    if (!targetId) throw new Error(`add${targetKind} failed`);

    await new Promise((r) => setTimeout(r, 2000));

    const project = S().project;
    const compId = S().currentCompId;
    const comp = project.compositions.find((c) => c.id === compId);
    if (!comp || comp.kind !== "timeline") throw new Error("timeline comp missing");
    const videoLayer = comp.objects.find((o) => o.id === videoLayerId);
    const target = comp.objects.find((o) => o.id === targetId);
    if (!videoLayer || !target) throw new Error("layers missing");

    const track = await runMotionTrack({
      project,
      comp,
      videoLayer,
      assetId,
      fs: S().getFs(),
      options: { userScale, sampleInterval: 1 },
    });

    const baseline = sampleVec3(target.transform.position, 0);
    const baked = finalizeMotionTrackBake(
      track.compFrames,
      track.track.smoothed,
      track.validMask,
      baseline,
      userScale,
    );

    const { before, after } = applyMotionTrackToProject(project, comp.id, targetId, {
      baselinePosition: baseline,
      positionsByFrame: baked.positionsByFrame,
      bakeStart: track.bakeStart,
      bakeEnd: track.bakeEnd,
      clearExpression: false,
    });
    S().applyCommand({ label: "Motion Track Bake (verify)", before, after });

    const bakedComp = S().project.compositions.find((c) => c.id === compId);
    const bakedTarget = bakedComp.objects.find((o) => o.id === targetId);
    // Camera 二段カメラは pointOfInterest を静的維持していること（並進のみベイクの契約）。
    const poiUnchanged =
      targetKind !== "camera" ||
      (() => {
        const camComp = bakedTarget.components.find((c) => c.type === "camera");
        const before = target.components.find((c) => c.type === "camera").props.pointOfInterest;
        const after = camComp.props.pointOfInterest;
        return JSON.stringify(before) === JSON.stringify(after);
      })();
    const sample = (frame) => {
      const scene = resolve(bakedComp, frame);
      const o = scene.objects.find((x) => x.id === targetId);
      if (!o) throw new Error(`${targetKind} not in scene`);
      return { x: o.worldTransform[12], y: o.worldTransform[13], z: o.worldTransform[14] };
    };

    return {
      frameCount: track.compFrames.length,
      f0: sample(0),
      fMid: sample(15),
      fLate: sample(30),
      validFrames: track.validMask.filter(Boolean).length,
      poiUnchanged,
    };
  }

  const nullPan = await trackAndBake({ bytes: panBytes, name: panName, targetKind: "null", userScale: 80 });
  const cameraPan = await trackAndBake({ bytes: panBytes, name: panName, targetKind: "camera", userScale: 80 });
  const nullDolly = await trackAndBake({ bytes: dollyBytes, name: dollyName, targetKind: "null", userScale: 500 });

  async function trackRotationAndBake({ bytes, name, focalLength }) {
    await S().newProject();
    const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
    const assetId = await S().importVideoAsset(file);
    if (!assetId) throw new Error("importVideoAsset failed");
    const videoLayerId = S().addVideoLayer(assetId, "motion-track-yaw-src");
    if (!videoLayerId) throw new Error("addVideoLayer failed");
    const targetId = S().addNullLayer("motion-track-yaw-target");
    if (!targetId) throw new Error("addNull failed");

    await new Promise((r) => setTimeout(r, 2000));

    const project = S().project;
    const compId = S().currentCompId;
    const comp = project.compositions.find((c) => c.id === compId);
    if (!comp || comp.kind !== "timeline") throw new Error("timeline comp missing");
    const videoLayer = comp.objects.find((o) => o.id === videoLayerId);
    const target = comp.objects.find((o) => o.id === targetId);
    if (!videoLayer || !target) throw new Error("layers missing");

    const track = await runRotationTrack({
      project,
      comp,
      videoLayer,
      assetId,
      fs: S().getFs(),
      options: { userScale: 1, sampleInterval: 1, focalLength },
    });

    const baseline = sampleVec3(target.transform.rotation, 0);
    const rotationsByFrame = finalizeRotationTrackBake(
      track.compFrames,
      track.track.smoothed,
      track.validMask,
      baseline,
    );

    const { before, after } = applyRotationTrackToProject(project, comp.id, targetId, {
      baselineRotation: baseline,
      rotationsByFrame,
      bakeStart: track.bakeStart,
      bakeEnd: track.bakeEnd,
      clearExpression: false,
    });
    S().applyCommand({ label: "Motion Track Rotation Bake (verify)", before, after });

    const bakedComp = S().project.compositions.find((c) => c.id === compId);
    const bakedTarget = bakedComp.objects.find((o) => o.id === targetId);
    const sampleRot = (frame) => sampleVec3(bakedTarget.transform.rotation, frame);

    return {
      frameCount: track.compFrames.length,
      f0: sampleRot(0),
      fMid: sampleRot(15),
      fLate: sampleRot(30),
      validFrames: track.validMask.filter(Boolean).length,
    };
  }

  const yawPanRotation = await trackRotationAndBake({
    bytes: yawBytes,
    name: yawName,
    focalLength: 550,
  });

  /** 3D Solve: 配線 + ベイクが通ること。平面クリップは rotationOnly になりうる。 */
  async function trackSolveAndBake({ bytes, name, targetKind }) {
    await S().newProject();
    const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
    const assetId = await S().importVideoAsset(file);
    if (!assetId) throw new Error("importVideoAsset failed");
    const videoLayerId = S().addVideoLayer(assetId, "motion-track-solve-src");
    if (!videoLayerId) throw new Error("addVideoLayer failed");
    const targetId =
      targetKind === "camera" ? S().addCamera("motion-track-solve-cam") : S().addNullLayer("motion-track-solve-target");
    if (!targetId) throw new Error(`add${targetKind} failed`);

    await new Promise((r) => setTimeout(r, 2000));

    const project = S().project;
    const compId = S().currentCompId;
    const comp = project.compositions.find((c) => c.id === compId);
    if (!comp || comp.kind !== "timeline") throw new Error("timeline comp missing");
    const videoLayer = comp.objects.find((o) => o.id === videoLayerId);
    const target = comp.objects.find((o) => o.id === targetId);
    if (!videoLayer || !target) throw new Error("layers missing");

    const posBaseline = sampleVec3(target.transform.position, 0);
    const rotBaseline = sampleVec3(target.transform.rotation, 0);
    const result = await runSolveTrack(
      {
        project,
        comp,
        videoLayer,
        assetId,
        fs: S().getFs(),
        options: {
          userScale: 80,
          sampleInterval: 1,
          focalLength: 550,
          solveFocal: true,
          autoScale: true,
          autoScaleTargetPx: Math.max(80, comp.height * 0.15),
        },
      },
      { position: posBaseline, rotation: rotBaseline },
    );

    const { before, after } = applySolveTrackToProject(
      project,
      comp.id,
      targetId,
      {
        baselinePosition: posBaseline,
        positionsByFrame: result.positionsByFrame,
        bakeStart: result.bakeStart,
        bakeEnd: result.bakeEnd,
        clearExpression: false,
      },
      {
        baselineRotation: rotBaseline,
        rotationsByFrame: result.rotationsByFrame,
        bakeStart: result.bakeStart,
        bakeEnd: result.bakeEnd,
        clearExpression: false,
      },
    );
    S().applyCommand({ label: "Motion Track 3D Solve Bake (verify)", before, after });

    const bakedComp = S().project.compositions.find((c) => c.id === compId);
    const bakedTarget = bakedComp.objects.find((o) => o.id === targetId);
    const samplePos = (frame) => {
      const scene = resolve(bakedComp, frame);
      const o = scene.objects.find((x) => x.id === targetId);
      if (!o) throw new Error(`${targetKind} not in scene`);
      return { x: o.worldTransform[12], y: o.worldTransform[13], z: o.worldTransform[14] };
    };
    const sampleRot = (frame) => sampleVec3(bakedTarget.transform.rotation, frame);

    return {
      frameCount: result.compFrames.length,
      mode: result.mode,
      validFrames: result.validMask.filter(Boolean).length,
      pointCount: result.pointCount,
      keyframeCount: result.keyframeCount,
      medianReprojErrPx: result.medianReprojErrPx,
      f0: samplePos(0),
      fMid: samplePos(15),
      fLate: samplePos(30),
      r0: sampleRot(0),
      rMid: sampleRot(15),
      rLate: sampleRot(30),
    };
  }

  const solvePan = await trackSolveAndBake({
    bytes: panBytes,
    name: panName,
    targetKind: "null",
  });
  const solveYaw = await trackSolveAndBake({
    bytes: yawBytes,
    name: yawName,
    targetKind: "null",
  });

  return { nullPan, cameraPan, nullDolly, yawPanRotation, solvePan, solveYaw };
}, {
  panBytes: [...videoBytes], panName: "motion-track-pan.mp4",
  dollyBytes: [...dollyBytes], dollyName: "motion-track-dolly.mp4",
  yawBytes: [...yawBytes], yawName: "motion-track-yaw.mp4",
});

console.log("track result:", JSON.stringify(result, null, 2));

let pass = true;
function checkPan(label, r) {
  const dxMid = r.fMid.x - r.f0.x;
  const dxLate = r.fLate.x - r.f0.x;
  if (r.frameCount < 10) {
    console.error(`FAIL[${label}]: too few frames tracked (${r.frameCount})`);
    pass = false;
  }
  if (r.validFrames < 20) {
    console.error(`FAIL[${label}]: too few valid estimates (${r.validFrames})`);
    pass = false;
  }
  if (dxMid < 0.15) {
    console.error(`FAIL[${label}]: expected +x displacement at f15, got dx=${dxMid}`);
    pass = false;
  }
  if (dxLate <= dxMid) {
    console.error(`FAIL[${label}]: expected increasing +x (f30=${dxLate}, f15=${dxMid})`);
    pass = false;
  }
  if (Math.abs(r.f0.y - r.fMid.y) > 80) {
    console.error(`FAIL[${label}]: unexpected large Y drift`);
    pass = false;
  }
}

checkPan("nullPan", result.nullPan);
checkPan("cameraPan", result.cameraPan);
if (!result.cameraPan.poiUnchanged) {
  console.error("FAIL[cameraPan]: pointOfInterest changed by a position-only bake");
  pass = false;
}

// dolly: ffmpeg zoompan は平坦な 1 枚のテクスチャを拡大するだけ（実シーンの奥行き視差が無い）ため、
// Essential matrix が退化する既知の平面シーンケース（計画書「既知の制約」参照）。単調な z 増加は
// 期待できないので、ここでは「Z 軸パイプラインが実際に動いて非ゼロ値を書いている」ことのみを
// 弱く確認する（座標変換の Z 反転自体は motionTrackCoordConvert.test.ts の単体テストで固定済み）。
{
  const r = result.nullDolly;
  const dzMid = Math.abs(r.fMid.z - r.f0.z);
  if (r.validFrames < 15) {
    console.error(`FAIL[nullDolly]: too few valid estimates (${r.validFrames})`);
    pass = false;
  }
  if (!Number.isFinite(dzMid)) {
    console.error(`FAIL[nullDolly]: non-finite z displacement`);
    pass = false;
  }
  if (dzMid < 0.05) {
    console.error(`FAIL[nullDolly]: expected some z displacement at f15, got dz=${dzMid} (z-axis pipeline may not be wired)`);
    pass = false;
  }
}

{
  const r = result.yawPanRotation;
  const dyMid = r.fMid.y - r.f0.y;
  const dyLate = r.fLate.y - r.f0.y;
  if (r.frameCount < 10) {
    console.error(`FAIL[yawPanRotation]: too few frames (${r.frameCount})`);
    pass = false;
  }
  if (r.validFrames < 15) {
    console.error(`FAIL[yawPanRotation]: too few valid estimates (${r.validFrames})`);
    pass = false;
  }
  if (Math.abs(dyMid) < 0.3) {
    console.error(`FAIL[yawPanRotation]: expected yaw at f15, got dy=${dyMid}`);
    pass = false;
  }
  if (Math.abs(dyLate) <= Math.abs(dyMid)) {
    console.error(`FAIL[yawPanRotation]: expected increasing |yaw| (f30=${dyLate}, f15=${dyMid})`);
    pass = false;
  }
}

// 3D Solve: エンドツーエンド配線。平面パンは視差不足で rotationOnly になりうる。
// 合成 3D 点群での AE 級精度は motionTrackSfm.test.ts が担保。
{
  const r = result.solvePan;
  if (r.frameCount < 10) {
    console.error(`FAIL[solvePan]: too few frames (${r.frameCount})`);
    pass = false;
  }
  if (r.mode !== "sfm" && r.mode !== "rotationOnly") {
    console.error(`FAIL[solvePan]: unexpected mode ${r.mode}`);
    pass = false;
  }
  if (r.validFrames < 10) {
    console.error(`FAIL[solvePan]: too few valid frames (${r.validFrames})`);
    pass = false;
  }
  if (r.mode === "sfm") {
    const dxMid = r.fMid.x - r.f0.x;
    const dxLate = r.fLate.x - r.f0.x;
    if (Math.abs(dxMid) < 0.1 && Math.abs(dxLate) < 0.1) {
      console.error(`FAIL[solvePan]: sfm mode but no position displacement (dxMid=${dxMid}, dxLate=${dxLate})`);
      pass = false;
    }
  }
}

{
  const r = result.solveYaw;
  const dyMid = r.rMid.y - r.r0.y;
  const dyLate = r.rLate.y - r.r0.y;
  if (r.frameCount < 10) {
    console.error(`FAIL[solveYaw]: too few frames (${r.frameCount})`);
    pass = false;
  }
  if (r.mode !== "sfm" && r.mode !== "rotationOnly") {
    console.error(`FAIL[solveYaw]: unexpected mode ${r.mode}`);
    pass = false;
  }
  if (r.validFrames < 10) {
    console.error(`FAIL[solveYaw]: too few valid frames (${r.validFrames})`);
    pass = false;
  }
  // 純回転クリップ: ヨーが単調に増えること（rotationOnly が本線）。
  if (Math.abs(dyMid) < 0.3) {
    console.error(`FAIL[solveYaw]: expected yaw at f15, got dy=${dyMid} (mode=${r.mode})`);
    pass = false;
  }
  if (Math.abs(dyLate) <= Math.abs(dyMid)) {
    console.error(`FAIL[solveYaw]: expected increasing |yaw| (f30=${dyLate}, f15=${dyMid})`);
    pass = false;
  }
}

if (errors.length > 0) {
  console.error("console errors:", errors);
  pass = false;
}

await browser.close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
