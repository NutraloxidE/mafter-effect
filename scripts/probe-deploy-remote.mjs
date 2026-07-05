#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "ssh2";

async function readDotEnv(envPath) {
  const raw = await readFile(envPath, "utf8");
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) continue;
    values[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
  }
  return values;
}

function execRemote(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      stream.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

const env = await readDotEnv(path.resolve(process.cwd(), ".env"));
const hostRaw = env.DEPLOY_HOST ?? "";
const at = hostRaw.indexOf("@");
const user = env.DEPLOY_USER || (at > 0 ? hostRaw.slice(0, at) : "");
const host = at > 0 ? hostRaw.slice(at + 1) : hostRaw;
const port = Number(env.DEPLOY_PORT || 22);

const client = new Client();
await new Promise((resolve, reject) => {
  client.on("ready", resolve).on("error", reject);
  client.connect({
    host,
    port,
    username: user,
    password: env.DEPLOY_PASSWORD,
    readyTimeout: 60000,
  });
});

const blocks = [
  ["uname", "uname -a"],
  ["docker-bin", "command -v docker || echo NO_DOCKER_BIN"],
  ["docker-info-full", "docker info 2>&1 | head -15 || true"],
  ["docker-why-fail", "docker info 2>&1 | tail -5; echo exit:$?"],
  ["listen-all", "cat /proc/net/tcp 2>/dev/null | head -5; lsof -i :80 2>/dev/null | head -5 || true"],
  ["deploy-site-dns", `getent hosts ${host} 2>/dev/null || true`],
  ["port-80", "ss -ltnp 2>/dev/null | grep ':80' || netstat -ltnp 2>/dev/null | grep ':80' || echo NO_LISTENER"],
  ["http-procs", "ps aux | grep http.server | grep -v grep || echo NO_HTTP_SERVER_PROC"],
  ["mafter-deploy-dir", "ls -la $HOME/.mafter-deploy 2>/dev/null || echo NO_MAFTER_DEPLOY"],
  ["caddy-container", "docker ps -a --filter name=mafter-caddy 2>/dev/null || echo NO_DOCKER_PS"],
  ["curl-local", "curl -sI http://127.0.0.1/ | head -10"],
  ["caddyfile", "cat $HOME/.mafter-deploy/Caddyfile 2>/dev/null || echo NO_CADDYFILE"],
  ["nginx-hint", "curl -sI http://127.0.0.1:443 2>/dev/null | head -5 || echo NO_LOCAL_443"],
  ["feedback-dir", "ls -la $HOME/mafter-feedback 2>/dev/null || echo NO_FEEDBACK_DIR"],
  ["python-version", "python3 --version 2>&1"],
  ["node-version", "node --version 2>&1 || echo NO_NODE"],
];

for (const [label, cmd] of blocks) {
  const result = await execRemote(client, cmd);
  console.log(`\n=== ${label} (exit ${result.code}) ===`);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

client.end();
