// "purini remix" プロジェクト（元 zip 682MB）から "main 1" comp をルートに、
// それが precomp として参照する comp を再帰的に閉包で集めた「再生可能な」軽量 mini pj を作る。
// リリックモーション2（"2-もう一人じゃないよって"、main 1 の frame 84–309）まで再生確認できる構成。
// 重いメディア（mkv 522M / wav 60M / mp4 40M）は事前に ffmpeg で短縮したものに差し替える
// （build-mini-comp10-zip.mjs と同じ抽出方式。ネスト閉包＋メディア差し替えを追加）。
//
// 使い方: 先に scratchpad 等で 3 アセットを短縮してから、そのディレクトリを渡す:
//   node build-mini-purini-remix-zip.mjs <trimmed-media-dir>
// trimmed-media-dir には out_mp4.mp4 / out_mkv.mkv / out_wav.wav を置く。
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const SRC_ZIP = process.env.SRC_ZIP ?? String.raw`C:\Users\resis\Downloads\mafter-project (12).purini remix (1).zip`;
const OUT_ZIP = path.resolve("test/fixtures/mini-purini-remix.zip");
const ROOT = "01KXM0PDAKZ1SB7YE28VGSMDD8"; // "main 1"
const MEDIA_DIR = process.argv[2];
if (!MEDIA_DIR) throw new Error("usage: node build-mini-purini-remix-zip.mjs <trimmed-media-dir>");

// asset id -> {file in MEDIA_DIR, updated meta fields}
const MEDIA = {
  "01KXN3M5W6YMZ5P0YTK63XRDNP": { file: "out_mp4.mp4", meta: { duration: 5, width: 640, height: 360 } },
  "01KXM0E0ATM935HR6699FEXC0Q": { file: "out_mkv.mkv", meta: { duration: 22, width: 640, height: 360 } },
  "01KXM0KAT93R0CMTFYAG34SD0A": { file: "out_wav.wav", meta: { duration: 22, sampleRate: 48000, channels: 2 } },
};

const srcZip = await JSZip.loadAsync(fs.readFileSync(SRC_ZIP));
const pj = JSON.parse(await srcZip.file("project.json").async("string"));
const byId = new Map(pj.compositions.map((c) => [c.id, c]));

// transitive closure of precomp (compId) references from ROOT
const compIds = new Set();
const stack = [ROOT];
while (stack.length) {
  const id = stack.pop();
  if (compIds.has(id) || !byId.has(id)) continue;
  compIds.add(id);
  for (const o of byId.get(id).objects ?? []) {
    for (const cmp of o.components ?? []) {
      if (typeof cmp.props?.compId === "string") stack.push(cmp.props.compId);
    }
  }
}
const compositions = [...compIds].map((id) => byId.get(id));
console.log("comp closure:", compositions.map((c) => c.name));

// assets referenced by any comp in the closure
const assetIds = new Set();
for (const c of compositions) {
  for (const o of c.objects ?? []) {
    for (const cmp of o.components ?? []) {
      if (typeof cmp.props?.asset === "string") assetIds.add(cmp.props.asset);
    }
  }
}
const assets = pj.assets
  .filter((a) => assetIds.has(a.id))
  .map((a) => (MEDIA[a.id] ? { ...a, meta: { ...a.meta, ...MEDIA[a.id].meta } } : a));
console.log("referenced assets:", assets.map((a) => ({ id: a.id, path: a.path, kind: a.kind })));

const binIds = new Set(assets.map((a) => a.binId).filter(Boolean));
const bins = (pj.bins ?? []).filter((b) => binIds.has(b.id));

const mini = {
  schemaVersion: pj.schemaVersion,
  meta: pj.meta,
  pluginRefs: pj.pluginRefs,
  rootComposition: ROOT,
  bins,
  assets,
  compositions,
};

const outZip = new JSZip();
outZip.file("project.json", JSON.stringify(mini, null, 2) + "\n");
for (const a of assets) {
  const paths = [a.path, a.meta?.alphaPath, a.meta?.originalPath].filter(Boolean);
  for (const p of new Set(paths)) {
    if (MEDIA[a.id] && p === a.path) {
      outZip.file(p, fs.readFileSync(path.join(MEDIA_DIR, MEDIA[a.id].file)));
      continue;
    }
    const entry = srcZip.file(p);
    if (!entry) { console.warn("WARN: asset bytes missing in source zip:", p); continue; }
    outZip.file(p, await entry.async("nodebuffer"));
  }
}

fs.mkdirSync(path.dirname(OUT_ZIP), { recursive: true });
const buf = await outZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
fs.writeFileSync(OUT_ZIP, buf);
console.log("wrote", OUT_ZIP, (buf.length / 1024 / 1024).toFixed(2), "MB");
