import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const SRC_DIR = "C:/Users/resis/AppData/Local/Temp/claude/C--Workspace-mafter-effect/07f5da17-01d6-4fa9-827e-8c1b854d7d6a/scratchpad/pj23";
const OUT_ZIP = path.resolve("verify-comp32-mini-project.zip");

const pj = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "project.json"), "utf8"));

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const ASSET_BG = "01KWR47Y1AJ3GNX9Q7XK7KT8K7";
const ASSET_PERSON = "01KWSS67VPRA5KE4HWC42D5AKG";

const comp32 = pj.compositions.find((c) => c.id === COMP32);
if (!comp32) throw new Error("Comp 32 not found");

const assets = pj.assets.filter((a) => a.id === ASSET_BG || a.id === ASSET_PERSON);
if (assets.length !== 2) throw new Error("expected 2 assets, got " + assets.length);

const binIds = new Set(assets.map((a) => a.binId).filter(Boolean));
const bins = pj.bins.filter((b) => binIds.has(b.id));

const mini = {
  schemaVersion: pj.schemaVersion,
  meta: pj.meta,
  pluginRefs: pj.pluginRefs,
  rootComposition: COMP32,
  bins,
  assets,
  compositions: [comp32],
};

const zip = new JSZip();
zip.file("project.json", JSON.stringify(mini, null, 2) + "\n");
for (const a of assets) {
  const filePath = path.join(SRC_DIR, a.path);
  zip.file(a.path, fs.readFileSync(filePath));
  if (a.meta?.alphaPath) {
    const alphaFilePath = path.join(SRC_DIR, a.meta.alphaPath);
    zip.file(a.meta.alphaPath, fs.readFileSync(alphaFilePath));
  }
}

const buf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
fs.writeFileSync(OUT_ZIP, buf);
console.log("wrote", OUT_ZIP, buf.length, "bytes");
