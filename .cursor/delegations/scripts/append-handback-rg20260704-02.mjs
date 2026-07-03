import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const termPath =
  "C:/Users/resis/.cursor/projects/c-Workspace-mafter-effect/terminals/715097.txt";
const handoffPath =
  "C:/Workspace/mafter-effect/.cursor/delegations/handoffs/RG-20260704-02.md";

const term = readFileSync(termPath, "utf8");
const line = term.split("\n").find((l) => l.startsWith('{"type":"result"'));
if (!line) throw new Error("no result line");
const payload = JSON.parse(line);
const result = payload.result;
const idx = result.indexOf("## Handback");
if (idx < 0) throw new Error("no Handback");
const handback = "\n\n" + result.slice(idx).trimEnd() + "\n";
const existing = readFileSync(handoffPath, "utf8");
if (!existing.includes("## Handback\n")) {
  appendFileSync(handoffPath, handback);
  console.log("Appended Handback");
} else {
  console.log("Handback already present");
}
writeFileSync(
  "C:/Workspace/mafter-effect/.cursor/delegations/logs/RG-20260704-02.json",
  line + "\n",
);
console.log("session_id", payload.session_id);
// print TLDR section for parent
console.log(result.slice(0, 800));
