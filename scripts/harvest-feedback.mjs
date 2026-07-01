#!/usr/bin/env node

// フィードバックループ Phase3: リモート ~/mafter-feedback/inbox/*.jsonl を SSH 経由で
// ローカル feedback/inbox/ へ収穫する。doc/feedback-loop.md 参照。
//
// G14（SSH 共通化）は v1 スコープ外（.cursor/plans/feedback_undefined_audit_091af114.plan.md）。
// scripts/deploy-ssh.mjs は module 化されておらず import すると main() が実行されてしまうため、
// 接続まわりの小さな helper はここに自己完結で持つ（意図的な重複。将来 v2 で共通化を検討）。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "ssh2";

const HELP_TEXT = `Harvest feedback JSONL files from the deploy host over SSH.

Usage:
  npm run harvest:feedback
  npm run harvest:feedback -- [options]

Options:
  --host <host>         Remote host (default: DEPLOY_HOST in .env)
  --user <user>         SSH user (default: from DEPLOY_HOST / .env)
  --port <port>         SSH port (default: DEPLOY_PORT in .env, or 22)
  --identity <file>     SSH private key file (default: DEPLOY_IDENTITY)
  --password <password> SSH password (default: DEPLOY_PASSWORD)
  --remote-dir <dir>    Remote feedback dir (default: FEEDBACK_REMOTE_DIR in .env, or ~/mafter-feedback)
  --local-dir <dir>     Local destination dir (default: feedback/inbox)
  --help                Show this help

Reuses the same .env keys as deploy:ssh (DEPLOY_HOST/USER/PORT/IDENTITY/PASSWORD)
plus FEEDBACK_REMOTE_DIR.
`;

function parseArgs(argv) {
  const options = { host: "", user: "", port: "", identity: "", password: "", remoteDir: "", localDir: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case "--host": options.host = next; break;
      case "--user": options.user = next; break;
      case "--port": options.port = next; break;
      case "--identity": options.identity = next; break;
      case "--password": options.password = next; break;
      case "--remote-dir": options.remoteDir = next; break;
      case "--local-dir": options.localDir = next; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
    i += 1;
  }
  return options;
}

async function readDotEnv(envPath) {
  try {
    const raw = await readFile(envPath, "utf8");
    const values = {};
    for (const originalLine of raw.split(/\r?\n/)) {
      const line = originalLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      const doubleQuoted = rawValue.startsWith('"') && rawValue.endsWith('"');
      const singleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
      values[key] = doubleQuoted || singleQuoted ? rawValue.slice(1, -1) : rawValue;
    }
    return values;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

function splitUserFromHost(options) {
  if (options.user || !options.host.includes("@")) return options;
  const at = options.host.indexOf("@");
  if (at <= 0 || at >= options.host.length - 1) return options;
  return { ...options, user: options.host.slice(0, at), host: options.host.slice(at + 1) };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function loadPrivateKey(identityPath) {
  if (!identityPath) return undefined;
  return readFile(path.resolve(process.cwd(), identityPath), "utf8");
}

async function connectSsh(options) {
  const privateKey = await loadPrivateKey(options.identity);
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => resolve(client));
    client.on("error", (error) => reject(error));
    client.connect({
      host: options.host,
      port: Number(options.port),
      username: options.user,
      password: options.password || undefined,
      privateKey,
      readyTimeout: 60000,
    });
  });
}

async function withSsh(options, callback) {
  const client = await connectSsh(options);
  try {
    return await callback(client);
  } finally {
    client.end();
  }
}

function execRemote(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `remote command exited with code ${code ?? "null"}`));
      });
      stream.on("data", (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function sftpReaddir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (error, list) => {
      if (error) {
        // ディレクトリが無い（フィードバックがまだ1件も届いていない）のは正常系。
        if (error.code === 2 /* ENOENT */) resolve([]);
        else reject(error);
      } else {
        resolve(list);
      }
    });
  });
}

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", (error) => reject(error));
    stream.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (cliOptions.help) {
    console.log(HELP_TEXT);
    return;
  }

  const envValues = await readDotEnv(path.resolve(process.cwd(), ".env"));
  const merged = {
    host: cliOptions.host || envValues.DEPLOY_HOST || "",
    user: cliOptions.user || envValues.DEPLOY_USER || "",
    port: cliOptions.port || envValues.DEPLOY_PORT || "22",
    identity: cliOptions.identity || envValues.DEPLOY_IDENTITY || "",
    password: cliOptions.password || envValues.DEPLOY_PASSWORD || "",
    remoteDir: cliOptions.remoteDir || envValues.FEEDBACK_REMOTE_DIR || "~/mafter-feedback",
    localDir: cliOptions.localDir || "feedback/inbox",
  };
  const options = splitUserFromHost(merged);

  if (!options.host) throw new Error("--host is required (or set DEPLOY_HOST in .env).\n\n" + HELP_TEXT);
  if (!options.user) throw new Error("--user is required (or include user@host in DEPLOY_HOST / --host).");
  if (!options.password && !options.identity) {
    throw new Error("Set either DEPLOY_PASSWORD / --password, or DEPLOY_IDENTITY / --identity.");
  }

  const localDir = path.resolve(process.cwd(), options.localDir);
  await mkdir(localDir, { recursive: true });

  const harvested = await withSsh(options, async (client) => {
    const remoteHome = await execRemote(client, 'printf %s "$HOME"');
    const remoteDirNormalized = options.remoteDir.trim().replace(/\\/g, "/");
    const remoteBase = remoteDirNormalized === "~" || remoteDirNormalized === "~/"
      ? remoteHome
      : remoteDirNormalized.startsWith("~/")
        ? `${remoteHome}/${remoteDirNormalized.slice(2)}`
        : remoteDirNormalized;
    const inboxDir = `${remoteBase}/inbox`;
    const archiveDir = `${remoteBase}/archive`;

    const sftp = await openSftp(client);
    let entries;
    try {
      entries = await sftpReaddir(sftp, inboxDir);
    } finally {
      sftp.end();
    }

    const jsonlFiles = entries
      .filter((e) => e.filename.endsWith(".jsonl") && e.longname[0] !== "d")
      .map((e) => e.filename);

    if (jsonlFiles.length === 0) {
      return [];
    }

    await execRemote(client, `mkdir -p ${shellQuote(archiveDir)}`);

    const results = [];
    for (const filename of jsonlFiles) {
      const remotePath = `${inboxDir}/${filename}`;
      const localPath = path.join(localDir, filename);

      const sftpRead = await openSftp(client);
      let bytes;
      try {
        bytes = await sftpReadFile(sftpRead, remotePath);
      } finally {
        sftpRead.end();
      }

      // G13: ローカル保存成功後のみリモートを archive へ移動する（部分失敗時に再試行可能）。
      await writeFile(localPath, bytes);
      const verifyBytes = await readFile(localPath);
      if (verifyBytes.length !== bytes.length) {
        console.warn(`[harvest:feedback] Skipping archive for ${filename}: local write verification mismatch.`);
        continue;
      }

      const archivePath = `${archiveDir}/${filename}`;
      await execRemote(
        client,
        `cp ${shellQuote(remotePath)} ${shellQuote(archivePath)} && rm -f ${shellQuote(remotePath)}`
      );
      results.push(filename);
    }
    return results;
  });

  if (harvested.length === 0) {
    console.log("[harvest:feedback] No new feedback files found.");
  } else {
    console.log(`[harvest:feedback] Harvested ${harvested.length} file(s) into ${localDir}:`);
    for (const f of harvested) console.log(`  - ${f}`);
  }
}

main().catch((error) => {
  console.error(`[harvest:feedback] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
