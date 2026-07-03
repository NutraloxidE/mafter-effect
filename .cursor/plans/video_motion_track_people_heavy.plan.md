---
name: Motion Track People-Heavy
overview: 人混みシーンで Motion Track が破綻する主因（動体特徴の数的支配・ROI 縁の偽特徴・無効フレームの position スナップバック）を、依存追加ゼロの特徴トラック品質パック + ベイク補間で直す（Phase 1d）。Fable RG-20260704-01 推奨。
todos:
  - id: phase-1d-fb-lk
    content: "rotationTrackWorker: forward-backward LK + err 閾値棄却"
    status: completed
  - id: phase-1d-rediscover
    content: "グリッド分散再検出（8×6・N=10 or トラック数閾値割れ）"
    status: completed
  - id: phase-1d-roi-margin
    content: "ROI 縁 ±3px 内の特徴棄却（roi rect を worker に渡す）"
    status: completed
  - id: phase-1d-interp
    content: "buildPositionsFromTrack: invalid を baseline ではなく前後補間（スロープ制限）"
    status: completed
  - id: phase-1d-tests
    content: "純関数テスト（featureQuality / positionInterp / ROI 縁）"
    status: completed
  - id: phase-1d-verify
    content: "既存 motion-track vitest 無回帰 + progress/spec 追記"
    status: completed
isProject: false
---

# Motion Track — 人混み耐性改善（Phase 1d+）

**出典**: Fable 委任 [RG-20260704-01](.cursor/delegations/handoffs/RG-20260704-01.md)（2026-07-04）

## 一行結論

人混み破綻の主因は「特徴点選別と外れ値排除の弱さ」。次の 1 本は依存追加ゼロの **Phase 1d: 特徴トラック品質パック + ベイク補間修正**。人物セグメンテーション（ML）はその次（Phase 1f、~6MB vendored はユーザー確認後）。

---

## 問題診断（ROI mask だけでは足りない理由）

| ID | 問題 | 現状コード | 影響 |
|----|------|-----------|------|
| **(a)** | 動体特徴の数的支配 + **構造化外れ値** | `goodFeaturesToTrack` はコーナー強度のみ。RANSAC は無構造外れ値前提 | 群衆が多数派だと「合意」が人の動き＝誤カメラ運動 |
| **(b)** | 特徴が frame 0 一回きり | `prevPts = nextPts` 連鎖のみ・再検出なし | 人に張り付いた点がクリップ全体を汚染・長尺で飢餓 |
| **(c)** | **ROI mask 縁の偽特徴**（具体バグ） | 黒⇔映像境界が強いコーナーかつ画像固定。ROI 縁は素通し | ゼロ運動インライアが回転を identity 側へ引く。**ROI を狭くするほど悪化しうる** |
| **(d)** | **position スナップバック**（具体バグ） | `buildPositionsFromTrack` が invalid に `baseline` を焼く | 人混みで invalid 頻発 → ガタガタ跳ぶ（回転側は前値ホールドで非対称） |

**ROI mask が直すもの**: 静的に位置が既知の群衆領域の除外、主点維持。  
**直さないもの**: 横切る動体、ROI 内の低テクスチャ背景、(b)(c)(d)。

---

## アイデアカタログ（Fable）

| # | 案 | 効果 | 工数 | フェーズ |
|---|----|------|------|---------|
| 1 | 特徴トラック品質パック（FB-LK / グリッド再検出 / ROI 縁棄却 / err 閾値） | **高** | S–M | **1d（primary）** |
| 5 | 無効フレーム補間（baseline スナップバック廃止） | **中** | S | **1d（primary）** |
| 2 | 2 パス解析 + 恒常外れ値ブラックリスト | 高 | M | 1e |
| 3 | MediaPipe 人物セグメンテーション（Apache-2.0, ~6MB） | 高 | M–L | 1f（要確認） |
| 4 | Preview 上 ROI ドラッグ + 複数矩形 | 中（UX） | M | 1g（任意） |
| 6 | COLMAP / Blender import | 高（別枠） | L | Phase 2（既存路線） |

### 却下（今はやらない）

- GPL SLAM（AlvaAR）
- ブラウザ内フル SLAM / BA（§16.1 ラフパスに過剰）
- RAFT 等 dense flow ML（数十 MB）
- QUAR 置き換え（入力品質修正が先）
- resolve() 内ライブトラッキング（INV 境界破壊）

---

## Phase 1d — 実装プラン（次にやる 1 本）

**スコープ**: `src/editor/motionTrack/` のみ。依存追加なし。§5 / INV / project.json 変更なし。`src/runtime` 非変更。

### 1d-A: 回転経路の特徴品質（`rotationTrackWorker.ts`）

1. **Forward-backward LK**: 往復誤差 > 1px の点を棄却
2. **LK `err` 閾値**: OpenCV が返す誤差行列を使い、閾値超えを棄却
3. **グリッド分散再検出**: トラック数閾値割れ **または** 毎 N=10 フレームで `goodFeaturesToTrack` を再実行。8×6 セル各上位 K 点。既存点近傍は除外（群衆の数的支配を抑制）
4. **ROI 縁マージン**: `TrackRoi` を worker に渡し、ROI 矩形縁 ±3px 内の特徴を棄却（診断 c の修正）。`roiToPixelRect` を再利用

### 1d-B: position ベイク補間（`quarTracker.ts`）

- `buildPositionsFromTrack`: invalid フレームに `baseline` を焼くのをやめ、**前後の有効値で線形補間 + スロープ制限**
- 回転側の前値ホールドと対称な「跳ばない」挙動にする
- 純関数化して単体テスト可能に（`interpolateInvalidPositions` 等）

### 触るファイル

| ファイル | 変更 |
|---------|------|
| [`rotationTrackWorker.ts`](src/editor/motionTrack/rotationTrackWorker.ts) | FB-LK / err / 再検出 / ROI 縁 |
| [`trackRoi.ts`](src/editor/motionTrack/trackRoi.ts) | 縁マージン用ヘルパ（任意） |
| [`types.ts`](src/editor/motionTrack/types.ts) | worker frame メッセージに `roi` 追加 |
| [`quarTracker.ts`](src/editor/motionTrack/quarTracker.ts) | roi を rotation worker へ、`buildPositionsFromTrack` 補間 |
| `test/motionTrackFeatureQuality.test.ts`（新規） | 合成 ImageData 注入 |
| `test/motionTrackPositionInterp.test.ts`（新規） | スナップバック修正 |
| [`doc/mafter-effect-spec.md`](doc/mafter-effect-spec.md) §16.1 | 散文 1 行（品質フィルタ・補間） |

### 受け入れ条件（測定可能）

検証は **合成 ImageData 列を推定器に直接注入**（動画デコード非依存）。背景テクスチャ + 移動スプライト群を canvas 生成。

1. **群衆耐性**: 動体占有 ~50%・±10° パンで、回転 RMSE が現行比 **≥50% 改善**、valid フレーム率 **≥80%**
2. **無回帰**: 動体なしクリーン列で回転 RMSE 悪化 **≤5%**。既存 `verify-motion-track.mjs` / motion-track vitest PASS
3. **ROI 縁**: 中央 50% ROI + 既知回転で、推定/真値 **≥0.9**（実装前に現行バイアスを計測しベースライン化）
4. **スナップバック**: 中間 invalid を含む列で、position フレーム間ジャンプ最大 ≤ 有効区間中央値の **3 倍**
5. **実機スモーク**（任意）: people-heavy 実写 1 本で Track → ベイク完走・目視でガタつき減

### 実装順序

```
1. interpolateInvalidPositions 純関数 + テスト（1d-B）— 即効・低リスク
2. ROI 縁棄却（1d-A-4）— Phase 1c の逆効果を止める
3. FB-LK + err（1d-A-1,2）
4. グリッド再検出（1d-A-3）
5. 合成群衆テスト + 既存 verify 無回帰
6. progress.md / §16.1 追記
```

---

## 後続フェーズ（1d 完了後）

| Phase | 内容 | 着手条件 |
|-------|------|---------|
| **1e** | 2 パス解析 + 恒常外れ値ブラックリスト | 1d のトラック基盤の上 |
| **1f** | MediaPipe 人物セグメンテーション（~6MB vendored） | **ユーザーが 6MB 追加を承認** |
| **1g** | Preview 上 ROI ドラッグ | UX 要望が強ければ 1e より先でも可 |
| **2** | COLMAP / Blender import | 本格ソルブ（既存路線） |

**注意（Fable）**: QUAR 並進は特徴点 API 非公開のため、1d の改善は**回転経路に効きが偏る**。並進の人混み耐性は 1f（人物マスク黒塗り）まで限定的。主訴が並進ガタつきなら 1f 優先度を上げる判断あり。

---

## ユーザー確認（任意・1d 着手はブロックしない）

1. Phase 1f 用に MediaPipe tasks-vision（Apache-2.0、~6MB）を `public/motion-track/` に vendored してよいか
2. people-heavy 実写素材（5–10 秒 × 2–3 本）を提供できるか（無ければ自動ゲートは合成のみ）

---

## 実装委任用一文（delegate-to-cursor）

Phase 1d: Motion Track の回転経路（`rotationTrackWorker.ts`）に (1) forward-backward LK（往復誤差 >1px 棄却）、(2) トラック数閾値割れ or N=10 フレーム毎のグリッド分散再検出（8×6・各セル上位 K）、(3) ROI 矩形縁 ±3px 内の特徴棄却（`trackRoi` を worker に渡す）、(4) LK err 閾値棄却。併せて `buildPositionsFromTrack` を無効フレーム=baseline から前後有効値の補間（線形+スロープ制限）に変更。§5/INV 変更なし・依存追加なし。受け入れは本 plan の測定条件 1–4 + 既存 verify 無回帰。
