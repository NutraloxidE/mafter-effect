#!/usr/bin/env node

// フィードバックループ Phase4 補助スクリプト（G12）。
// feedback/inbox/*.jsonl を集計し、決定論の JSON を stdout に出す。
// エージェント（summarize-user-feedback スキル）はこの JSON を読んで意味のあるテーマに再編し
// feedback/reports/summary-*.md を書く。本スクリプト自身は解釈・要約はしない（集計のみ）。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HELP_TEXT = `Summarize feedback/inbox/*.jsonl into a deterministic JSON report (stdout).

Usage:
  npm run summarize:feedback
  npm run summarize:feedback -- [options]

Options:
  --inbox <dir>   JSONL directory (default: feedback/inbox)
  --date <YYYY-MM-DD>  Only include this date's file (default: all files)
  --help          Show this help

Output (stdout, JSON):
  { generatedAt, rawEventCount, sessionCount, signalCounts, dailyCounts, quotes }
`;

function parseArgs(argv) {
  const options = { inbox: "feedback/inbox", date: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--inbox") options.inbox = next;
    else if (arg === "--date") options.date = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return options;
}

const MAX_QUOTES = 30;

async function listJsonlFiles(inboxDir, dateFilter) {
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .filter((e) => !dateFilter || e.name.startsWith(dateFilter))
    .map((e) => path.join(inboxDir, e.name))
    .sort();
}

async function readEvents(files) {
  const events = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        events.push(parsed);
      } catch {
        process.stderr.write(`[summarize:feedback] Skipping malformed line in ${file}\n`);
      }
    }
  }
  return events;
}

function summarize(events) {
  const sessionIds = new Set();
  const signalCounts = {};
  const dailyCounts = {};
  const quotes = [];

  for (const e of events) {
    if (typeof e.sessionId === "string") sessionIds.add(e.sessionId);

    if (Array.isArray(e.signals)) {
      for (const s of e.signals) {
        if (typeof s !== "string") continue;
        signalCounts[s] = (signalCounts[s] ?? 0) + 1;
      }
    }

    if (typeof e.ts === "string") {
      const day = e.ts.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        dailyCounts[day] = (dailyCounts[day] ?? 0) + 1;
      }
    }

    if (typeof e.message === "string" && e.message.trim().length > 0) {
      quotes.push({
        sessionId: typeof e.sessionId === "string" ? e.sessionId : "unknown",
        ts: typeof e.ts === "string" ? e.ts : "",
        message: e.message.trim(),
        signals: Array.isArray(e.signals) ? e.signals.filter((s) => typeof s === "string") : [],
      });
    }
  }

  // 新しい順、上限 MAX_QUOTES 件（エージェントが「代表コメント抜粋」に使う）。
  quotes.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return {
    generatedAt: new Date().toISOString(),
    rawEventCount: events.length,
    sessionCount: sessionIds.size,
    signalCounts,
    dailyCounts,
    quotes: quotes.slice(0, MAX_QUOTES),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }
  const inboxDir = path.resolve(process.cwd(), options.inbox);
  const files = await listJsonlFiles(inboxDir, options.date);
  const events = await readEvents(files);
  const report = summarize(events);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error) => {
  console.error(`[summarize:feedback] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
