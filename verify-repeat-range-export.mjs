// Does a second export in the same page produce the same pixels as the first?
//
// A swarm worker renders one block per job through exportComposition, and every block after the
// first came back ~13x smaller than the first — small enough that the host's spot check rejected
// it. This reproduces that without a worker: export the same short range twice in one page and
// compare the zips byte for byte.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const APP = process.env.APP_URL ?? "https://localhost:5175/";
const ZIP = path.resolve(process.env.FIXTURE ?? "verify-comp33-mini-project.zip");
const RANGES = JSON.parse(process.env.RANGES ?? "[[142,150],[134,142],[134,142]]");

const text = (page) => page.evaluate(() => document.body.innerText);

async function exportRange(page, [start, end]) {
  await page.evaluate(() => {
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
  });
  await page.waitForTimeout(1200);
  await page.evaluate(({ start, end }) => {
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
    set(inputs[0], String(start));
    set(inputs[1], String(end));
  }, { start, end });
  await page.waitForTimeout(400);
  const startedAt = Date.now();
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export").click();
  });
  while (Date.now() - startedAt < 180000) {
    if (await page.evaluate(() => window.__zipBase64 !== null)) break;
    await page.waitForTimeout(2000);
  }
  const base64 = await page.evaluate(() => window.__zipBase64);
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...(dialog?.querySelectorAll("button") ?? [])].find((b) => ["Close", "✕"].includes(b.textContent.trim()))?.click();
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  if (!base64) throw new Error(`export ${start}-${end} produced no zip`);
  const bytes = Buffer.from(base64, "base64");
  return { start, end, bytes, seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)) };
}

const ctx = await chromium.launchPersistentContext(
  path.join(process.env.TEMP ?? ".", "mafter-repeat-export-profile"),
  { channel: "chrome", headless: false, viewport: { width: 1180, height: 820 }, ignoreHTTPSErrors: true, args: ["--ignore-certificate-errors"] },
);
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("PAGEERR:", m.text().slice(0, 200)); });
await page.goto(`${APP}?cb=${Date.now()}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.setInputFiles('input[type=file][accept=".zip"]', ZIP);
await page.waitForTimeout(15000);
console.log("loaded:", (await text(page)).slice(0, 60).replace(/\n/g, " "));

const results = [];
for (const range of RANGES) {
  const result = await exportRange(page, range);
  const digest = createHash("sha256").update(result.bytes).digest("hex").slice(0, 12);
  const frames = result.end - result.start;
  console.log(JSON.stringify({
    range: `${result.start}-${result.end}`,
    seconds: result.seconds,
    bytes: result.bytes.length,
    bytesPerFrame: Math.round(result.bytes.length / frames),
    sha: digest,
  }));
  await writeFile(`repeat-export-${results.length}-${result.start}-${result.end}.zip`, result.bytes);
  results.push({ ...result, digest });
}

// The same range exported twice must produce the same bytes; anything else means an export leaves
// state behind that changes the next one.
const repeats = new Map();
for (const result of results) {
  const key = `${result.start}-${result.end}`;
  const previous = repeats.get(key);
  if (previous) console.log(previous.digest === result.digest ? `SAME ${key}` : `DIFFERENT ${key}`);
  repeats.set(key, result);
}
await ctx.close();
