// Export A/B against a remote worker, in real Chrome so nothing is throttled.
// Prints the join URL, waits for a worker to join, then exports twice and saves both zips
// so the frames can be compared byte by byte afterwards.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const APP = process.env.SWARM_APP_URL ?? "https://mafter-effect.pages.dev/";
const ZIP = path.resolve(process.env.SWARM_ZIP ?? "verify-comp33-mini-project.zip");
const FRAMES = Number(process.env.SWARM_FRAMES ?? 24);
const EXPORT_TIMEOUT_MS = Number(process.env.SWARM_EXPORT_TIMEOUT_MS ?? 600000);
const JOIN_WAIT_MS = Number(process.env.SWARM_JOIN_WAIT_MS ?? 600000);
const OUT = process.env.SWARM_OUT ?? ".";

const FRAMES_RE = /Frames from workers: [^\n]*/;
const PHASE_RE = /(Frame \d+\/\d+|Rendering frame \d+\/\d+|Packaging[^\n]*|Worker output rejected[^\n]*|Sending footage[^\n]*)/;
const text = (page) => page.evaluate(() => document.body.innerText);

async function runExport(page, label) {
  await page.evaluate((frames) => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Export"))?.click();
    window.__zipBase64 = null;
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob && blob.type === "application/zip") {
        blob.arrayBuffer().then((buffer) => {
          let binary = "";
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          window.__zipBase64 = btoa(binary);
        });
      }
      return originalCreate(blob);
    };
    window.__frames = frames;
  }, FRAMES);
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const selects = dialog.querySelectorAll("select");
    set(selects[0], [...selects[0].options].find((o) => o.text.includes("PNG")).value);
    set(selects[1], [...selects[1].options].find((o) => o.text.includes("0.5")).value);
    const inputs = dialog.querySelectorAll("input");
    set(inputs[0], "0");
    set(inputs[1], String(window.__frames));
  });
  await page.waitForTimeout(400);

  const startedAt = Date.now();
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export").click();
  });

  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__zipBase64 !== null)) break;
    await page.waitForTimeout(10000);
    const body = await text(page);
    console.log(`  ...${label}: ${PHASE_RE.exec(body)?.[0] ?? "-"} | ${FRAMES_RE.exec(body)?.[0] ?? "-"}`);
  }
  const seconds = (Date.now() - startedAt) / 1000;
  const base64 = await page.evaluate(() => window.__zipBase64);
  if (base64) await writeFile(path.join(OUT, `swarm-export-${label}.zip`), Buffer.from(base64, "base64"));
  const result = {
    label,
    seconds: Number(seconds.toFixed(1)),
    fps: base64 ? Number((FRAMES / seconds).toFixed(2)) : null,
    zipBytes: base64 ? Buffer.from(base64, "base64").length : null,
    panel: FRAMES_RE.exec(await text(page))?.[0] ?? "-",
  };
  console.log(JSON.stringify(result));

  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...(dialog?.querySelectorAll("button") ?? [])].find((b) => ["Close", "✕"].includes(b.textContent.trim()))?.click();
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  return result;
}

const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-certificate-errors"] });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, ignoreHTTPSErrors: true });
await context.addInitScript(() => window.localStorage.setItem("mafter.swarm.export", "1"));
const host = await context.newPage();
await host.goto(APP, { waitUntil: "domcontentloaded" });
await host.waitForTimeout(4000);
await host.setInputFiles('input[type=file][accept=".zip"]', ZIP);
await host.waitForTimeout(15000);
console.log("loaded:", JSON.stringify(await host.evaluate(() => {
  const state = window.__mafterEditorStore?.getState?.();
  const comp = state?.project?.compositions?.find((c) => c.id === state.currentCompId);
  return { comp: comp?.name, objects: comp?.objects?.length, visibility: document.visibilityState };
})));

const localOnly = await runExport(host, "local-only");

await host.locator("button", { hasText: "Workers" }).first().click({ timeout: 20000 });
await host.waitForTimeout(4000);
const joinUrl = await host.evaluate(() => (/https?:\/\/\S+\/w\/[A-Z0-9]+/.exec(document.body.innerText) ?? [])[0]);
console.log("JOIN URL:", joinUrl);

const joinDeadline = Date.now() + JOIN_WAIT_MS;
let approved = false;
while (Date.now() < joinDeadline && !approved) {
  const allow = host.locator("button", { hasText: "Allow" }).first();
  if (await allow.count() > 0) {
    await allow.click();
    approved = true;
    break;
  }
  await host.waitForTimeout(5000);
}
console.log("approved:", approved);
await host.waitForTimeout(12000);
console.log("panel:", /Connected[\s\S]{0,140}/.exec(await text(host))?.[0]?.replace(/\n/g, " "));

const withWorker = await runExport(host, "with-worker");
console.log("SUMMARY", JSON.stringify({ localOnly, withWorker }));
await browser.close();
