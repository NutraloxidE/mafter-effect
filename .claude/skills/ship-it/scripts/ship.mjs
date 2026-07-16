#!/usr/bin/env node
// commit 分割 → push → PR。plan JSON は commit-planner subagent が書く。
// usage: node ship.mjs context <outFile>
//        node ship.mjs apply <planFile> [--no-pr] [--dry-run]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DIFF_LIMIT = 400_000; // chars; over this the planner reads files itself
const TRAILER = "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], ...opts });

const branch = () => git("rev-parse", "--abbrev-ref", "HEAD").trim();
const status = () => git("status", "--porcelain");

// porcelain -> paths. Handles renames ("R  old -> new") and quoted paths.
const changedFiles = () =>
  status()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      return unquote(arrow >= 0 ? p.slice(arrow + 4) : p);
    });

const unquote = (p) => (p.startsWith('"') ? JSON.parse(p) : p);

function context(out) {
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  let diff = git("diff", "HEAD");
  for (const f of untracked) {
    try {
      diff += `\n--- NEW FILE: ${f} ---\n` + readFileSync(f, "utf8");
    } catch {
      diff += `\n--- NEW BINARY FILE: ${f} ---\n`;
    }
  }
  const truncated = diff.length > DIFF_LIMIT;
  const body = [
    `# branch\n${branch()}`,
    `# git status --porcelain\n${status()}`,
    `# recent commits\n${git("log", "-8", "--format=%s")}`,
    `# diff${truncated ? " (TRUNCATED — read files directly for the rest)" : ""}\n${diff.slice(0, DIFF_LIMIT)}`,
  ].join("\n\n");
  writeFileSync(out, body);
  console.log(`${out} (${body.length} chars, ${changedFiles().length} files${truncated ? ", diff truncated" : ""})`);
}

function apply(planFile, { noPr, dryRun }) {
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const actual = new Set(changedFiles());
  const planned = plan.commits.flatMap((c) => c.files);

  // Trust boundary: a mis-planned file set silently loses work or commits the wrong thing.
  const dupes = planned.filter((f, i) => planned.indexOf(f) !== i);
  const missing = [...actual].filter((f) => !planned.includes(f));
  const unknown = planned.filter((f) => !actual.has(f));
  const errs = [
    dupes.length && `duplicated in plan: ${dupes.join(", ")}`,
    missing.length && `changed but not in plan: ${missing.join(", ")}`,
    unknown.length && `in plan but not changed: ${unknown.join(", ")}`,
  ].filter(Boolean);
  if (errs.length) throw new Error("plan does not match working tree:\n  " + errs.join("\n  "));

  const br = branch();
  if (br === "main" || br === "master") throw new Error(`refusing to commit on ${br}; branch first`);

  if (dryRun) {
    for (const c of plan.commits) console.log(`\n--- ${c.files.join(", ")}\n${c.message}`);
    console.log(`\n--- PR\n${plan.pr.title}\n\n${plan.pr.body}`);
    return;
  }

  git("reset", "--quiet");
  for (const c of plan.commits) {
    git("add", "--", ...c.files);
    const msg = `${c.message.trim()}\n\n${TRAILER}\n`;
    execFileSync("git", ["commit", "--quiet", "-F", "-"], { input: msg, stdio: ["pipe", "inherit", "inherit"] });
    console.log(`committed: ${c.message.split("\n")[0]}`);
  }

  run("git", ["push", "-u", "origin", br]);
  if (noPr) return;

  const prBody = `${plan.pr.body.trim()}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`;
  const existing = execFileSync("gh", ["pr", "list", "--head", br, "--json", "url", "--jq", ".[0].url"], {
    encoding: "utf8",
  }).trim();
  if (existing) return console.log(`PR already open, pushed to it: ${existing}`);
  run("gh", ["pr", "create", "--base", "main", "--title", plan.pr.title, "--body", prBody]);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === "context" && arg) context(arg);
else if (cmd === "apply" && arg)
  apply(arg, { noPr: rest.includes("--no-pr"), dryRun: rest.includes("--dry-run") });
else {
  console.error("usage: ship.mjs context <outFile> | ship.mjs apply <planFile> [--no-pr] [--dry-run]");
  process.exit(2);
}
