# フィードバック JSON スキーマ（G2）

運用データのスキーマ。**§5（データスキーマ）とは無関係** — `project.json` を汚染しない、
デプロイ先エディタから ingest サーバへ送る一方向の運用ペイロード。

## `FeedbackPayload`

```typescript
interface FeedbackPayload {
  schemaVersion: 1;
  id: string;           // ULID（クライアント生成）
  ts: string;            // ISO8601（クライアント生成時刻）
  sessionId: string;     // crypto.randomUUID()。個人特定なし、タブ単位（sessionStorage）
  signals: string[];     // 発火したシグナルのラベルのみ（例: ["export_error", "undo_burst"]）。手動送信時は空配列可
  message?: string;      // ユーザー任意入力。max 4000 文字（クライアント側で切り詰め、サーバでも再検証）
  appVersion: string;    // package.json version（ビルド時に注入）
  userAgent: string;     // navigator.userAgent
  host: string;          // location.hostname（gycp インスタンス識別用。§Phase1「公開URL」参照）
}
```

## 送らないもの

- `project.json` 本体・アセット・スクリーンショット（v1 既定 OFF）
- ユーザーの個人情報（メール等の入力欄は設けない）

## サーバ側検証（`mafter_http_server.py`）

- `schemaVersion` は `1` のみ受理（それ以外は 400）
- `signals` は文字列配列、各要素 64 文字以内・最大 20 件
- `message` は 4000 文字を超えたらサーバ側でも切り詰め（拒否はしない）
- payload 全体 8KB 超は 413（[`doc/feedback-loop.md`](feedback-loop.md) の rate limit 参照）
- 未知フィールドは無視（将来の `schemaVersion` 追加に備え寛容に読む）

## 保存形式

`~/mafter-feedback/inbox/YYYY-MM-DD.jsonl` に1行1 JSON で追記（append-only）。
`YYYY-MM-DD` はサーバのローカル日付（UTC）。
