# Mafter Effect — AI Agent Initialization

> **Mafter Effect = After Effects, but with Markup language.**
> Git管理可能 / HTML・CSS・JS をネイティブに扱う / AI フレンドリーな映像制作エンジン。

---

## SSoT 宣言

仕様の唯一の正は **doc/mafter-effect-spec.md** である。
矛盾が生じた場合の優先順位:
1. `§5 データスキーマ`（TypeScript 型）
2. `§4 不変条件 (INVARIANTS)`
3. `§15 マイルストーン受け入れ条件`
4. その他の散文

実装に疑問が生じたら**まず仕様書を参照**すること。散文を根拠にスキーマを変えてはならない。

---

## 進捗管理ルール（必須）

**セッションをまたぐ進捗・未達成タスクは必ず progress.md に記録する。**

- 実装を開始する前に `progress.md` を読み、前セッションの状態を把握する。
- セッション終了時（または大きな変更後）は `progress.md` を更新する。
- 記録すべき内容:
  - 完了したマイルストーン・タスク
  - 未完了・未着手のタスク（何が残っているか）
  - 既知のバグ・課題
  - 次にやるべきこと（Next steps）

---

## プロジェクト構造

```
mafter-effect/
 ├ src/                    # アプリ本体（TypeScript / React）
 ├ doc/
 │   └ mafter-effect-spec.md  # ★ 仕様書（SSoT）
 ├ CLAUDE.md               # AI 用 ground truth
 ├ progress.md             # ★ セッション間進捗記録
 └ project.json            # ユーザープロジェクト本体（タイムライン等）
```

ランタイム: **React + Vite + TypeScript(strict)**。`npm run dev` でブラウザ起動。

---

## 不変条件（INVARIANTS） — 絶対に破らないこと

| ID | 条件 |
|----|------|
| **INV-1** | `resolve(comp, frame)` は純関数。`Math.random` / `Date.now` / DOM / network 禁止。乱数は seeded helper のみ。 |
| **INV-2** | 同一 frame の preview・browser export・headless export は scene 解決値が一致する。 |
| **INV-3** | `SceneObject` / `Composition` / Timeline / Keyframe はレンダラに依存しない。Renderer は `ResolvedScene` のみ受け取る。 |
| **INV-4** | `IndexedDbFs` と `NodeFs` は同一パス構成を生成。zip 書き出しもフォルダ構成と一致。 |
| **INV-5** | 時間の正準単位は整数 `Frame`。秒は `frame / fps` で導出する派生値。 |
| **INV-6** | オブジェクト・コンポ・アセットの参照はすべて stable ID（ULID）。`name` は参照に使わない。 |

---

## コアアーキテクチャ

### データモデル

```
SceneObject
 ├ Transform (anchor / position / rotation / scale) — すべて AnimatedProp<Vec3>
 ├ opacity   — AnimatedProp<number> (0..1)
 ├ components[] — Component[] (built-in or plugin)
 └ parent    — ObjectId | null (transform 継承のみ)
```

- **objects は flat list**。ツリーは `parent` 参照から導出（`children[]` は持たない）。
- `zOrder`（fractional）が描画順。`parent`（transform 継承）と直交する。
- `project.json` 直列化時は `objects` を **id 昇順でソート**。

### レンダリングパイプライン

```
resolve(comp, frame) → ResolvedScene → DomRenderer.renderFrame()
```

- `resolve()` は純関数。parent チェーンを畳んで `worldTransform: Mat4` を各オブジェクトに焼き込む。
- `DomRenderer` はフラット構造（ネストしない）。各オブジェクトを兄弟 div として `matrix3d(worldTransform)` + `opacity` + `z-index` で並べる。

### Transform 合成順（確定）

```
L = T(position) · R(rotation) · S(scale) · T(-anchor)
W_child = W_parent · L_child
```

- Euler 適用順: **Z·Y·X**（degrees）
- 原点: 左上、+x 右 / +y 下 / +z 手前

---

## MVPマイルストーン

| マイルストーン | 内容 | 受け入れ条件の概要 |
|---|---|---|
| **M0** Foundations | project.json schema + IndexedDbFs + zip export/import | 作成→保存→再読込→zip→reimport が byte 等価 |
| **M1** Core animation | Object/Transform/Keyframe/Easing + resolve() + DomRenderer + Undo/Redo | solid/text/image を bezier easing でアニメート、Cmd-Z/Shift-Cmd-Z が動く |
| **M2** HTML comp + expression | HTML Composition (Model A) + 純関数エクスプレッションエンジン | params keyframe アニメート、wiggle 再現可能 |
| **M3** Export | 決定論 frame ステップ + WebCodecs/PNG連番 + 音声 mux | 5 秒尺を webm/mp4/連番に書き出せる |
| **M4** Plugin API v1 | フル登録 API + plugins/ ロード + サンプル plugin | 第三者 plugin が component を登録しタイムラインで使用可 |

> **MVP = M0–M4**。M1–M3 でコア型を凍結してから M4 に入ることを推奨。

---

## 主要な設計決定（確定済み）

- **HTML comp 隔離**: Shadow DOM（headless export を 1 screenshot で済ませるため）
- **FS→module loader**: `fs.readText(path)` → `Blob` → `URL.createObjectURL` → dynamic `import()`
- **expression 例外**: フォールバックは `ctx.value`（レンダリングは止めない）
- **Undo/Redo**: command + 逆 patch（JSON patch 推奨）、スタックはセッション内のみ
- **状態管理**: Zustand 推奨（プロジェクトデータの正は FS、ストアはその投影）
- **video/audio**: MVP 含む（best-effort）。`compRef`（precomp）は将来

---

## 実装ガイドライン

- TypeScript strict モードを維持する。`any` は使わない。
- コメントは「なぜ」が非自明な場合のみ書く。「何をしているか」はコードから読める。
- 新機能追加前に仕様書の該当セクションを確認する。
- テストは INV-1〜INV-6 の検証を優先する。
- `project.json` の読み書きは必ず正準シリアライズ（キー順固定・id ソート・末尾改行）を通す。

---

## 参照

- 仕様書全文: doc/mafter-effect-spec.md
- 進捗記録: progress.md
- prior art: Remotion（React→動画 via headless Chromium）を必ず一読すること
