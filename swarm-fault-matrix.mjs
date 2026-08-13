// LOOP 3 fault-injection matrix. The worker fault hook is development-only and is ignored by
// production builds. Each case runs the real Chrome harness twice so the first B block may be the
// bounded probe and the second B block proves whether the host learned anything useful.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const cases = [
  { name: "dead-no-ack", fault: "no-ack", expected: (runs) => runs.every((run) => run.jobAckTimeouts > 0 || run.adoptedRemoteFrames === 0) && runs.every((run) => run.hostRenderedFrames === 4) },
  { name: "accepted-hang", fault: "accepted-hang", expected: (runs) => runs.some((run) => run.jobRenderStalls > 0 || run.jobHardTimeouts > 0) && runs.every((run) => run.adoptedRemoteFrames === 0) },
  { name: "transfer-stall", fault: "transfer-stall", expected: (runs) => runs.some((run) => run.jobTransferStalls > 0) && runs.every((run) => run.adoptedRemoteFrames === 0) },
  { name: "slow-late", fault: "slow-late", expected: (runs) => runs.some((run) => run.lateValidResults > 0 && run.lateMeasuredFrames > 0) && runs.some((run) => run.probeSuccesses > 0) },
  { name: "healthy", fault: "", expected: (runs) => runs.some((run) => run.probeSuccesses > 0) && runs.some((run) => run.adoptedRemoteFrames > 0) },
];
const selectedCases = process.env.SWARM_FAULT_MATRIX_CASE
  ? cases.filter((testCase) => testCase.name === process.env.SWARM_FAULT_MATRIX_CASE)
  // Healthy is an already-established control, but it is machine-dependent: a truthful scheduler
  // must decline a worker that measures slower than the host instead of making this fault suite
  // pass by counting an invalid late payload. Run it explicitly when the environment is known to
  // have a fast worker: SWARM_FAULT_MATRIX_CASE=healthy.
  : cases.filter((testCase) => testCase.fault !== "");

function runCase(testCase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SWARM_APP_URL: process.env.SWARM_APP_URL ?? "http://127.0.0.1:5173/",
      SWARM_SEQUENCE: "BB",
      SWARM_FRAMES: testCase.name === "healthy" ? "24" : "4",
      SWARM_WARMUP_MAX: testCase.name === "healthy" ? "2" : "1",
      SWARM_WARMUP_TOLERANCE: "0.3",
      SWARM_EXPORT_TIMEOUT_MS: "120000",
      SWARM_JOIN_WAIT_MS: "90000",
      SWARM_FAULT: testCase.fault,
      SWARM_PROFILE: path.join(os.tmpdir(), `mafter-swarm-fault-${testCase.name}`),
    };
    const child = spawn(process.execPath, ["swarm-export-ab.mjs"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = output.lastIndexOf("RAW ");
      if (code !== 0 || marker < 0) {
        reject(new Error(`${testCase.name} exited ${code}\n${output.slice(-4000)}`));
        return;
      }
      try {
        resolve({ runs: JSON.parse(output.slice(marker + 4).trim()), output });
      } catch (error) {
        reject(new Error(`${testCase.name} emitted invalid RAW: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-4000)}`));
      }
    });
  });
}

const results = [];
for (const testCase of selectedCases) {
  const result = await runCase(testCase);
  const runs = result.runs.filter((run) => run.mode === "B");
  const pass = testCase.expected(runs);
  results.push({ case: testCase.name, pass, runs: runs.map((run) => ({
    adopted: run.adoptedRemoteFrames,
    hostRendered: run.hostRenderedFrames,
    probes: `${run.probeSuccesses}/${run.probeJobs}`,
    noAck: run.jobAckTimeouts,
    renderStalls: run.jobRenderStalls,
    transferStalls: run.jobTransferStalls,
    hardDeadlines: run.jobHardTimeouts,
    lateValid: run.lateValidResults,
    lateMeasuredFrames: run.lateMeasuredFrames,
  })) });
  console.log(`${pass ? "PASS" : "FAIL"} ${testCase.name}`, JSON.stringify(results.at(-1)));
  if (!pass) console.log(result.output.slice(-5000));
}

console.log("FAULT MATRIX", JSON.stringify(results));
if (results.some((result) => !result.pass)) process.exitCode = 1;
