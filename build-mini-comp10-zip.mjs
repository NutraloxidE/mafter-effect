// Comp 10（audio + video レイヤーを持つ唯一の comp）だけを最新プロジェクト zip から抜き出して
// 小さな mini project zip を作る。209MB の全プロジェクトをブラウザに import すると tab が OOM する
// ため（build-mini-comp33-zip.mjs と同じ理由・同じ構造）。
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const SRC_ZIP = process.env.SRC_ZIP ?? String.raw`C:\Users\resis\Downloads\mafter-project (23).zip`;
const OUT_ZIP = path.resolve("verify-comp10-mini-project.zip");
const COMP10 = "01KVV05RE10X4E9H1AR77JPCH7";

const srcZip = await JSZip.loadAsync(fs.readFileSync(SRC_ZIP));
const pj = JSON.parse(await srcZip.file("project.json").async("string"));

const comp10 = pj.compositions.find((c) => c.id === COMP10);
if (!comp10) throw new Error("Comp 10 not found");

// Comp 10 の objects が参照する asset id を全部集める（component props.asset）。
const assetIds = new Set();
for (const obj of comp10.objects) {
  for (const cmp of obj.components ?? []) {
    if (typeof cmp.props?.asset === "string") assetIds.add(cmp.props.asset);
  }
}
const assets = pj.assets.filter((a) => assetIds.has(a.id));
console.log("referenced assets:", assets.map((a) => ({ id: a.id, path: a.path, kind: a.meta?.footageKind })));

const binIds = new Set(assets.map((a) => a.binId).filter(Boolean));
const bins = (pj.bins ?? []).filter((b) => binIds.has(b.id));

const mini = {
  schemaVersion: pj.schemaVersion,
  meta: pj.meta,
  pluginRefs: pj.pluginRefs,
  rootComposition: COMP10,
  bins,
  assets,
  compositions: [comp10],
};

const outZip = new JSZip();
outZip.file("project.json", JSON.stringify(mini, null, 2) + "\n");
for (const a of assets) {
  const paths = [a.path, a.meta?.alphaPath, a.meta?.originalPath].filter(Boolean);
  for (const p of new Set(paths)) {
    const entry = srcZip.file(p);
    if (!entry) { console.warn("WARN: asset bytes missing in source zip:", p); continue; }
    outZip.file(p, await entry.async("nodebuffer"));
  }
}

const buf = await outZip.generateAsync({ type: "nodebuffer", compression: "STORE" });
fs.writeFileSync(OUT_ZIP, buf);
console.log("wrote", OUT_ZIP, buf.length, "bytes");
console.log("comp10 objects:", comp10.objects.map((o) => ({
  id: o.id,
  name: o.name,
  types: (o.components ?? []).map((c) => c.type),
  enabled: o.enabled,
})));
