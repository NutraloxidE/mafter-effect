import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

// §11.7 再発防止: bundle export は `public/player.js`（ビルド済み成果物）を zip に埋め込む。
// src/player・src/runtime を変えて player を再ビルドし忘れると、古い player が出力され
// 「動画は出るが新機能だけ効かない」事故になる（expression preset の HTML 書き出し漏れが実例）。
// コミット済み player.js が今の src からの実ビルドと byte 一致することを保証する。
describe("player build freshness", () => {
  it("public/player.js matches a fresh build (else run: npm run build:player)", async () => {
    const out = mkdtempSync(join(tmpdir(), "mafter-player-build-"));
    await build({
      configFile: resolve("vite.player.config.ts"),
      logLevel: "silent",
      build: {
        outDir: out,
        emptyOutDir: true,
        copyPublicDir: false, // public/ を temp にコピーさせない（古い player.js の混入防止）
      },
    });

    const fresh = readFileSync(join(out, "player.js"), "utf8");
    const committed = readFileSync(resolve("public/player.js"), "utf8");

    expect(
      committed === fresh,
      "public/player.js is stale — run: npm run build:player and commit the result",
    ).toBe(true);
  }, 120000);
});
