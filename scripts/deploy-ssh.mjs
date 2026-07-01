#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const isWindows = process.platform === "win32";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `Deploy local build artifacts to a remote host over SSH.

Usage:
  npm run deploy:ssh
  npm run deploy:ssh -- [options]

Options:
  --host <host>               Remote host (required if DEPLOY_HOST is not set)
  --user <user>               SSH user (required if DEPLOY_HOST is not user@host)
  --port <port>               SSH port (default: 22)
  --identity <file>           SSH private key file
  --password <password>       SSH password (prefer DEPLOY_PASSWORD in .env)
  --local-path <path>         Local directory to upload (default: dist)
  --remote-path <path>        Remote destination directory (default: ~/mafter-effect)
  --site-host <host>          Public host for HTTPS cert (unused in v1 python-only serve; kept for v2 Caddy)
  --tls-email <email>         ACME account email (unused in v1; kept for v2 Caddy)
  --no-serve                  Skip remote web server setup
  --build                     Run "npm run build" before deploying
  --clean                     Remove remote-path contents before upload
  --token <token>             Feedback ingest Bearer token (prefer FEEDBACK_INGEST_TOKEN in .env)
  --help                      Show this help

.env keys:
  DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT, DEPLOY_PASSWORD, DEPLOY_IDENTITY,
  DEPLOY_LOCAL_PATH, DEPLOY_REMOTE_PATH, DEPLOY_SITE_HOST, DEPLOY_TLS_EMAIL,
  DEPLOY_BUILD, DEPLOY_CLEAN, DEPLOY_ENABLE_WEB,
  FEEDBACK_INGEST_TOKEN, FEEDBACK_REMOTE_DIR (default: ~/mafter-feedback)

Remote web serving (v1): a single stdlib python3 process
(scripts/mafter_http_server.py) serves the uploaded static files on :80 and,
when FEEDBACK_INGEST_TOKEN is set, POST /api/feedback (see doc/feedback-loop.md).
Caddy/Docker dual-path TLS termination is deferred to v2.

Example:
  npm run deploy:ssh
  npm run deploy:ssh -- --host root@ssh.gycp.party --port 10000
  npm run deploy:ssh -- --host 192.168.1.20 --user ubuntu --remote-path /var/www/app --build --clean
`;

function parseArgs(argv) {
  const options = {
    host: "",
    user: "",
    port: "",
    identity: "",
    password: "",
    localPath: "",
    remotePath: "",
    siteHost: "",
    tlsEmail: "",
    serve: true,
    build: false,
    clean: false,
    help: false,
    feedbackToken: "",
    feedbackRemoteDir: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--build") {
      options.build = true;
      continue;
    }
    if (arg === "--clean") {
      options.clean = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-serve") {
      options.serve = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--host":
        options.host = next;
        break;
      case "--user":
        options.user = next;
        break;
      case "--port":
        options.port = next;
        break;
      case "--identity":
        options.identity = next;
        break;
      case "--password":
        options.password = next;
        break;
      case "--local-path":
        options.localPath = next;
        break;
      case "--remote-path":
        options.remotePath = next;
        break;
      case "--site-host":
        options.siteHost = next;
        break;
      case "--tls-email":
        options.tlsEmail = next;
        break;
      case "--token":
        options.feedbackToken = next;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
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
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      const doubleQuoted = rawValue.startsWith('"') && rawValue.endsWith('"');
      const singleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
      const value = doubleQuoted || singleQuoted ? rawValue.slice(1, -1) : rawValue;
      values[key] = value;
    }
    return values;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseBoolean(value, fallback) {
  if (!value) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function mergeOptions(cliOptions, envValues) {
  const options = { ...cliOptions };
  options.host = options.host || envValues.DEPLOY_HOST || "";
  options.user = options.user || envValues.DEPLOY_USER || "";
  options.port = options.port || envValues.DEPLOY_PORT || "22";
  options.identity = options.identity || envValues.DEPLOY_IDENTITY || "";
  options.password = options.password || envValues.DEPLOY_PASSWORD || "";
  options.localPath = options.localPath || envValues.DEPLOY_LOCAL_PATH || "dist";
  options.remotePath = options.remotePath || envValues.DEPLOY_REMOTE_PATH || "~/mafter-effect";
  options.siteHost = options.siteHost || envValues.DEPLOY_SITE_HOST || "";
  options.tlsEmail = options.tlsEmail || envValues.DEPLOY_TLS_EMAIL || "";
  options.serve = options.serve && parseBoolean(envValues.DEPLOY_ENABLE_WEB, true);
  options.build = options.build || parseBoolean(envValues.DEPLOY_BUILD, false);
  options.clean = options.clean || parseBoolean(envValues.DEPLOY_CLEAN, false);
  options.feedbackToken = options.feedbackToken || envValues.FEEDBACK_INGEST_TOKEN || "";
  options.feedbackRemoteDir = options.feedbackRemoteDir || envValues.FEEDBACK_REMOTE_DIR || "~/mafter-feedback";
  return options;
}

function splitUserFromHost(options) {
  if (options.user || !options.host.includes("@")) {
    return options;
  }
  const at = options.host.indexOf("@");
  if (at <= 0 || at >= options.host.length - 1) {
    return options;
  }
  return {
    ...options,
    user: options.host.slice(0, at),
    host: options.host.slice(at + 1),
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteShellPath(remotePath) {
  const normalized = normalizeRemotePath(remotePath.trim());
  if (normalized === "~") {
    return '"$HOME"';
  }
  if (normalized.startsWith("~/")) {
    return `"$HOME/${normalized.slice(2)}"`;
  }
  return shellQuote(normalized);
}

async function withSsh(options, callback) {
  const client = await connectSsh(options);
  try {
    return await callback(client);
  } finally {
    client.end();
  }
}

function defaultSiteHost(host) {
  return host.replace(/^\[|\]$/g, "");
}

function isIpAddress(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":");
}

function normalizeRemotePath(remotePath) {
  return remotePath.replace(/\\/g, "/");
}

function resolveRemotePath(remotePath, remoteHome) {
  const normalized = normalizeRemotePath(remotePath.trim());
  if (normalized === "~") {
    return remoteHome;
  }
  if (normalized.startsWith("~/")) {
    return path.posix.join(remoteHome, normalized.slice(2));
  }
  return path.posix.normalize(normalized);
}

function resolveLocalCommand(command) {
  if (isWindows && command === "npm") {
    return "npm.cmd";
  }
  return command;
}

function runLocalCommand(command, args) {
  return new Promise((resolve, reject) => {
    if (isWindows && command === "npm") {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
        stdio: "inherit",
        shell: false,
      });
      child.on("error", (error) => reject(error));
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code ?? "null"}`));
        }
      });
      return;
    }

    const child = spawn(resolveLocalCommand(command), args, {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "null"}`));
      }
    });
  });
}

function assertSafeCleanTarget(remotePath) {
  const normalized = remotePath.trim();
  if (!normalized || normalized === "/" || normalized === "~" || normalized === "." || normalized === "..") {
    throw new Error(`Refusing to clean unsafe remote path: "${remotePath}"`);
  }
}

async function ensureLocalDirectory(localPath) {
  await access(localPath);
  const fileStat = await stat(localPath);
  if (!fileStat.isDirectory()) {
    throw new Error(`Local path is not a directory: ${localPath}`);
  }
}

async function collectLocalFiles(rootPath, currentPath = rootPath) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      files.push(...(await collectLocalFiles(rootPath, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      localPath: absolutePath,
      remotePath: relativePath.split("/").join(path.posix.sep),
    });
  }
  return files;
}

function isSftpUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /subsystem:\s*sftp/i.test(message) || /sftp\s+not\s+available/i.test(message);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const UPLOAD_PROGRESS_STEP = 1024 * 1024;

function logUploadProgress(transferred, total, progressState) {
  const clamped = Math.min(transferred, total);
  if (clamped >= total && progressState.lastLogged >= total) {
    return;
  }
  if (clamped - progressState.lastLogged < UPLOAD_PROGRESS_STEP && clamped < total) {
    return;
  }
  progressState.lastLogged = clamped;
  const pct = Math.min(100, Math.round((clamped / total) * 100));
  console.log(
    `[deploy:ssh] Upload progress: ${formatBytes(clamped)} / ${formatBytes(total)} (${pct}%)`
  );
}

function formatDeployError(error, options) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return [
      `Cannot reach ${options.user}@${options.host}:${options.port} (${message})`,
      "Check:",
      `- SSH server / tunnel is up on port ${options.port}`,
      `- Manual test: ssh -p ${options.port} ${options.user}@${options.host}`,
      "- Firewall, VPN, or ISP may block outbound connections to this port",
    ].join("\n");
  }
  return message;
}

async function loadPrivateKey(identityPath) {
  if (!identityPath) {
    return undefined;
  }
  const resolvedPath = path.resolve(process.cwd(), identityPath);
  return readFile(resolvedPath, "utf8");
}

async function connectSsh(options) {
  const privateKey = await loadPrivateKey(options.identity);
  const connectConfig = {
    host: options.host,
    port: Number(options.port),
    username: options.user,
    password: options.password || undefined,
    privateKey,
    readyTimeout: 60000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const client = new Client();
        client.on("ready", () => resolve(client));
        client.on("error", (error) => reject(error));
        client.connect(connectConfig);
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.log(`[deploy:ssh] Connection attempt ${attempt}/3 failed, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function execRemote(client, command, captureStdout = false) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `remote command exited with code ${code ?? "null"}`));
        }
      });

      stream.on("data", (chunk) => {
        const text = chunk.toString();
        if (captureStdout) {
          stdout += text;
        } else {
          process.stdout.write(text);
        }
      });

      stream.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
      });

      stream.end();
    });
  });
}

function execRemoteWithStdin(client, command, stdin, { onUploadComplete } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stderr = "";
      let uploadCompleteNotified = false;

      stream.on("error", (streamError) => reject(streamError));
      // Remote commands may write to stdout; if we do not drain it, the pipe
      // buffer fills and the remote process blocks forever (classic SSH deadlock).
      stream.on("data", () => {});
      stream.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
      });

      stream.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `remote command exited with code ${code ?? "null"}`));
        }
      });

      const chunkSize = 32 * 1024;
      const total = stdin.length;
      const progressState = { lastLogged: 0 };
      let offset = 0;

      function finishUpload() {
        if (!uploadCompleteNotified) {
          uploadCompleteNotified = true;
          onUploadComplete?.();
        }
        if (stream.writableNeedDrain) {
          stream.once("drain", () => stream.end());
        } else {
          stream.end();
        }
      }

      function writeNext() {
        if (offset >= total) {
          finishUpload();
          return;
        }
        const chunk = stdin.subarray(offset, offset + chunkSize);
        offset += chunk.length;
        logUploadProgress(offset, total, progressState);
        if (!stream.write(chunk)) {
          stream.once("drain", writeNext);
        } else {
          writeNext();
        }
      }
      writeNext();
    });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
      } else {
        resolve(sftp);
      }
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath, options = {}) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, options, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sftpWriteFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { encoding: "utf8", mode: 0o644 });
    stream.on("error", (error) => reject(error));
    stream.on("close", () => resolve());
    stream.end(content);
  });
}

async function uploadDirectoryViaSftp(client, localRoot, remoteRoot) {
  const files = await collectLocalFiles(localRoot);
  const directories = new Set([remoteRoot]);
  let totalBytes = 0;
  const filesWithSize = [];
  for (const file of files) {
    const fileStat = await stat(file.localPath);
    totalBytes += fileStat.size;
    filesWithSize.push({ ...file, size: fileStat.size });
    directories.add(path.posix.dirname(path.posix.join(remoteRoot, file.remotePath)));
  }

  await execRemote(
    client,
    `mkdir -p ${Array.from(directories)
      .sort()
      .map((directory) => shellQuote(directory))
      .join(" ")}`
  );

  console.log(
    `[deploy:ssh] Uploading ${formatBytes(totalBytes)} via SFTP to ${remoteRoot}... (may take a few minutes)`
  );

  const sftp = await openSftp(client);
  try {
    const progressState = { lastLogged: 0 };
    let transferredBeforeCurrentFile = 0;
    for (const file of filesWithSize) {
      const remoteFilePath = path.posix.join(remoteRoot, file.remotePath);
      await sftpFastPut(sftp, file.localPath, remoteFilePath, {
        step: (transferred) => {
          logUploadProgress(transferredBeforeCurrentFile + transferred, totalBytes, progressState);
        },
      });
      transferredBeforeCurrentFile += file.size;
      logUploadProgress(transferredBeforeCurrentFile, totalBytes, progressState);
    }
  } finally {
    sftp.end();
  }
}

async function uploadDirectoryViaTarOnClient(client, localRoot, remotePath) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mafter-deploy-"));
  const tarPath = path.join(tempDir, "bundle.tar.gz");

  try {
    console.log("[deploy:ssh] Creating local archive...");
    await runLocalCommand("tar", ["-czf", tarPath, "-C", localRoot, "."]);
    const archive = await readFile(tarPath);

    const remoteHome = await execRemote(client, 'printf %s "$HOME"', true);
    const remoteRoot = resolveRemotePath(remotePath, remoteHome);
    const remoteArchive = path.posix.join(remoteHome, ".mafter-deploy", "bundle.tar.gz");
    await execRemote(
      client,
      `mkdir -p ${shellQuote(remoteRoot)} ${shellQuote(path.posix.dirname(remoteArchive))}`
    );

    console.log(
      `[deploy:ssh] Uploading ${formatBytes(archive.length)} to ${remoteArchive}... (may take a few minutes)`
    );
    await execRemoteWithStdin(client, `cat > ${shellQuote(remoteArchive)}`, archive, {
      onUploadComplete: () => {
        console.log("[deploy:ssh] Upload finished, waiting for remote file write...");
      },
    });

    console.log(`[deploy:ssh] Extracting archive into ${remoteRoot}...`);
    await execRemote(
      client,
      `tar xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteRoot)} && rm -f ${shellQuote(remoteArchive)}`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function uploadDirectory(client, localRoot, remotePath) {
  const remoteHome = await execRemote(client, 'printf %s "$HOME"', true);
  const remoteRoot = resolveRemotePath(remotePath, remoteHome);
  await uploadDirectoryViaSftp(client, localRoot, remoteRoot);
}

// v1 確定（doc/feedback-loop.md Phase1, .cursor/plans/feedback_harvest_loop_bf981079.plan.md）:
// リモート配信は python 統合サーバ一本（scripts/mafter_http_server.py）。Caddy/Docker デュアルパスは v2。
// 実測（probe-deploy-remote.mjs, 2026-07-01）で Docker デーモンは常に未起動だったため、
// 旧来の「Docker があれば Caddy、無ければ python fallback」を廃し python 一本化する。
async function configureRemoteServer(client, options, remoteShellTarget) {
  const pythonReady = await execRemote(
    client,
    "command -v python3 >/dev/null 2>&1 && echo yes || echo no",
    true
  );
  if (pythonReady !== "yes") {
    throw new Error(
      "Files deployed but python3 is not available on the remote host for web serving (v1 requires python3; Caddy/Docker is v2). Re-run with --no-serve or install python3."
    );
  }

  const remoteHome = await execRemote(client, 'printf %s "$HOME"', true);
  const deployRoot = path.posix.join(remoteHome, ".mafter-deploy");
  const serverScriptPath = path.posix.join(deployRoot, "mafter_http_server.py");
  await execRemote(client, `mkdir -p ${shellQuote(remoteHome)} ${shellQuote(deployRoot)}`);

  // 13KB 超になり得るスクリプトを exec+base64 で送ると SSH channel request のサイズ制約に近づくため、
  // 既に確立済みの SFTP 経由（uploadDirectory と同じ機構）で書き込む。
  const serverScriptSource = await readFile(
    path.join(SCRIPT_DIR, "mafter_http_server.py"),
    "utf8"
  );
  const sftp = await openSftp(client);
  try {
    await sftpWriteFile(sftp, serverScriptPath, serverScriptSource);
  } finally {
    sftp.end();
  }

  // 非破壊条件3（起動の冪等化）: 旧 `python3 -m http.server` と前回起動の本サーバを止めてから再起動する。
  // これが無いと再デプロイのたびに :80 へ多重 bind して "address already in use" になる。
  // パターンは `[x]pattern` トリックで自己マッチを回避する: ssh2 の exec は複合コマンド全体を
  // 1つの `sh -c "..."` で実行するため、素の `pkill -f mafter_http_server.py` は
  // パターン文字列そのものを含む「このコマンドを実行中のシェル自身」にもマッチして
  // SIGTERM を受け、exec チャンネルが code=null（signal 終了）で落ちてしまう
  // （実機で確認済みのバグ。以降のコマンドが一切実行されず起動処理が丸ごと失敗する）。
  await execRemote(
    client,
    "pkill -f '[p]ython3 -m http.server' >/dev/null 2>&1 || true; " +
      "pkill -f '[m]after_http_server.py' >/dev/null 2>&1 || true; " +
      "sleep 1"
  );

  // トークン未設定なら --feedback-dir/--token を渡さない = static 専用（非破壊条件1: 既存 http.server 相当の挙動）。
  const feedbackArgs = options.feedbackToken
    ? ` --feedback-dir ${remoteShellPath(options.feedbackRemoteDir)}/inbox --token ${shellQuote(options.feedbackToken)}`
    : "";

  await execRemote(
    client,
    `nohup python3 ${shellQuote(serverScriptPath)} --port 80 --static ${remoteShellTarget}${feedbackArgs} ` +
      ">/tmp/mafter-http.log 2>&1 & disown; sleep 1; " +
      `echo 'Started mafter_http_server.py on :80${options.feedbackToken ? " (static+feedback)" : " (static-only, no FEEDBACK_INGEST_TOKEN)"}'`
  );
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (cliOptions.help) {
    console.log(HELP_TEXT);
    return;
  }

  const envValues = await readDotEnv(path.resolve(process.cwd(), ".env"));
  const mergedOptions = mergeOptions(cliOptions, envValues);
  const options = splitUserFromHost(mergedOptions);

  if (!options.host) {
    throw new Error("--host is required (or set DEPLOY_HOST in .env).\n\n" + HELP_TEXT);
  }
  if (!options.user) {
    throw new Error("--user is required (or include user@host in DEPLOY_HOST / --host).");
  }
  if (options.password && options.identity) {
    throw new Error("Use either --identity (key auth) or --password / DEPLOY_PASSWORD, not both.");
  }
  if (!options.password && !options.identity) {
    throw new Error("Set either DEPLOY_PASSWORD / --password, or DEPLOY_IDENTITY / --identity.");
  }

  if (!options.siteHost) {
    const inferredHost = defaultSiteHost(options.host);
    options.siteHost = isIpAddress(inferredHost) ? "" : inferredHost;
  }

  const localPath = path.resolve(process.cwd(), options.localPath);
  if (options.build) {
    await runLocalCommand("npm", ["run", "build"]);
  }
  await ensureLocalDirectory(localPath);

  const remoteShellTarget = remoteShellPath(options.remotePath);

  if (options.clean) {
    assertSafeCleanTarget(options.remotePath);
    await withSsh(options, (client) =>
      execRemote(
        client,
        `mkdir -p ${remoteShellTarget} && find ${remoteShellTarget} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`
      )
    );
  }

  await withSsh(options, async (client) => {
    try {
      await uploadDirectory(client, localPath, options.remotePath);
    } catch (error) {
      if (!isSftpUnavailable(error)) {
        throw error;
      }
      console.log("[deploy:ssh] SFTP unavailable, falling back to tar stream upload...");
      await uploadDirectoryViaTarOnClient(client, localPath, options.remotePath);
    }

    if (options.serve) {
      await configureRemoteServer(client, options, remoteShellTarget);
    }
  });

  console.log(`Deployment completed: ${localPath} -> ${options.user}@${options.host}:${options.remotePath}`);
}

main().catch(async (error) => {
  let options = { user: "", host: "", port: "" };
  try {
    const envValues = await readDotEnv(path.resolve(process.cwd(), ".env"));
    options = splitUserFromHost(mergeOptions(parseArgs(process.argv.slice(2)), envValues));
  } catch {
    // ignore option parse errors in the failure path
  }
  console.error(`[deploy:ssh] ${formatDeployError(error, options)}`);
  process.exitCode = 1;
});
