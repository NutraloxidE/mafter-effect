import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const p = join(here, "p.json");
const ship = ".claude/skills/ship-it/scripts/ship.mjs";
const files = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
  .split("\n").filter(Boolean).map((l) => l.slice(3));
const pr = { title: "t", body: "b" };
let bad = 0;

const check = (plan, label, shouldAccept) => {
  writeFileSync(p, JSON.stringify(plan));
  let accepted = true, err = "";
  try {
    execFileSync("node", [ship, "apply", p, "--dry-run"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    accepted = false;
    err = String(e.stderr || e).split("\n").slice(1, 2).join("");
  }
  const ok = accepted === shouldAccept;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${accepted ? "" : ` -> ${err}`}`);
};

check({ commits: [{ message: "chore: all", files }], pr }, "all files, one commit -> accept", true);
check({ commits: [{ message: "a", files: files.slice(1) }], pr }, "missing file -> reject", false);
check({ commits: [{ message: "a", files }, { message: "b", files: [files[0]] }], pr }, "duplicate file -> reject", false);
check({ commits: [{ message: "a", files: [...files, "ghost.ts"] }], pr }, "ghost file -> reject", false);
process.exit(bad ? 1 : 0);
