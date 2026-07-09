#!/usr/bin/env node
/**
 * Cursor 委任の追跡レジストリ CLI（Claude Code オーケストレーション用）
 *
 * Usage:
 *   node .claude/skills/delegate-to-cursor/scripts/delegation.mjs new --task "..." [--spec §16.1] [--fb FB-...] [--worktree cursor-foo-20260703]
 *   node ... update DG-20260703-01 --status pending_review --chat-id <uuid> [--worktree-path <path>] [--note "..."]
 *   node ... list [--status pending_review,running]
 *   node ... show DG-20260703-01
 *   node ... parse-json < cursor-output.json
 *   node ... next-id
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, ".cursor", "delegations", "registry.json");

const STATUSES = [
  "planned",
  "running",
  "pending_review",
  "review_failed",
  "approved",
  "merged",
  "abandoned",
];

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { version: 1, delegations: [] };
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

function saveRegistry(reg) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
}

function nextId(reg) {
  const prefix = `DG-${todayYmd()}-`;
  const today = reg.delegations.filter((d) => d.id.startsWith(prefix));
  const seq = today.length + 1;
  return `${prefix}${String(seq).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function cmdNew(flags) {
  const reg = loadRegistry();
  const id = nextId(reg);
  const worktree =
    flags.worktree ?? `cursor-${(flags.task ?? "task").replace(/\s+/g, "-").slice(0, 24).toLowerCase()}-${todayYmd()}`;
  const now = new Date().toISOString();
  const entry = {
    id,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    task: flags.task ?? "",
    specRef: flags.spec ?? null,
    fbId: flags.fb ?? null,
    worktreeName: worktree,
    worktreePath: null,
    baseRef: flags.base_ref ?? null,
    chatId: null,
    model: "auto",
    retryCount: 0,
    acceptance: flags.acceptance ? flags.acceptance.split(",").map((s) => s.trim()) : [],
    review: {},
    blockers: [],
    notes: [],
  };
  reg.delegations.push(entry);
  saveRegistry(reg);
  console.log(JSON.stringify({ id, worktreeName: worktree, registryPath: REGISTRY_PATH }, null, 2));
}

function findEntry(reg, id) {
  const entry = reg.delegations.find((d) => d.id === id);
  if (!entry) {
    console.error(`Not found: ${id}`);
    process.exit(1);
  }
  return entry;
}

function cmdUpdate(id, flags) {
  const reg = loadRegistry();
  const entry = findEntry(reg, id);
  entry.updatedAt = new Date().toISOString();

  if (flags.status) {
    if (!STATUSES.includes(flags.status)) {
      console.error(`Invalid status: ${flags.status}. Valid: ${STATUSES.join(", ")}`);
      process.exit(1);
    }
    entry.status = flags.status;
  }
  if (flags.chat_id) entry.chatId = flags.chat_id;
  if (flags.worktree_path) entry.worktreePath = flags.worktree_path;
  if (flags.base_ref) entry.baseRef = flags.base_ref;
  if (flags.note) entry.notes.push({ at: entry.updatedAt, text: flags.note });
  if (flags.blocker) entry.blockers.push({ at: entry.updatedAt, text: flags.blocker });
  if (flags.review_key && flags.review_value) {
    entry.review[flags.review_key] = flags.review_value;
  }
  if (flags.retry) entry.retryCount = Number(flags.retry) || entry.retryCount + 1;

  saveRegistry(reg);
  console.log(JSON.stringify(entry, null, 2));
}

function cmdList(flags) {
  const reg = loadRegistry();
  let items = reg.delegations;
  if (flags.status) {
    const allowed = new Set(flags.status.split(",").map((s) => s.trim()));
    items = items.filter((d) => allowed.has(d.status));
  }
  if (flags.active) {
    const active = new Set(["planned", "running", "pending_review", "review_failed", "approved"]);
    items = items.filter((d) => active.has(d.status));
  }
  console.log(JSON.stringify({ count: items.length, delegations: items }, null, 2));
}

function cmdShow(id) {
  const reg = loadRegistry();
  console.log(JSON.stringify(findEntry(reg, id), null, 2));
}

function cmdNextId() {
  const reg = loadRegistry();
  console.log(nextId(reg));
}

function extractChatId(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.session_id ??
    obj.sessionId ??
    obj.chat_id ??
    obj.chatId ??
    obj.id ??
    (obj.result && extractChatId(obj.result)) ??
    null
  );
}

function cmdParseJson() {
  const raw = readFileSync(0, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Invalid JSON on stdin");
    process.exit(1);
  }
  const chatId = extractChatId(parsed);
  const summary =
    typeof parsed.result === "string"
      ? parsed.result.slice(0, 500)
      : typeof parsed.output === "string"
        ? parsed.output.slice(0, 500)
        : null;
  console.log(JSON.stringify({ chatId, summary, keys: Object.keys(parsed) }, null, 2));
}

function cmdHelp() {
  console.log(`delegation.mjs — Cursor 委任追跡レジストリ

Commands:
  new       --task "..." [--spec §16.1] [--fb FB-...] [--worktree name] [--base-ref HEAD]
  update    <DG-id> [--status running|pending_review|merged|...] [--chat-id uuid]
            [--worktree-path path] [--note "..."] [--blocker "..."]
            [--review-key typecheck --review-value pass]
  list      [--status pending_review,running] [--active]
  show      <DG-id>
  next-id
  parse-json   (stdin: cursor-agent --output-format json の生出力)

Registry: .cursor/delegations/registry.json
`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help") {
  cmdHelp();
  process.exit(0);
}

const { positional, flags } = parseArgs(rest);

switch (cmd) {
  case "new":
    cmdNew(flags);
    break;
  case "update":
    cmdUpdate(positional[0], flags);
    break;
  case "list":
    cmdList(flags);
    break;
  case "show":
    cmdShow(positional[0]);
    break;
  case "next-id":
    cmdNextId();
    break;
  case "parse-json":
    cmdParseJson();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    cmdHelp();
    process.exit(1);
}
