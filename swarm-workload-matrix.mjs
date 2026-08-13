// LOOP 4 workload runner. Run this separately for WARM and COLD; a single invocation never mixes
// the two cache states. Each workload is executed more than once with the same export sequence,
// and swarm-export-ab.mjs prints the per-job cost table before any speed claim.
//
//   SWARM_MODE=WARM SWARM_MATRIX_REPEATS=2 node swarm-workload-matrix.mjs
//   SWARM_MODE=COLD SWARM_MATRIX_REPEATS=2 node swarm-workload-matrix.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const mode = (process.env.SWARM_MODE ?? "WARM").toUpperCase() === "COLD" ? "COLD" : "WARM";
const repeats = Math.max(2, Number(process.env.SWARM_MATRIX_REPEATS ?? 2));
const sequence = process.env.SWARM_SEQUENCE ?? "ABBA";
const allWorkloads = [
  { name: "pure-graphics", source: path.resolve(".verify-bundle-out/project.json") },
  { name: "normal-footage", source: path.resolve("verify-comp33-mini-project.zip") },
  // The heavy fixture must be browser-decodable on the worker. The larger remix fixture contains
  // MKV media, which is useful for import tests but cannot produce a stable remote timing record
  // in Chrome. Comp 32 exercises high-resolution video plus split-alpha media instead.
  { name: "heavy-media", source: path.resolve(process.env.SWARM_HEAVY_ZIP ?? "verify-comp32-mini-project.zip") },
];
const requestedWorkloads = new Set((process.env.SWARM_WORKLOADS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const workloads = requestedWorkloads.size > 0
  ? allWorkloads.filter((workload) => requestedWorkloads.has(workload.name))
  : allWorkloads;
if (workloads.length === 0) throw new Error(`No matching workloads for ${[...requestedWorkloads].join(", ")}`);

async function pureGraphicsZip(directory) {
  const project = await readFile(directory.source, "utf8");
  const zip = new JSZip();
  zip.file("project.json", project);
  const target = path.join(directory.temp, "pure-graphics.zip");
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}

function runWorkload(workload, zip, repeat) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SWARM_MODE: mode,
      SWARM_SEQUENCE: sequence,
      SWARM_WORKLOAD: workload.name,
      SWARM_ZIP: zip,
      SWARM_PROFILE: path.join(os.tmpdir(), `mafter-swarm-${workload.name}-${mode.toLowerCase()}`),
      SWARM_WARMUP_MAX: process.env.SWARM_WARMUP_MAX ?? "2",
    };
    const child = spawn(process.execPath, ["swarm-export-ab.mjs"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = output.lastIndexOf("RAW ");
      if (marker < 0) {
        reject(new Error(`${workload.name} ${mode} run ${repeat} exited ${code}\n${output.slice(-3000)}`));
        return;
      }
      try {
        resolve({ workload: workload.name, mode, repeat, code, runs: JSON.parse(output.slice(marker + 4).trim()) });
      } catch (error) {
        reject(new Error(`${workload.name} emitted invalid RAW: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

const temp = await mkdtemp(path.join(os.tmpdir(), "mafter-swarm-workloads-"));
try {
  const prepared = [];
  for (const workload of workloads) {
    const zip = workload.name === "pure-graphics"
      ? await pureGraphicsZip({ ...workload, temp })
      : workload.source;
    prepared.push({ workload, zip });
  }
  const results = [];
  for (const { workload, zip } of prepared) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      results.push(await runWorkload(workload, zip, repeat));
    }
  }
  console.log("WORKLOAD MATRIX", JSON.stringify(results.map(({ workload, mode: runMode, repeat, code, runs }) => ({
    workload,
    mode: runMode,
    repeat,
    code,
    runs: runs.filter((run) => run.mode === "B").map((run) => ({
      seconds: run.seconds,
      completed: run.completed,
      localFramesAvoided: run.localFramesAvoided,
      remoteRenderedFrames: run.remoteRenderedFrames,
      remoteReceivedFrames: run.remoteReceivedFrames,
      remoteAdoptedFrames: run.adoptedRemoteFrames,
      verifiedRemoteFrames: run.verifiedRemoteFrames,
      lateRemoteFrames: run.lateRemoteFrames,
      exportTailWaitMs: run.exportTimeline?.exportTailWaitMs ?? null,
      consumerWaitMs: run.exportTimeline?.consumerWaitMs ?? null,
      invalidReasons: run.invalidReasons,
      jobTimelines: run.jobTimelines,
    })),
  }))));
} finally {
  await rm(temp, { recursive: true, force: true });
}
