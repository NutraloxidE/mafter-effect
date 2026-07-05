# Subject Extract Comp 30 修正プラン

## 受け入れ条件

**人物の抽出が成功する** — Comp 30（mafter-project 19）で Subject Extract 済み Person レイヤーに、背景透過の人物 ink がプレビュー・export の両方で可視。

## 調査結果（2026-07-05）

### 再現データ

- `Downloads/mafter-project (19).zip` → Comp 30
- ソース: `01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4`（1080×1920 portrait）
- Extract 出力: `01KWR60WTDYF9V7DB7X78TZE67`（split alpha, 640×1138, 5s）

### 計測

| 指標 | color.webm | alpha.webm |
|------|------------|------------|
| ffprobe | vp9 640×1138, ~8185 kb/s | vp9 640×1138, ~205 kb/s |
| 1f PNG サイズ | ~1077 KiB | **~2.3 KiB（ほぼ単色＝マスク空）** |

→ **エンコード／再生合成以前に、セグメンテーションが空マスクを生成している**。

### 真因仮説（優先度順）

1. **`categoryMask` 未取得時に無言で全ゼロマスク**（`personSegmenter.ts` L48-49）
2. **`selfie_segmenter` が `confidenceMasks[0]` のみ返す経路** — category 未使用
3. **MPMask 解像度 ≠ フレーム解像度** — リサイズなしで mis-apply / 空扱い
4. GPU delegate で mask readback 失敗（CPU フォールバック不十分）

### 再生側（split alpha）

- 前回修正済み: RGB マスク → alpha 合成、export inline 除外
- マスクが空なら再生修正だけでは **受け入れ不可**

## 修正方針

### A. セグメンテーション（必須）

`personSegmenter.ts` + `maskComposite.ts`:

1. `outputConfidenceMasks: true` を有効化
2. `maskFromResult`:
   - `categoryMask` → `categoryMaskToAlpha`（0/1 **および 255** を person 扱い）
   - 解像度不一致時は canvas で **targetW×targetH にリサイズ**
   - category が空（ink=0）または undefined → **`confidenceMasks[0]` float→byte フォールバック**
3. Subject Extract は **CPU delegate 優先**（GPU→CPU は init のみ、segment は CPU 既定）
4. 全ゼロマスク時は **警告ログ + Extract UI に失敗メッセージ**（無言成功禁止）

### B. 検証

1. `test/subjectExtractMask.test.ts` — リサイズ・confidence フォールバック純関数
2. `verify-subject-extract-comp30.mjs` — 最小 project（Comp 30 のみ）で person ink 計測
3. 受け入れ: `segmentedFrameStats.opaque+semi > 500` かつ `domCanvasStats` 同閾値

### C. 非スコープ

- OpenCV DNN / 複数人物
- §5 スキーマ変更なし（meta 既存の split alpha 維持）

## タッチファイル

- `src/editor/subjectExtract/personSegmenter.ts`
- `src/editor/subjectExtract/maskComposite.ts`
- `src/editor/subjectExtract/runSubjectExtract.ts`（空マスク検出）
- `test/subjectExtractMask.test.ts`
- `verify-subject-extract-comp30.mjs`

## リスク

- confidence 閾値で髪/手が欠ける → 初期は 0.5 閾値なし（float そのまま byte 化）
- CPU のみで Extract 遅延 → 許容（正しさ優先）
