/**
 * Diagnose whether a project loop cuts an embedded-audio video at a non-silent
 * sample and whether the current frame-rate volume envelope can suppress it.
 *
 * The default fixture is the latest project used for the Comp 10 investigation.
 * The script writes extracted audio only under the OS temp directory and removes it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";

const DEFAULT_ZIP = "C:/Users/resis/Downloads/mafter-project (25).zip";
const DEFAULT_COMP = "Comp 10";
const AUTO_FADE_SEC = 0.12;
const EPSILON = 0.005;

function usage() {
  console.log("Usage: node doc/issue/static-noise-problem/verify-loop-audio-seam.mjs [--zip path] [--comp name]");
}

function readArgs(argv) {
  let zip = DEFAULT_ZIP;
  let compName = DEFAULT_COMP;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help") return null;
    if (argv[i] === "--zip") zip = argv[++i] ?? "";
    else if (argv[i] === "--comp") compName = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { zip, compName };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Matches footageAutoFade.ts: cubic-bezier(0.32, 0, 0.67, 0), solved for x -> y.
function fadeEase(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x1 = 0.32; const y1 = 0; const x2 = 0.67; const y2 = 0;
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sampleX = (s) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s) => ((ay * s + by) * s + cy) * s;
  let lo = 0; let hi = 1; let s = t;
  for (let i = 0; i < 32; i++) {
    const x = sampleX(s);
    if (Math.abs(x - t) < 1e-7) break;
    if (x < t) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

function frameFade(frame, inPoint, outPoint, fps) {
  const elapsed = (frame + 0.5 - inPoint) / fps;
  const duration = (outPoint - inPoint) / fps;
  let value = 1;
  if (elapsed < AUTO_FADE_SEC) value = Math.min(value, fadeEase(clamp01(elapsed / AUTO_FADE_SEC)));
  const outProgress = (elapsed - (duration - AUTO_FADE_SEC)) / AUTO_FADE_SEC;
  if (outProgress > 0) value = Math.min(value, 1 - fadeEase(clamp01(outProgress)));
  return value;
}

function readPcmStats(pcm, sampleRate, channels, cutSec) {
  const lastIndex = Math.max(0, Math.floor(cutSec * sampleRate) - 1);
  const jumps = [];
  for (let channel = 0; channel < channels; channel++) {
    const last = pcm[lastIndex * channels + channel] ?? 0;
    const first = pcm[channel] ?? 0;
    jumps.push({ channel, last, first, jump: first - last });
  }
  return jumps;
}

const args = readArgs(process.argv.slice(2));
if (args === null) { usage(); process.exit(0); }
if (!existsSync(args.zip)) throw new Error(`Project zip not found: ${args.zip}`);

const zip = await JSZip.loadAsync(readFileSync(args.zip));
const projectFile = zip.file("project.json");
if (!projectFile) throw new Error("project.json is missing from the zip");
const project = JSON.parse(await projectFile.async("string"));
const comp = project.compositions?.find((candidate) => candidate.name === args.compName);
if (!comp || comp.kind !== "timeline") throw new Error(`Timeline composition not found: ${args.compName}`);

const videoObject = comp.objects.find((object) => object.enabled !== false && object.components.some((component) => component.type === "video"));
const video = videoObject?.components.find((component) => component.type === "video");
if (!videoObject || !video) throw new Error("No enabled video layer found");
const assetId = video.props.asset;
const asset = project.assets.find((candidate) => candidate.id === assetId);
if (!asset) throw new Error(`Video asset not found: ${assetId}`);
const assetFile = zip.file(asset.path);
if (!assetFile) throw new Error(`Video bytes are missing from the zip: ${asset.path}`);

const loopEnd = Number.isFinite(comp.duration) ? comp.duration : videoObject.outPoint;
const cutFrame = Math.min(loopEnd, videoObject.outPoint);
const cutSec = (cutFrame - videoObject.inPoint + (video.props.trimStart ?? 0)) / comp.fps;
const temp = mkdtempSync(join(tmpdir(), "mafter-loop-audio-"));
const mediaPath = join(temp, basename(asset.path));
const pcmPath = join(temp, "audio.f32");

try {
  writeFileSync(mediaPath, await assetFile.async("nodebuffer"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "json", mediaPath], { encoding: "utf8" }));
  const stream = probe.streams?.[0];
  if (!stream) throw new Error("The selected video has no audio stream");
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", mediaPath, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", pcmPath]);
  const bytes = readFileSync(pcmPath);
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const jumps = readPcmStats(pcm, sampleRate, channels, cutSec);
  const lastFrame = cutFrame - 1;
  const renderedFade = frameFade(lastFrame, videoObject.inPoint, videoObject.outPoint, comp.fps);
  const rawPeak = Math.max(...jumps.map((entry) => Math.abs(entry.jump)));
  const residualPeak = rawPeak * renderedFade;
  const result = { comp: comp.name, fps: comp.fps, cutFrame, cutSec, asset: asset.path, audio: { codec: stream.codec_name, sampleRate, channels }, jumps, lastFrameFade: renderedFade, rawPeak, residualPeak, safe: rawPeak <= EPSILON || residualPeak <= EPSILON };
  console.log(JSON.stringify(result, null, 2));
  if (!result.safe) {
    console.error(`FAIL: loop seam remains audible (residual peak ${residualPeak.toFixed(6)} > ${EPSILON}).`);
    process.exitCode = 1;
  } else {
    console.log("PASS: source seam or the current envelope is below the diagnostic threshold.");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
