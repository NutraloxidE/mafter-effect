# フィードバック収穫ループ — 運用正本

デプロイ先エディタの「不便シグナル」を収集し、開発機で収穫・要約・提案するまでの一連の運用手順。
spec（[`doc/mafter-effect-spec.md`](mafter-effect-spec.md)）とは分離された運用ドキュメント。
JSON スキーマは [`doc/feedback-payload.md`](feedback-payload.md) を参照。

> このループのスキルは **特定の Agent 専用ではない**。Cursor / Claude Code / 他の coding Agent
> のいずれでも、[`.claude/skills/`](../.claude/skills/) 配下の SKILL.md を読めば同じ手順で動く。
> 推奨プロンプト（Agent 名を含めない）:
>
> > スキルに基づきフィードバック集めて実装提案して

---

## アーキテクチャ（v1）

```
[Deployed SPA] --POST /api/feedback--> [mafter_http_server.py :80 on gycp-vm] --append--> ~/mafter-feedback/inbox/*.jsonl
                                                                                                 |
                                                                                    (SSH pull) harvest-feedback.mjs
                                                                                                 v
                                                                                        feedback/inbox/*.jsonl
                                                                                                 |
                                                                              summarize-feedback.mjs (集計)
                                                                                                 v
                                                                              summarize-user-feedback SKILL
                                                                                                 v
                                                                              feedback/reports/summary-*.md
                                                                                                 |
                                                                              propose-from-user-feedback SKILL
                                                                                                 v
                                                                              feedback/reports/proposals-*.md
                                                                                                 |
                                                                          （ユーザーが FB-ID 承認）
                                                                                                 v
                                                                              implementation-loop へ
```

**v1 確定**: リモート配信は python 統合サーバ一本（`scripts/mafter_http_server.py`）。
Docker/Caddy デュアルパスは v2。実測（`scripts/probe-deploy-remote.mjs`）で Docker デーモンが
常時未起動だったため、v1 では単一プロセスに統一した。

---

## トークン（G27・重要）

`FEEDBACK_INGEST_TOKEN`（`.env`）はビルド時に同一値が `VITE_FEEDBACK_TOKEN` としてクライアント
バンドルへ焼き込まれる（`vite.config.ts` の `define` ではなく、Vite の `.env` 変数展開経由。
`.env.example` の `VITE_FEEDBACK_TOKEN=${FEEDBACK_INGEST_TOKEN}` を参照）。

**これは意図的な設計であり漏洩許容**。DevTools で見えても問題ない。ユーザー認証や秘密鍵ではなく、
ベータ向けの共有ゲート（雑なスパム軽減）にすぎない。実質の悪用対策は次の2点:

- サーバ側 rate limit（10 req/min/IP、payload 8KB 上限。[`doc/feedback-payload.md`](feedback-payload.md)）
- 悪用されたら `.env` の `FEEDBACK_INGEST_TOKEN` をローテして再 `deploy:ssh`（自動で再 build される）

`FEEDBACK_INGEST_TOKEN` が未設定のビルドでは:
- クライアント: フィードバック UI（催促トースト・ProjectPanel の「フィードバックを送る」ボタン）は表示されない
- サーバ: `/api/feedback` へのアクセスは常に 404（static 専用サーバとして振る舞う。非破壊条件1）

---

## デプロイ手順

1. `.env` に `FEEDBACK_INGEST_TOKEN=<ベータ用共有トークン>` と `DEPLOY_BUILD=true` を設定
2. `npm run deploy:ssh` を実行
   - `DEPLOY_BUILD=true` により `npm run build`（= `VITE_FEEDBACK_TOKEN` 込みの dist）が毎回実行される
   - デプロイ時に `scripts/mafter_http_server.py` がリモート `~/.mafter-deploy/` へ SFTP 転送される
   - リモートで旧 `python3 -m http.server` / 前回起動の本サーバを `pkill` してから新プロセスを起動（起動の冪等化）
   - `FEEDBACK_INGEST_TOKEN` 未設定なら `--feedback-dir` / `--token` を渡さず static 専用起動になる

## Smoke テスト（G26）

デプロイ後、当該デプロイの公開 URL（`https://{instance-uuid}-w1.gycp.party` — インスタンスごとに変わる。
`ssh.gycp.party` は SSH 専用で Web 用ではない）に対して:

```bash
curl -X POST https://<デプロイ先のURL>/api/feedback \
  -H "Authorization: Bearer $FEEDBACK_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schemaVersion":1,"id":"smoke-01","sessionId":"smoke","signals":[],"appVersion":"0.0.0","userAgent":"smoke","host":"smoke"}'
```

`{"ok": true}` が返り、リモート `~/mafter-feedback/inbox/YYYY-MM-DD.jsonl` に1行追記されていれば成功。

## ローカル検証（G3）

`npm run dev` は既定でフィードバック機能オフ（`.env` に `FEEDBACK_INGEST_TOKEN`/`VITE_FEEDBACK_TOKEN`
が無ければ UI 非表示）。動作検証したい場合のみ:

```bash
python scripts/mafter_http_server.py --port 5174 --static dist --feedback-dir feedback/inbox-dev --token dev-token
```

`vite.config.ts` に `/api/feedback` → `http://127.0.0.1:5174` のプロキシを設定済み（未起動でも他の
リクエストには影響しない）。

---

## 収穫（開発機・手動）

```bash
npm run harvest:feedback
```

`scripts/harvest-feedback.mjs` が SSH 経由でリモート `~/mafter-feedback/inbox/*.jsonl` を
[`feedback/inbox/`](../feedback/inbox/) に取得し、取得済みファイルはリモートの `archive/` へ
コピー→検証→削除で移動する（部分失敗時も再試行可能。G13）。

---

## 要約・提案（任意の Agent + スキル）

`npm run harvest:feedback` の後、または `feedback/inbox/*.jsonl` が増えたときに、任意の coding Agent
へ次のように依頼する:

> スキルに基づきフィードバック集めて実装提案して

これで [`run-feedback-loop`](../.claude/skills/run-feedback-loop/SKILL.md) スキルが
[`summarize-user-feedback`](../.claude/skills/summarize-user-feedback/SKILL.md) →
[`propose-from-user-feedback`](../.claude/skills/propose-from-user-feedback/SKILL.md) の順に実行され、
`feedback/reports/summary-*.md` と `feedback/reports/proposals-*.md` が生成される。
**この時点ではコード変更・spec 変更・コミットは一切行われない。**

提案（`FB-YYYYMMDD-NN` 形式の ID）をレビューし、承認したものだけ:

> `FB-20260701-01` を承認。implementation-loop で実装して。

と伝えると、[implementation-loop](../.claude/skills/implementation-loop/SKILL.md) Phase 0 から実装が始まる。
`progress.md` には `（FB-… 由来）` と明記する。

---

## プライバシー・送らないもの

- `project.json` 本体・アセット・スクリーンショットは v1 では一切送信しない
- 送るのは: 発火したシグナルのラベル・任意のテキストコメント・セッションID（`crypto.randomUUID()`、
  タブ単位・個人特定なし）・`appVersion` / `userAgent` / `host`（インスタンス識別用）のみ
- 送信モーダルにこの1行を常時表示する

## Git 管理

`feedback/inbox/` と `feedback/reports/` は両方 `.gitignore` 対象。ただし `reports/` は
レビュー後に有用と判断したものだけ `git add` で個別コミットしてよい（履歴として残したい要約・提案のみ）。

## FB-ID ライフサイクル（G18）

- 提案は `feedback/reports/proposals-*.md` に append-only（過去の提案を書き換えない）
- 実装完了は `progress.md` に `FB-YYYYMMDD-NN` として記録するのみ（proposals ファイル自体は不変のまま残す）
