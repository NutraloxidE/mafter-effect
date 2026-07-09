#!/usr/bin/env node
/**
 * 思考モデル委任（Fable 5 / Opus 4.8）の追跡レジストリ CLI
 *
 * Usage:
 *   node .claude/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs new --task "..." --model claude-fable-5-thinking-high [--spec §16.1] [--readonly]
 *   node ... update RG-20260703-01 --status running --session-id <uuid> [--note "..."]
 *   node ... launch RG-20260703-01 [--sync]
 *   node ... list [--status running,pending_parent] [--active]
 *   node ... show RG-20260703-01
 *   node ... parse-json < cursor-output.json
 *   node ... next-id
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, ".cursor", "delegations", "reasoning-registry.json");
const HANDOFF_DIR = join(REPO_ROOT, ".cursor", "delegations", "handoffs");

const STATUSES = [
  "planned",
  "running",
  "pending_parent",
  "closed",
  "abandoned",
];

const DEFAULT_MODEL = "fable";

const MODEL_ALIASES = {
  "claude-fable-5-thinking-high": "fable",
  "claude-fable-5": "fable",
  fable: "fable",
  "claude-opus-4-8-thinking-high": "opus",
  "claude-opus-4-8": "opus",
  opus: "opus",
};

function toClaudeModelAlias(model) {
  return MODEL_ALIASES[model] ?? model;
}

function delegationPrompt(id, handoffPath) {
  const rel = handoffPath.replace(/\\/g, "/").replace(/^.*?\.cursor\//, ".cursor/");
  return (
    `${id}: Read ${rel}. Execute the block under ## 委任先へのプロンプト. ` +
    "Append ## Handback to that file using the template in .claude/skills/delegate-to-thinking-model/SKILL.md. " +
    "Do not edit source code."
  );
}

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
  const prefix = `RG-${todayYmd()}-`;
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

function handoffTemplate(id, task) {
  return `# ${id} — ${task || "（タイトル未設定）"}

## 親の目的（1–3 文）
<!-- Cursor が委任前に埋める -->

## 確定事項
-

## 未決・委任したい問い
1.

## 制約（触ってはいけないもの）
- §5 / INV / project.json 形式: 変更案は提案のみ

## 親が既に試したこと
-

## 戻り後に親がやること
- [ ] ユーザーに選択肢提示（推奨案 first）
- [ ] spec 更新なら先に spec → 実装
- [ ] 実装が必要なら delegate-to-cursor へ DG 起票

## 委任先へのプロンプト（コピー用）
<!-- プロンプト骨格を埋めた全文 -->

---

## Handback（委任先返答をここに貼る）

`;
}

function cmdNew(flags) {
  const reg = loadRegistry();
  const id = nextId(reg);
  const task = flags.task ?? "";
  const model = flags.model ?? DEFAULT_MODEL;
  const now = new Date().toISOString();
  const handoffPath = join(HANDOFF_DIR, `${id}.md`);

  mkdirSync(HANDOFF_DIR, { recursive: true });
  if (!existsSync(handoffPath)) {
    writeFileSync(handoffPath, handoffTemplate(id, task), "utf8");
  }

  const entry = {
    id,
    kind: "reasoning",
    status: "planned",
    createdAt: now,
    updatedAt: now,
    task,
    model,
    claudeModel: toClaudeModelAlias(model),
    readonly: Boolean(flags.readonly),
    specRef: flags.spec ?? null,
    sessionId: null,
    agentId: null,
    chatId: null,
    handoffPath: handoffPath.replace(/\\/g, "/"),
    parentActions: [],
    notes: [],
  };
  reg.delegations.push(entry);
  saveRegistry(reg);
  console.log(
    JSON.stringify(
      { id, model, handoffPath: entry.handoffPath, registryPath: REGISTRY_PATH },
      null,
      2,
    ),
  );
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
  if (flags.agent_id) entry.agentId = flags.agent_id;
  if (flags.session_id) entry.sessionId = flags.session_id;
  if (flags.chat_id) {
    entry.chatId = flags.chat_id;
    if (!entry.sessionId) entry.sessionId = flags.chat_id;
  }
  if (flags.model) entry.model = flags.model;
  if (flags.note) entry.notes.push({ at: entry.updatedAt, text: flags.note });
  if (flags.parent_action) {
    entry.parentActions.push({ at: entry.updatedAt, text: flags.parent_action });
  }

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
    const active = new Set(["planned", "running", "pending_parent"]);
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

function extractSessionId(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.session_id ??
    obj.sessionId ??
    obj.chat_id ??
    obj.chatId ??
    obj.id ??
    (obj.result && extractSessionId(obj.result)) ??
    null
  );
}

function cmdLaunch(id, flags) {
  const reg = loadRegistry();
  const entry = findEntry(reg, id);
  const model = toClaudeModelAlias(entry.model);
  const prompt = delegationPrompt(id, entry.handoffPath);
  const logPath = `.cursor/delegations/logs/${id}.json`;
  const bg = flags.sync ? "" : " --bg";
  const cmd =
    `claude${bg} -p --permission-mode plan --model ${model} --effort high ` +
    `--output-format json -n "${id}" "${prompt.replace(/"/g, '\\"')}"`;
  console.log(
    JSON.stringify(
      {
        id,
        model,
        sync: Boolean(flags.sync),
        handoffPath: entry.handoffPath,
        prompt,
        command: cmd,
        logHint: `... | Tee-Object -FilePath ${logPath}`,
        after: [
          `node .claude/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs parse-json < ${logPath}`,
          `node .claude/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs update ${id} --status running --session-id <uuid>`,
        ],
      },
      null,
      2,
    ),
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
  const sessionId = extractSessionId(parsed);
  const summary =
    typeof parsed.result === "string"
      ? parsed.result.slice(0, 500)
      : typeof parsed.output === "string"
        ? parsed.output.slice(0, 500)
        : typeof parsed.content === "string"
          ? parsed.content.slice(0, 500)
          : null;
  console.log(JSON.stringify({ sessionId, chatId: sessionId, summary, keys: Object.keys(parsed) }, null, 2));
}

function cmdHelp() {
  console.log(`reasoning-delegation.mjs — Claude Code (claude CLI) 思考委任追跡

Commands:
  new       --task "..." [--model fable|opus] [--spec §16.1] [--readonly]
  launch    <RG-id> [--sync]   (print recommended claude -p command)
  update    <RG-id> [--status running|pending_parent|closed|abandoned]
            [--session-id uuid] [--agent-id taskId] [--chat-id uuid] [--note "..."]
  list      [--status running,pending_parent] [--active]
  show      <RG-id>
  next-id
  parse-json   (stdin: claude -p --output-format json の生出力)

Delegatee: claude CLI (Claude Code), NOT cursor-agent / Cursor Task
Registry: .cursor/delegations/reasoning-registry.json
Handoffs: .cursor/delegations/handoffs/RG-*.md
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
  case "launch":
    cmdLaunch(positional[0], flags);
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
