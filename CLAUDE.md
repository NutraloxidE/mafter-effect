# Mafter Effect — AI Agent Initialization

> **Mafter Effect = After Effects, but with Markup language.**
> Git管理可能 / HTML・CSS・JS をネイティブに扱う / AI フレンドリーな映像制作エンジン。

---

## SSoT 宣言

仕様の唯一の正は **[doc/mafter-effect-spec.md](doc/mafter-effect-spec.md)** である。
矛盾が生じた場合の優先順位:
1. `§5 データスキーマ`（TypeScript 型）
2. `§4 不変条件 (INVARIANTS)`
3. `§15 マイルストーン受け入れ条件`
4. その他の散文

実装に疑問が生じたら**まず仕様書を参照**すること。散文を根拠にスキーマを変えてはならない。

---

## 運用体制（重要・2026-06 更新）

> **Claude Code (Opus) は利用制限により停止中。** 当面は **Cursor (Composer 2.5) が設計・spec 編集・実装をすべて単独で担当**する。
> 旧来の「設計=Claude Code / 実装=Cursor」分業は無効。Cursor が `doc/mafter-effect-spec.md` を編集してよい。

ただし以下は **勝手に進めず、編集・実装の前に必ずユーザーへ確認する**（選択肢＋推奨案を提示）:

- **INVARIANT（INV-1〜INV-6 等）の追加・変更・緩和**
- **§5 データスキーマ（TypeScript 型）の追加・変更**
- **`project.json` の直列化形式の変更**

上記以外（散文の追記・整理、§5/INV に触れない spec 更新、実装・リファクタ・テスト）は Cursor 主導でよい。
いずれの場合も「先に spec → 次に実装」の順を厳守し、SSoT を壊さない。

---

## 進捗管理ルール（必須）

**セッションをまたぐ進捗・未達成タスクは必ず [progress.md](progress.md) に記録する。**

- 実装を開始する前に `progress.md` を読み、前セッションの状態を把握する。
- セッション終了時（または大きな変更後）は `progress.md` を更新する。
- 記録すべき内容:
  - 完了したマイルストーン・タスク
  - 未完了・未着手のタスク（何が残っているか）
  - 既知のバグ・課題
  - 次にやるべきこと（Next steps）

---

## 機能追加ワークフロー（必須）

新機能・バグ修正・レンダリング変更の着手〜完了は、正本 **[.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md)** に従う（ここに手順を重複記載しない）。

> 「先に仕様、次に実装」を徹底する。spec を更新せずにコードだけ変えると SSoT が壊れる。

---

## プロジェクト構造

```
mafter-effect/
 ├ src/                    # アプリ本体（TypeScript / React）
 ├ doc/
 │   └ mafter-effect-spec.md  # ★ 仕様書（SSoT）
 ├ CLAUDE.md               # このファイル（AI 用 ground truth）
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

### 実装ループ（隔離・正本はスキル）

新機能・バグ修正・レンダリング/UI 変更に着手するたび、最初に **[.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md)** を読んで実行する。手順・チェックリスト・分岐・一貫性ゲートはすべてスキル側に集約し、**本ファイルには重複しない**。

### Store 投影と FS 正本の整合（zip / export 配線で必須）

Zustand ストアは **IndexedDbFs の投影**（§17）。UI はストア、zip・bundle 書き出しは **FS を直接読む**。新機能で「保存」「ダウンロード」「書き出し」を足すときは次を守る:

1. **FS を読む前に必ず `await saveToFs()` / `saveProject` でストア→FS をフラッシュする**（`applyCommand` 内の `void saveProject` は非同期・失敗も握りつぶすため、export 経路では不十分）。
2. **`newProject` などメモリだけ切り替える操作**は FS も同期する（旧 `project.json`・`assets/*` が残ると zip が UI と無関係な内容になる）。新規プロジェクト時は FS を掃除してから正準 `project.json` を書く。
3. **エディタから FS に触るときは `store.getFs()` を使う**。パネルごとに `new IndexedDbFs("mafter-effect-fs")` を重複生成しない（同一 DB 名でも別インスタンス＋フラッシュ漏れで「保存したのに古い zip」が起きる）。
4. **serialize 失敗は export でユーザーに見せる**（黙って古い FS を zip すると「ボタンが壊れた」ように見える）。

### 新描画レイヤーオブジェクトの export 正常化（他経路無回帰・必須）

新型の描画コンポーネント（`video` / `image` / 将来の shape 等）や、既存型の **export 専用キャプチャ経路**（`foreignObject` インライン化・seek・フレーム待ち等）を直すときは、**その型の export を直すことだけを完了条件にしない**。共有パイプラインを変えると、触っていない型・触っていない書き出し形式だけが静かに壊れる（camera bundle-bake 誤判定と同型の「片経路だけ」回帰）。

**守ること:**

1. **共有コードの変更は最小・型別オプトイン** — `rasterCapture.ts` / `DomRenderer` / `videoElementSync.ts` / `exporter.ts` / `compFrameCapture.ts` 等を触るとき、全レイヤー・全フレームに一律適用する挙動変更を避ける。新型専用は `c.type` 分岐・`exportVideoStep` / `inlineVideoFrames` のような**経路・型フラグ**で閉じる。
2. **書き出し経路を横断して列挙** — 修正の影響を受けうる経路を Phase 2 で必ず書き出す: browser export（mp4 / webm / PNG 連番）/ `compFrameCapture`（ネスト precomp・調整レイヤー raster）/ Web bundle player（§11.7）/ preview（INV-2）。新型用 verify だけ緑にして終わらない。
3. **既存 export の回帰ゲート** — 変更後は少なくとも次を無回帰確認する（該当するもの）: 既存 `verify-*-export*.mjs`・blend / 調整 / fast 系 displacement・solid+text+image のみコンプ・bundle bake 件数・`npm test` の export / raster / bundle 関連。新型の verify 追加は歓迎だが、**既存シナリオの PASS を置き換えない**。
4. **preview 専用と export 専用の分離** — preview 再生最適化（例: `video.play()`）と export 決定論（seek + `requestVideoFrameCallback`）は共有ヘルパでも**モード分岐**を維持。一方を直して他方のフレーム精度・速度を壊さない。

詳細チェックリストは [.claude/skills/add-layer-component-type/SKILL.md](.claude/skills/add-layer-component-type/SKILL.md) の export 節と [.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md) Phase 4c を参照。

---

## 参照

- 仕様書全文: [doc/mafter-effect-spec.md](doc/mafter-effect-spec.md)
- 進捗記録: [progress.md](progress.md)
- prior art: Remotion（React→動画 via headless Chromium）を必ず一読すること
