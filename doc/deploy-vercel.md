# Vercel デプロイ

Mafter Effect を **Vercel の静的ホスティング**に載せるための手順と設計メモ。
既存の SSH デプロイ（`npm run deploy:ssh` / [feedback-loop.md](feedback-loop.md)）と
Electron 配布（`npm run electron:dist`）は**一切変更していない**。Vercel は追加の配信先。

## なぜそのまま載るか

エディタ本体は完全にクライアント側で完結する。

- プロジェクトの正本は **IndexedDB**（`IndexedDbFs`）。サーバ側ストレージを持たない。
- 書き出し（mp4 / webm / PNG 連番 / HTML bundle）はブラウザ内（WebCodecs / muxer）で行う。
- ルーティングを持たない単一ページ（`location.pathname` を読む箇所は無い）。

したがって必要なのは「`dist/` を正しく配る」ことだけで、サーバランタイムは不要。

## 設定ファイル

### `vercel.json`

| 項目 | 値 | 理由 |
|------|-----|------|
| `framework` | `vite` | Vercel のフレームワーク検出を固定 |
| `installCommand` | `npm ci` | `package-lock.json` 固定でビルド再現性を確保 |
| `buildCommand` | `npm run build` | `tsc --noEmit` → `build:player` → `vite build`。**player.js の再ビルドを含む**ので CLAUDE.md の「bundle player 再ビルド」条件をデプロイ側でも自動的に満たす |
| `outputDirectory` | `dist` | Vite の既定出力 |
| `rewrites` | `/((?!api/)[^.]*)` → `/index.html` | SPA フォールバック |
| `headers` | `/assets/(.*)` に `immutable` | Vite が content-hash を付ける生成物のみ長期キャッシュ |

**rewrite の書き方に意図がある。**

- `[^.]*` — 拡張子付きパスは対象外。存在しないアセット（`/fonts/typo.ttf` など）が
  200 + HTML で返ると「フォント読み込み失敗」ではなく「壊れたフォントデータ」として
  現れてデバッグ不能になる。404 のまま返す。
- `(?!api/)` — `/api/*` を除外。除外しないと `POST /api/feedback` が index.html で
  **200 を返し**、`feedbackCollector` が送信成功と誤認してフィードバックが消える。
- `/fonts/**`・`/motion-track/**`・`/subject-extract/**`（opencv.js / mediapipe wasm）は
  content-hash が無いため長期キャッシュを付けない。Vercel 既定の再検証に任せる。

### `.vercelignore`

`doc/`・`for-debug-data/`・`audio/`・ルート直下の `verify-*` / `probe-*` / `bench-*` /
`*.png` / `*.zip` などビルドに不要な大容量資材を除外する（合計 700MB 超）。

**除外してはいけないもの**: `index.html` / `src/` / `public/` / `package.json` /
`package-lock.json` / `tsconfig.json` / `vite*.config.ts` /
**`test/`（`tsconfig.json` の `include` に入っており `tsc --noEmit` が読む）**。

### `api/feedback.js`（既定オフ）

SSH デプロイではリモートの python サーバ（`scripts/mafter_http_server.py`）が
静的配信と ingest を兼ねるが、Vercel には同じ受け口が無い。既存 ingest オリジンへ
中継するだけの薄い Serverless Function を置いてある。

- `MAFTER_FEEDBACK_ORIGIN` **未設定なら 501 を返すだけ**（既定は無効）。
- クライアントは `res.ok` でない応答を localStorage キューに退避して次回リトライするため、
  無効のままでも UI は壊れない。

## デプロイ手順

1. Vercel で GitHub リポジトリを import する（`vercel.json` があるためビルド設定の入力は不要）。
2. 必要に応じて環境変数を設定する。

| 変数 | 要否 | 用途 |
|------|------|------|
| `VITE_FEEDBACK_TOKEN` | 任意 | 設定するとアプリのフィードバック送信が有効になる（ビルドに焼き込まれる。`.env.example` 参照） |
| `MAFTER_FEEDBACK_ORIGIN` | 任意 | `api/feedback.js` の転送先（例 `https://maftereffect.gycp.party`）。未設定なら中継は無効 |
| `FEEDBACK_INGEST_TOKEN` | 任意 | 設定すると中継時にクライアントの `Authorization` をサーバ側の値で上書きする |

いずれも未設定でエディタは完全に動作する（フィードバック送信のみ無効）。

## 検証

```
npm run build
node verify-vercel-static.mjs
```

`verify-vercel-static.mjs` は Vercel のルーティング順（filesystem 優先 → 該当なしなら
`vercel.json` の `rewrites`）をローカルの静的サーバで再現し、実ブラウザで次を確認する。

- エディタが起動する（React マウント + Timeline 描画）
- `publicAssetUrl("fonts")` が解決でき、内蔵フォントが実ロードできる
- 拡張子付きの不在アセットは 404 のまま（app shell を返さない）
- 拡張子なしパスのみ index.html にフォールバックする
- `/api/*` は rewrite されない
- 起動時に想定外の 404 と page error が無い

## 制約・既知の差分

- **書き出しはブラウザ性能に依存する**（Vercel 側で処理しない）。長尺の書き出しは
  ローカル / Electron 版のほうが速い場合がある。これは配信先を問わない既存の性質。
- 静的アセットが約 48MB（フォント 20MB / mediapipe wasm 19MB / opencv.js 8.7MB）。
  初回アクセス時の転送量が大きい。ただし全て遅延ロード（フォントは @font-face、
  wasm はモーショントラック・被写体抽出を使ったときだけ）なので初期表示には影響しない。
- SSH デプロイのように `/api/feedback` を同一オリジンで受け止めることはできない
  （上記 Serverless Function による中継のみ）。
