// master-nested-composite-performance-plan Phase 0 — 恒久 benchmark ランナー。
//
// 目的: 「Master 30fps に重量級 main 1(15fps) precomp を読み込む」構成の非破壊高速化について、
//   - duplicate child-frame 構造（266 unique / 531・49.9%）
//   - distinct vs 全 parent frame の resolve コスト（Phase 5 same-frame reuse の上限効果）
//   - 各 phase の op-count ゲート（Phase 2 outline build / Phase 3 bufferData）
// を synthetic fixture 上で計測・固定する。
//
// 実行: `node bench-master-nested-live.mjs`
//   - resolve baseline を計測し doc/cloudplan/master-nested-baseline.json を更新（BENCH_WRITE=1）。
//   - Phase 1/2/3 の parity + op-count テストも回す。
//
// 注意（環境制約・2026-07-19）: 元の 590MB 実プロジェクト ZIP は org egress policy により
//   この cloud 環境からは取得不可。GL/outline 側の wall-clock（Phase 2/3）と最終 max-ZIP benchmark は
//   実機（`npm run dev` + 実 Chrome + 実 ZIP import）で回す。ここでは pure-runtime の resolve baseline と
//   全 phase の op-count 回帰ゲートを担う。

import { spawnSync } from "node:child_process";

const TESTS = [
  "test/masterNestedBaseline.test.ts", // resolve baseline + duplicate 構造
  "test/interpolateBinarySearchParity.test.ts", // Phase 1
  "test/geom3d/preparedGeomCache.test.ts", // Phase 2 op-count
  "test/geom3d/meshBufferCache.test.ts", // Phase 3 op-count
];

console.log("[bench-master-nested-live] running resolve baseline + phase op-count gates…\n");

const res = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...TESTS], {
  stdio: "inherit",
  env: { ...process.env, BENCH_WRITE: "1" },
});

if (res.status !== 0) {
  console.error("\n[bench-master-nested-live] FAILED (see vitest output above)");
  process.exit(res.status ?? 1);
}
console.log("\n[bench-master-nested-live] OK — baseline written to doc/cloudplan/master-nested-baseline.json");
console.log("[bench-master-nested-live] GL wall-clock (Phase 2/3) + max-ZIP final benchmark: run on your machine with the real project.");
