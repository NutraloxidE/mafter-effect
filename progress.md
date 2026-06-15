# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | 未着手 |
| M2 HTML comp + expression | 未着手 |
| M3 Export | 未着手 |
| M4 Plugin API v1 | 未着手 |

---

## 完了済みタスク

### M0 Foundations（2026-06-15 完了）

- **スキャフォールド**: Vite + React 18 + TypeScript(strict, `noUncheckedIndexedAccess` 等) セットアップ。`npm run dev` でブラウザ起動可。
- **§5 データスキーマ型** — [src/core/schema.ts](src/core/schema.ts)。`Project` / `Composition` / `SceneObject` / `Transform` / `AnimatedProp` / `Easing` 等を仕様どおり定義。
- **正準シリアライズ** — [src/core/serialize.ts](src/core/serialize.ts)。キー再帰アルファベット順 + `objects`/`assets`/`compositions`/`pluginRefs` を id 昇順 + 2-space indent + 末尾改行。`canonicalizeProject` / `canonicalStringify` / `serializeProject` / `deserializeProject`。
- **FileSystem 抽象（§11.1）** — [src/fs/FileSystem.ts](src/fs/FileSystem.ts) + [MemoryFs](src/fs/MemoryFs.ts)（テスト用）+ [IndexedDbFs](src/fs/IndexedDbFs.ts)（ブラウザ, raw IndexedDB, prefix-query list）。フラット key-value、ディレクトリはファイル存在で暗黙表現。
- **zip export/import** — [src/fs/zip.ts](src/fs/zip.ts)。JSZip、固定日時で決定論バイト列、path 昇順。
- **プロジェクト作成/読込** — [createProject](src/core/createProject.ts) / [projectFs](src/core/projectFs.ts)（save/load）。
- **load 時検証 + マイグレーション（§5.4-note / §5.6）** — [src/core/validate.ts](src/core/validate.ts)。不正 parent → root化+warn、循環 → ProjectError、新しい schemaVersion → 読込拒否。
- **最小 UI** — [src/App.tsx](src/App.tsx)。New/Save/Reload/Export zip/Import zip + canonical JSON 表示 + ログ。
- **テスト（14 件全通過）** — [test/](test/)。INV-4 byte 等価（MemoryFs / IndexedDbFs）、zip 決定論、FS レイアウト一致、正準化の冪等性、validate の各分岐。

**検証済み**: `npm run typecheck` ✅ / `npm test`（14 passed）✅ / `npm run build` ✅ / `npm run dev`（5173 で serve・TSX transform 確認）✅。

**M0 受け入れ条件**: 作成→保存→再読込→zip→再import が project.json 正準シリアライズ後 byte 等価 → roundtrip.test.ts で担保。`git init` 済みリポジトリ・`.gitignore` 追加（node_modules/dist 除外）。

---

## 進行中・未完了タスク

_なし_

---

## 既知のバグ・課題

- `npm install` 時に transitive deps の脆弱性警告（moderate×3 / high×1 / critical×1）。dev/build ツールチェーン由来で実行時には影響しないが、M1 着手前に `npm audit` で精査推奨。
- IndexedDbFs.list は全 key 取得 → prefix フィルタ（MVP の素直な実装）。アセット数増加時は IDBKeyRange 範囲クエリへ最適化（§11.1 注記どおり将来）。

---

## Next steps（次のセッションでやること）

- **M1 Core animation + DomRenderer** に着手:
  - `resolve(comp, frame): ResolvedScene`（純関数, INV-1）— parent チェーンを畳んで world `Mat4` を焼く（§6.3 合成順 `T·R·S·T(-anchor)`、euler Z·Y·X）。
  - Mat4 ユーティリティ（column-major）+ 補間（線形 + cubic-bezier easing, §6.4）。
  - `DomRenderer`（フラット matrix3d + opacity + z-index, preserve-3d, §8）。
  - solid/text/image component の描画 hook。
  - preview 再生（決定論 frame ステップ）+ Inspector + Undo/Redo（command + 逆 patch, §17）。
  - テスト優先: world 行列が §6.3 と一致、INV-2（preview≡export 値）。

---

## 更新履歴

| 日時 | 内容 |
|---|---|
| 2026-06-15 | progress.md 初期化 |
| 2026-06-15 | M0 Foundations 完了（schema / 正準シリアライズ / FS / zip / 作成読込 / 検証 / UI / テスト14件） |
