# 実装PLAN: Preview Rendering Pipeline Optimization & IndexedDB Bottlenecks

> **元課題**: [preview-rendering-pipeline-optimization-indexeddb.md](preview-rendering-pipeline-optimization-indexeddb.md)
> **状態**: 2026-07-07 実装PLAN（フェーズ分割・Sonnet 5 実装向け）
> **前提**: WebGL video layer 最適化（Phase 3）完了済み。次はプレビュー起動経路（JS ロード / video decode / IndexedDB / deserialize）を最適化する。
> **関連 INV**: **INV-2**（preview ↔ browser export ↔ headless export の scene 解決値一致）/ **INV-4**（IndexedDbFs と NodeFs の同一パス構成）
> **原則**: 「先に spec、次に実装」。ただし本PLANの Phase 1〜4 は **§5 スキーマ・INV・project.json 直列化形式に触れない**（実装/リファクタ扱い）。Phase 5 のみ設計確認が必要（後述）。

---

## 全体方針とフェーズ順序

各フェーズは **独立して単体マージ可能**。リスクが低く効果が大きい順に並べる。Phase 0（計測）を最初に入れて before/after を数値で固定する。

| Phase | 内容 | リスク | 主効果 | 依存 |
|------:|------|:------:|--------|------|
| **0** | 計測ハーネス（before/after 固定） | なし | 効果の可視化・回帰検出 | なし |
| **1** | dev サーバ HTTP/2 (basic-ssl) | 低 | JS 直列ロード解消（dev のみ・LCP Render delay 大幅減） | なし |
| **2** | `decodeVideoEntry` の slice 除去 + Web Worker オフロード | 中 | メインスレッド数百ms のフリーズ解消 | なし |
| **3** | `IndexedDbFs.readBatch` + 優先度ソート + フレーム譲渡 | 中 | 起動時のバイナリ一括流し込み由来の Layout ブロック解消 | なし |
| **4** | `deserializeProject` の Uint8Array 直接デコード | 低 | 中間文字列割り当て削減（250ms級パースの一部） | なし |
| **5** | Electron 実FS（NodeFs）切り替え | 高 | デスクトップ版 I/O 劇的改善 | 要設計確認・別マイルストーン |

> **重要な横断ルール（INV-2）**: Phase 2〜5 は preview 経路のバイナリ取得方法を変えるが、**scene 解決値（ピクセル）を一切変えてはならない**。`decodeVideoEntry` が返す `url` の「中身」と `size` は不変。変えるのは「どのスレッド・どの順序・どの API で作るか」だけ。各フェーズの完了条件に既存 verify の無回帰を含める。

---

## Phase 0: 計測ハーネス（最初に必ず入れる）

### 目的
最適化の before/after を再現可能な数値で残す。体感でなく数値で回帰を検出する。

### 実装
1. `scripts/` に `probe-preview-startup.mjs` を追加（既存の `probe-*.mjs` / `verify-*.mjs` と同じ Playwright + Chromium 駆動、port 5175。参照: memory `runtime-verify-harness`）。
2. 計測項目（`performance.now()` / `PerformanceObserver` をページ内 `evaluate` で収集）:
   - プロジェクトロード開始 → 最初の `renderTick` 反映（初期プレビュー描画）までの wall time
   - `loadFromProject` の総時間（`imageAssetCache` 呼び出しを一時的に計測ラップ、または `performance.mark`）
   - Long task（`PerformanceObserver({ type: "longtask" })`）の件数と最大 duration
   - LCP（`largest-contentful-paint`）
3. 十分な動画/画像アセットを含むテストプロジェクトを 1 つ固定（`for-debug-data/` の既存の大きめ pj を利用可）。
4. 出力を `probe-preview-startup-report.md` に before 値として記録。

### 完了条件
- `node scripts/probe-preview-startup.mjs` が数値を出力し、report に baseline が残る。
- 以降の各 Phase 完了時に同スクリプトを再実行し、report に after を追記する。

---

## Phase 1: dev サーバ HTTP/2 化（basic-ssl）

### 目的
HTTP/1.1 の 6 接続上限で 200+ の JS モジュールが直列ロードされる問題（元課題 §3）を dev で解消する。

### 対象ファイル
- `package.json`（devDependency 追加）
- [vite.config.ts](../../vite.config.ts)

### 実装ステップ
1. `npm i -D @vitejs/plugin-basic-ssl` を実行。
2. [vite.config.ts](../../vite.config.ts) を編集:
   ```typescript
   import basicSsl from "@vitejs/plugin-basic-ssl";
   // ...
   // Electron dev は wait-on / ELECTRON_RENDERER_URL が http:// 固定なので https 化しない。
   const enableHttps = !process.env.ELECTRON_DEV_PORT && !process.env.ELECTRON_FILE;
   export default defineConfig({
     plugins: [react(), ...(enableHttps ? [basicSsl()] : [])],
     // ...
     server: {
       host: true,
       ...(enableHttps ? { https: true } : {}),
       // 既存の strictPort / proxy はそのまま
     },
   });
   ```
3. `/api/feedback` proxy の `target` は `http://127.0.0.1:5174` のまま（feedback server は http のローカル。https 化不要）。

### 注意・回帰ガード
- **Electron 経路を壊さない**: `ELECTRON_DEV_PORT` / `ELECTRON_FILE` セット時は https を無効化する分岐を必ず入れる（wait-on と ELECTRON_RENDERER_URL が http:// 前提のため）。
- **既存の Playwright verify（port 5175）**: https 化で `page.goto("http://localhost:5175")` が動かなくなる可能性。verify ハーネスは `https://localhost:5175` + `ignoreHTTPSErrors: true`（`browser.newContext({ ignoreHTTPSErrors: true })`）に更新する。**Phase 0 のハーネス作成時にこの前提を織り込む**こと。
- 自己署名証明書の初回警告は dev のみ・許容。production ビルドには無関係（本番は実サーバ側で HTTP/2 提供）。

### 完了条件
- `npm run dev` が https で起動し、DevTools Network で JS モジュールが h2 で並列ロードされる。
- Phase 0 ハーネスで LCP Render delay が baseline より短縮していることを確認。
- `npm run electron:dev`（もしくは該当スクリプト）が従来通り起動する（http のまま）。

---

## Phase 2: `decodeVideoEntry` の slice 除去 + Web Worker オフロード

### 目的
[imageAssetCache.ts:447-456](../../src/runtime/imageAssetCache.ts#L447-L456) の `ArrayBuffer.slice`（241ms）+ `Blob` 生成 + `createObjectURL`（341ms）がメインスレッドを数百ms フリーズさせる問題（元課題 §1）を解消する。

### ⚠️ 実装前に必ず理解する罠（重要）
**Worker 内で `URL.createObjectURL` した `blob:` URL は、メインスレッドの `<video src>` から参照できない。** blob URL は生成した実行コンテキスト（agent）にスコープされ、Worker 破棄時に失効する。元課題 §1 の「Worker 内で createObjectURL して url 文字列を返す」案をそのまま実装すると **動画が読めなくなる**。

**正しい設計**: Worker には重いコピー（slice 相当）と `Blob` 構築だけをやらせ、**`Blob` オブジェクトをメインスレッドに返し、`createObjectURL` はメインスレッドで呼ぶ**。`Blob` は structured clone で postMessage 越しに（実装上は参照渡しで）安価に返せる。これで:
- slice コピー + Blob アロケーションはメインスレッド外
- URL 発行はメインスレッド（正しいスコープ・既存の `blobUrls` 解放ロジックがそのまま効く）

### サブステップ 2a（先行・単体で効く低リスク改善）
Worker 化の前に、まず **メインスレッドの slice を除去**する。`new Blob([buf], ...)` は `Uint8Array` ビューを直接受け取れるため、`slice` は不要:
```typescript
function decodeVideoEntry(buf: Uint8Array, mime: string, meta): ImageEntry {
  // slice 不要: Blob は Uint8Array ビューを直接コピーする（241ms の手動 slice を削減）
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  const size = ImageAssetCache.sizeFromMeta(meta) ?? { width: 100, height: 100 };
  return { url, size };
}
```
これは同期のままで API 変更なし。まずこれをコミットして Phase 0 で効果測定 → 次に 2b。

> 注: `decodeImageEntry`（[L374-L432](../../src/runtime/imageAssetCache.ts#L374)）内の `buf.buffer.slice(...)` も同様に、`createImageBitmap(new Blob([buf], ...))` へ置換して slice を除去できる（画像も同じ罠はない＝bitmap は同期返し）。ただし画像は既に bitmap 経由で軽いので優先度低。同一コミットで整理してよい。

### サブステップ 2b（Worker オフロード）
1. `src/runtime/workers/videoBlob.worker.ts` を新規作成（既存 [pngEncode.worker.ts](../../src/runtime/workers/pngEncode.worker.ts) / [rasterProcess.worker.ts](../../src/runtime/workers/rasterProcess.worker.ts) と同じ `type: "module"` 規約）:
   ```typescript
   export interface VideoBlobRequest { id: number; buffer: ArrayBuffer; mime: string; }
   export interface VideoBlobResponse { id: number; blob?: Blob; error?: string; }
   self.onmessage = (ev: MessageEvent<VideoBlobRequest>) => {
     const { id, buffer, mime } = ev.data;
     try {
       // buffer は transfer 済み（コピーゼロ）。Worker 側で Blob を構築。
       const blob = new Blob([buffer], { type: mime });
       (self as unknown as Worker).postMessage({ id, blob } satisfies VideoBlobResponse);
     } catch (e) {
       (self as unknown as Worker).postMessage({ id, error: String(e) });
     }
   };
   ```
2. `src/runtime/videoBlobDecode.ts` を新規作成（[pngEncode.ts](../../src/runtime/pngEncode.ts) の `ensureWorker` / pending Map / main-thread フォールバック構造を踏襲）:
   - `ensureWorker()`（`typeof Worker === "undefined"` ならフォールバック）
   - `export async function decodeVideoBlobUrl(buf: Uint8Array, mime: string): Promise<string>`
     - Worker あり: `buf.buffer` を **transfer** して送る（`buf` が sharedbuffer/オフセット付きの場合は `buf.slice().buffer` で独立 ArrayBuffer を作ってから transfer）。返ってきた `Blob` に **メインスレッドで** `URL.createObjectURL` を適用して url を返す。
     - Worker なし（フォールバック）: `URL.createObjectURL(new Blob([buf], { type: mime }))`（= 2a と同じ同期処理）。
   - `export function disposeVideoBlobWorker()`（テスト用リセット。pngEncode と同じ）。
   - **transfer で `buf.buffer` が detach される点に注意**: `fs.read` が返す buffer を transfer した後に同じ buffer を他所で使わないこと。imageAssetCache の各 read はその都度独立に取得しているので通常は安全だが、`byPath` キャッシュヒット経路（既存 entry 再利用）は decode 自体を呼ばないため影響なし。
3. [imageAssetCache.ts](../../src/runtime/imageAssetCache.ts) の `decodeVideoEntry` を **非同期化**し `size` は従来通りメインで付与:
   ```typescript
   async function decodeVideoEntry(buf, mime, meta): Promise<ImageEntry> {
     const url = await decodeVideoBlobUrl(buf, mime);
     const size = ImageAssetCache.sizeFromMeta(meta) ?? { width: 100, height: 100 };
     return { url, size };
   }
   ```
4. **全呼び出し元を `await` 化**（同期呼びが残ると型エラー・破綻する）:
   - `loadFromProject` [L153-154](../../src/runtime/imageAssetCache.ts#L153): `await decodeVideoEntry(...)`
   - `loadProxiesFromFs` [L190](../../src/runtime/imageAssetCache.ts#L190): `entry = await decodeVideoEntry(...)`
   - `loadSplitAlphaFromFs` [L229](../../src/runtime/imageAssetCache.ts#L229): `const entry = await decodeVideoEntry(...)`
   - `loadVideoBlobsFromUrls` [L333](../../src/runtime/imageAssetCache.ts#L333): `const entry = await decodeVideoEntry(...)`
   - `registerProjectUrls`（[L278](../../src/runtime/imageAssetCache.ts#L278)）は `decodeVideoEntry` を **呼ばない**（urlForPath 直参照）ので変更不要。

### 回帰ガード（INV-2・全 export 経路）
CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」節に従う。`imageAssetCache` は preview/bundle 両方で使われる共有経路なので:
- `npm test`（特に [test/imageAssetCache.test.ts](../../test/imageAssetCache.test.ts)）を緑に。Worker が無い node 環境ではフォールバック経路が走ることを確認（`disposeVideoBlobWorker` でリセット可能に）。
- 既存の video 系 verify を無回帰確認: [verify-video-export.mjs](../../verify-video-export.mjs) / [verify-video-export-monotonic.mjs](../../verify-video-export-monotonic.mjs) / split-alpha / packed 系。
- **bundle player 再ビルドは不要**（`decodeVideoEntry` は `src/runtime` だが、bundle player は video を `urlForPath` 直参照＝`registerProjectUrls` 経由で decode を通らない。ただし `src/runtime` を触った事実は残るので、念のため `npm run build:player` を実行して `playerBuildFreshness` を通しておくと安全）。

### 完了条件
- Phase 0 ハーネスで video を含む起動時の Long task 最大 duration が baseline より減少。
- `<video>` が preview で正しく再生される（blob URL スコープ罠の回避確認 = **実機で必ず目視**）。
- `npm test` / video verify 群が緑。

---

## Phase 3: `IndexedDbFs.readBatch` + 優先度ソート + フレーム譲渡

### 目的
`loadFromProject` の直列 `await fs.read` ループ（元課題 §2）を、(a) 優先アセット先行、(b) 単一トランザクションのバッチ取得、(c) バッチ間のフレーム譲渡でUIをブロックしないよう改善する。

### 3a: `IndexedDbFs.readBatch`
[IndexedDbFs.ts](../../src/fs/IndexedDbFs.ts) に追加。**1 トランザクションで複数 get を発行**（トランザクション生成の蓄積を排除）:
```typescript
/** 複数パスを単一 readonly トランザクションで一括取得（見つからないキーは Map に含めない）。 */
async readBatch(paths: string[]): Promise<Map<string, Uint8Array>> {
  const store = await this.tx("readonly");
  const out = new Map<string, Uint8Array>();
  // 同一 microtask 内で全 get を発行 → 1 トランザクションにまとまる（間に await を挟まない）。
  const jobs = paths.map((p) => {
    const key = normalizePath(p);
    return promisifyRequest<unknown>(store.get(key)).then((r) => {
      if (r !== undefined) out.set(key, r as Uint8Array);
    });
  });
  await Promise.all(jobs);
  return out;
}
```
> **INV-4 注意**: `readBatch` は `FileSystem` インターフェースに足すと NodeFs / MemoryFs にも実装が要る。**まずは `IndexedDbFs` 固有メソッド**として追加し、呼び出し側で `fs instanceof IndexedDbFs` 分岐（または optional method）にして、他 FS は既存の逐次 `read` にフォールバックする。インターフェース拡張は Phase 5（NodeFs）着手時にまとめて検討する。

> **トランザクションと譲渡の両立に関する落とし穴**: IDB の readonly トランザクションは「保留リクエストが無い状態で event loop に戻ると自動 commit」する。つまり **1 つの tx を `setTimeout` を跨いで開いたままにはできない**。よって「単一 tx バッチ」と「フレーム譲渡」は排他。設計は **バッチごとに独立 tx を張り、バッチとバッチの間で譲る**（下記 3c）。`readBatch(N件)` を 1 tx、その後 yield、次の `readBatch` を新 tx、の形にする。

### 3b: 優先アセットのソート
`loadFromProject`（[L132](../../src/runtime/imageAssetCache.ts#L132)）で、ロード対象 asset を **初期表示コンポジションから参照されている asset を先頭**に並べ替える:
1. ヘルパ `collectReferencedAssetIds(project, rootCompId): Set<string>` を追加（`src/runtime` 内）。
   - `project.rootComposition`（無ければ最初の comp）から開始し、comp の objects を走査。
   - 各 object の components から asset 参照（image/video の `assetId`、`compRef`/precomp のネスト）を集める。ネスト comp は再帰（循環ガード付き）。
   - 参照経路は既存の `collectVideoClipsFromComp`（PreviewPanel）や resolve 側の asset 参照抽出を流用できるか確認し、無ければ最小実装。
2. `loadFromProject` に optional 引数 `priorityAssetIds?: Set<string>` を足し、`project.assets` を「優先集合 → その他」の安定ソートで処理順を決める（元配列は不変）。
3. 呼び出し元 [PreviewPanel.tsx:473](../../src/editor/panels/PreviewPanel.tsx#L473) で現在の `comp` から優先集合を作って渡す。

> **INV 非影響**: これは **ロード順序だけ**の変更。`byId`/`byPath` の最終内容は同じ。project.json 直列化（serialize.ts の id 昇順）とは無関係（あちらは永続化順、こちらは実行時ロード順）。

### 3c: バッチ + フレーム譲渡
`loadFromProject` のループを「優先ソート済み配列を N件（例 3件）ずつ」処理し、バッチ境界で `await yieldToFrame()` を挟む:
```typescript
// メインスレッドに Layout/Paint の隙間を与える（起動フリーズ防止）。
function yieldToFrame(): Promise<void> {
  return new Promise((r) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => r())
      : setTimeout(r, 0),
  );
}
```
- 各バッチ内は `readBatch`（IndexedDbFs のとき）で 1 tx 取得 → decode（Phase 2 の Worker と併用で decode もメイン外）→ `byId`/`byPath` へ登録。
- バッチ後 `await yieldToFrame()`。
- **優先バッチ（初期表示 comp が参照する asset）を最初に処理**し、その完了直後に 1 度 `setRenderTick` を発火できるよう、`loadFromProject` に「優先分ロード完了コールバック」or 2 段階 Promise を用意すると LCP がさらに改善する（任意・余力があれば）。

### 3d: `list` の cursor 化（任意）
[IndexedDbFs.list](../../src/fs/IndexedDbFs.ts#L69) の `getAllKeys()` 一括を、大量アセット時に `openKeyCursor` + バッチ譲渡へ改善（元課題 §2 末尾）。**アセット数が少ない現状では優先度低**。効果測定（Phase 0）で `list` が支配的でなければスキップしてよい。

### 回帰ガード
- `npm test`（IndexedDbFs / imageAssetCache のテスト）。`readBatch` の単体テスト（存在キー/欠損キー混在、空配列、既存 `read` と同一バイト）を追加。
- INV-2: 優先ソート・バッチ化の後もロード後の `byId` 内容が従来と一致することをテストで固定（順序非依存）。
- MemoryFs 経路（テスト・export）が `readBatch` 未実装でも逐次フォールバックで動くこと。

### 完了条件
- Phase 0 ハーネスで、起動時の Long task がバッチ境界で分割され最大 duration が減少、初期 comp 参照アセットのロード完了が前倒しされる。
- `npm test` 緑。

---

## Phase 4: `deserializeProject` の Uint8Array 直接デコード

### 目的
`readText`（`bytesToText` = TextDecoder）→ `deserializeProject`（`JSON.parse`）の二段で発生する中間文字列割り当てを削減（元課題 §4）。

### 対象ファイル
- [serialize.ts](../../src/core/serialize.ts#L212)
- [projectFs.ts](../../src/core/projectFs.ts#L23)

### 実装ステップ
1. `deserializeProject` を `Uint8Array | string` 受理に拡張:
   ```typescript
   const _decoder = new TextDecoder(); // モジュールスコープで再利用
   export function deserializeProject(input: Uint8Array | string): Project {
     const text = typeof input === "string" ? input : _decoder.decode(input);
     return JSON.parse(text) as Project;
   }
   ```
   > `bytesToText`（[FileSystem.ts:28](../../src/fs/FileSystem.ts#L28)）と同じ TextDecoder を使う。中間の関数呼び出し 1 段と `readText` 経由の string 変数を省く。**JSON.parse は string を要求する**ため「文字列を作らない」ことは不可能（`JSON.parse(Uint8Array)` は不可）。削減できるのは `bytesToText` の関数境界と `readText` 経由の余剰参照のみ ＝ **効果は限定的**。過度な期待をしない。
2. [projectFs.ts loadProject](../../src/core/projectFs.ts#L23) を `readText` → `read` + `deserializeProject(bytes)` に変更:
   ```typescript
   const bytes = await fs.read(PROJECT_JSON);
   const raw = deserializeProject(bytes);
   ```

### 回帰ガード
- `deserializeProject(string)` の既存呼び出しは全て後方互換（union 追加のみ）。全呼び出し元を grep して型不整合が無いこと。
- `npm test`（serialize round-trip・INV-4 byte 等価テスト）。**直列化 `serializeProject` は一切触らない**（project.json 形式不変）。

### 完了条件
- round-trip テスト緑、`loadProject` が Uint8Array 経路で正しくパース。
- Phase 0 ハーネスで deserialize 区間が baseline 以下（悪化していないこと。効果が小さくても回帰させない）。

---

## Phase 5: Electron 実FS（NodeFs）切り替え（別マイルストーン・要設計確認）

### 位置づけ
効果は最大（IndexedDB のトランザクション/シリアライズを丸ごと排除、OS ネイティブ I/O）だが、**スコープが大きく FS バックエンドの追加**を伴う。**着手前にユーザーへ設計確認**（CLAUDE.md 運用体制。§5/INV に直接は触れないが、永続化バックエンドの追加は影響が広い）。Phase 1〜4 とは独立に、後日単独で進める。

### 設計要点（確認事項として提示するもの）
1. **INV-4 の厳守**: NodeFs は IndexedDbFs と同一パスセマンティクス（POSIX "/"、先頭 "/" 無し、`normalizePath` 共通）。既存 [NodeCacheFs.ts](../../src/fs/NodeCacheFs.ts) を参考に、ただし preview/persist 用の完全な `FileSystem` 実装が必要。
2. **配線**: Electron preload で `window.electron.fs`（read/write/list/exists/delete/mkdir の IPC ブリッジ）を公開 → `NodeFs implements FileSystem` が IPC を叩く。`store.getFs()`（[store.ts:1218](../../src/editor/store.ts#L1218)）で **Electron 検出時に NodeFs、それ以外は IndexedDbFs** を返す自動判別 or トグル。
3. **保存ルート**: プロジェクトフォルダを OS 上の実ディレクトリに置く（`project.json` / `assets/*` / `scripts/*` をそのまま）。zip export（INV-4）は NodeFs 経路でも同一フォルダ構成を生成すること。
4. **`readBatch`**: NodeFs では `Promise.all(paths.map(read))` で自然に並列 I/O。この時点で `FileSystem` インターフェースに optional `readBatch?` を正式追加するか検討。

### なぜ別扱いか
- IndexedDbFs 前提の箇所（`new IndexedDbFs(...)` 直呼び、PreviewCacheDb / WaveformCacheDb 等の派生 DB）を洗い出して NodeFs と両立させる必要がある。
- 既存の全 export/bundle/verify を Electron・web 両モードで回す回帰コストが大きい。

### 完了条件（着手時に別途詳細化）
- Electron 版で project 保存/読込/zip が web 版と byte 等価（INV-4 テスト）。
- preview / export が INV-2 一致。

---

## 実装順の推奨と注意まとめ

1. **Phase 0 → 1 → 2a → 2b → 3 → 4** の順で 1 フェーズ 1 コミット（or 小PR）。各コミット後に Phase 0 ハーネスで数値を追記。
2. **Phase 1（HTTP/2）は verify ハーネスの https 対応を伴う**ので、Phase 0 のハーネス実装時に `ignoreHTTPSErrors` を織り込むこと。
3. **INV-2 の絶対死守**: Phase 2〜3 は「バイナリの作り方・順序・スレッド」だけを変え、`url` の中身・`size`・scene 解決値を変えない。各フェーズ完了時に既存 `verify-*.mjs`（video/split-alpha/packed）を無回帰確認。
4. **bundle player**: 本PLANで `src/runtime/imageAssetCache.ts` を触るが、bundle の video は `registerProjectUrls`（decode 非経由）なので機能差は出ない。ただし `src/runtime` 変更につき、完了前に `npm run build:player` を実行し `playerBuildFreshness` を通す（CLAUDE.md「bundle player の再ビルド」節・多層防御）。
5. **spec 更新**: Phase 1〜4 は §5/INV/直列化形式に触れないため散文追記のみで足りる。`readBatch` 追加・`decodeVideoEntry` 非同期化を [doc/mafter-effect-spec.md](../mafter-effect-spec.md) §11.1 に 1〜2 行追記し、SSoT と実装を一致させる。Phase 5 は着手前に spec 先行 + ユーザー確認。
6. **progress.md**: 各フェーズ完了時に進捗を記録（CLAUDE.md 進捗管理ルール）。

## 触ってよい / 触ってはいけない

| 触ってよい（実装扱い） | 触る前に確認（要ユーザー承認） |
|---|---|
| Worker 追加、`decodeVideoEntry` 非同期化、呼び出し側 await | §5 データスキーマ（TS 型）の変更 |
| `IndexedDbFs.readBatch`・ロード順序・yield | INV-1〜INV-6 の追加/変更/緩和 |
| `deserializeProject` の入力型拡張（形式不変） | `project.json` の直列化形式変更（serialize.ts の出力） |
| vite dev の https 化 | Phase 5（NodeFs 追加＝FS バックエンド増設） |
