# AGENTS.md

> AI エージェント向けの基本指針は `CLAUDE.md`（ground truth）と `doc/mafter-effect-spec.md`（SSoT）に従うこと。
> 本ファイルの `## Cursor Cloud specific instructions` は Cloud Agent 環境固有の補足のみを記載する。

## Cursor Cloud specific instructions

Mafter Effect は React + Vite + TypeScript(strict) の単一フロントエンド SPA（ブラウザ完結・バックエンド/DB なし）。永続化は IndexedDB（`IndexedDbFs`）と localStorage（UI レイアウト）に閉じる。

### サービス / コマンド

依存は更新スクリプト（`npm install`）で導入済み。標準コマンドは `package.json` の `scripts` を正とする:

- 開発サーバ: `npm run dev`（Vite, ポート 5173）。`vite.config.ts` で `server.host = true`（LAN 公開）。ポート衝突時は Vite が 5174+ に自動シフトする。
- 型チェック: `npm run typecheck`（`tsc --noEmit`）
- テスト: `npm test`（vitest run, node 環境）
- ビルド: `npm run build`（`tsc --noEmit && vite build`）

### 非自明な注意点

- **UI / レンダリング / ブラウザ挙動に触れる変更は Playwright + Chromium 実機検証が必須**（`.cursor/rules/mafter-effect-agent.mdc` 参照）。typecheck / test が緑でも UI ランタイムは保証されない。
- 状態リセット: `indexedDB.deleteDatabase("mafter-effect-fs")` + reload、viewer 設定は `localStorage.clear()`。
- レイヤー追加はタイムライン下部の `+ Solid` / `+ Text` ボタンから（hello world 動作確認済み）。
- `npm install` で transitive deps の脆弱性警告（moderate/high/critical）が出るが dev/build ツールチェーン由来で実行時影響なし。
- `npm run deploy:ssh` は外部 SSH ホストへの配備用で、Cloud 環境の開発では不要。
