# Video Motion Track — Phase 1b 実装計画（回転 / POI / zoom）

> 正本。作成: 2026-07-03, Claude Fable 5（RG-20260703-01 の成果物）。
> 前提: Phase 1a（並進のみベイク）完了・`verify-motion-track.mjs` 3 シナリオ PASS。
> 旧計画 `.cursor/plans/video_motion_tracking_99321e75.plan.md` はワークスペースに現存しないため、本ファイルが Phase 1b 以降の計画正本。Phase 0/1a の経緯は `progress.md` 2026-07-03 エントリと `probe-motion-spike-report.md` を参照。

## 1. 一行結論

並進は QUAR `TrackerHandle`（Phase 1a・無改変）のまま、回転は**新設の rotation-only 推定器**（対応点 → ベアリングベクトル → Horn 四元数フィット + RANSAC、純 TS コア）を別ワーカーで追加する**ハイブリッド (E)**。zoom / two-node POI は 1b-b に後送。§5 / INV 変更なし。

## 2. なぜこの経路か（A–E 比較）

| 経路 | 判定 | 理由 |
|------|------|------|
| (A) QUAR upstream 6DoF 修正/フォーク | ❌ | ソースビルドでも inert。ソース精査で 6DoF pose 段が実質未完成と判明（フラグ起因でない）。未完成 VIO バックエンドの補完は工数無制限の研究タスク。upstream リリース時に再評価。 |
| (B) OpenCV.js essential + recoverPose | ❌（部分吸収） | essential は純回転・小基線で退化 = Phase 1b の主用途（パン）で最弱。並進方向は QUAR が既に 100%。KLT（対応点供給）としてのみ (E) に吸収。 |
| (C) TrackerHandle rotation ベストエフォート | ❌ 確定 | スパイク実測 axis·Y≈0.004。ヨーが x 並進に化ける。ノイズのベイクは機能ゼロより有害。 |
| (D) 縮小して Phase 2（COLMAP/Blender import）直行 | ❌（フォールバック保持） | ノーダルパン（実写最頻の運動）を安価に救えるのに捨てる理由がない。0b ゲート不合格時のフォールバック。 |
| **(E) ハイブリッド** | ✅ 推奨 | 回転にはスケール不定性が無い（単眼曖昧性は並進の大きさの問題）。rotation-only フィットはパン退化も homography 4 解曖昧性も回避。Phase 1a コード無改変で足せる。 |

**rotation-only フィットの設計**: 対応点ペア (prev, cur) を焦点距離推定値 f でベアリングベクトル化し、`Σ‖x̂_cur − R·x̂_prev‖` を最小化する R を Horn の四元数閉形式（4×4 固有値問題・純 TS ~200 LOC）で解く。RANSAC で外れ値（前景の動体・並進混在）を除去し、inlier 比率と残差を confidence とする。並進が支配的なフレームは残差が上がる → 低信頼としてホールド（Phase 1a の warmup/confidence 方針と同型）。

## 3. フェーズ分割

### Phase 0b — 対応点ソースのミニスパイク（ゲート付き・0.5〜1 日）

| # | 内容 | 産物 |
|---|------|------|
| 0b-1 | QUAR `inlier_points()` の返却形式を確認（(prev,cur) ペアか、現フレーム座標のみか） | `probe-rotation-spike.mjs`（`probe-motion-spike.mjs` の点群 pinhole 合成クリップ生成器を再利用） |
| 0b-2 | ペアが取れないなら公式 prebuilt opencv.js を worker で lazy load し `calcOpticalFlowPyrLK` + `goodFeaturesToTrack` を確認（ホワイトリスト含有・動作・サイズ） | 同上 + サイズ/ライセンス実測 |
| 0b-3 | Horn フィット + RANSAC のプロトタイプで合成クリップ B（ヨー）を推定 | ゲート数値 |

**ゲート**: 合成ヨークリップで累積ヨー誤差 < 10%・軸整合 |axis·Y| > 0.9・< 150 ms/frame（640px 幅）。**不合格 → Phase 1b 中止、Phase 2（COLMAP import）へピボット**（Phase 0 と同じフェイルプロトコル）。

### Phase 1b-a — 回転ベイク（Null + one-node Camera）

| # | ファイル | 内容 | 依存 | リスク |
|---|---------|------|------|--------|
| 1 | `src/editor/motionTrack/types.ts` | 追加のみ: `TrackMode`、quaternion 型、rotation worker メッセージ型 | — | 低 |
| 2 | `src/editor/motionTrack/rotationEstimator.ts`（新規） | ベアリング化・Horn 四元数フィット・RANSAC・confidence | 0b | 中 |
| 3 | `src/editor/motionTrack/rotationTrackWorker.ts`（新規） | 対応点ソース lazy load + 推定ループ | 0b, 2 | 中 |
| 4 | `src/editor/motionTrack/coordConvert.ts` | `slamRotationToMafterEuler` 追加（test-first） | — | 中 |
| 5 | `src/editor/motionTrack/smoothPoses.ts` | `smoothRotations` 追加 | — | 低 |
| 6 | `src/editor/motionTrack/applyMotionTrack.ts` | `bakeRotationKeyframes` 追加 | — | 低 |
| 7 | `src/editor/motionTrack/quarTracker.ts` | `runRotationTrack` 新規（`runMotionTrack` 不変） | 2,3 | 低 |
| 8 | `VideoComponentFields.tsx` | Mode セレクタ + 焦点距離スライダー | 6,7 | 低 |
| 9 | `public/motion-track/opencv/`（0b-2 のみ） | opencv.js vendor + PROVENANCE | 0b | 低 |
| 10 | `verify-motion-track.mjs` | 既存 3 シナリオ維持 + `yawPanRotation` | 1–8 | 低 |

### Phase 1b-b — two-node POI + zoom（1b-a 実写フィードバック後）

| # | 内容 | 備考 |
|---|------|------|
| 1 | two-node: POI 軌道 `poi' = position + R·(poi₀ − position)` | §16.1 POI 契約の言い換え |
| 2 | two-node ロール: lookAt + rotation 併用可否調査 | 不可ならパン/チルトのみ |
| 3 | zoom: 放射スケール → camera `zoom` KF | zoom/ドリー曖昧性はモード選択 |
| 4 | verify: `poiOrbit` / `zoomIn` | 点群生成器で合成 |

## 4. 型案（editor ローカル — §5 変更なし）

```ts
export type TrackMode = "position" | "rotation";
export type RawQuaternion = [number, number, number, number];

export interface RawRotationPose {
  frame: Frame;
  rotation: RawQuaternion | null;
  inlierRatio: number;
  residual: number;
  processMs: number;
}

export interface ApplyRotationTrackParams {
  baselineRotation: Vec3;
  rotationsByFrame: Map<Frame, Vec3>;
  bakeStart: Frame;
  bakeEnd: Frame;
  clearExpression: boolean;
}
```

## 5. spec 差分文案（§16.1 — 承認後に適用）

§16 テーブル: 「Motion Track 回転 / POI / zoom」行を「**実装中（2026-07 Phase 1b）**」へ。

§16.1 スコープ: 並進は Phase 1a どおり。回転は rotation-only モデルで Null / one-node Camera の `transform.rotation` にベイク。two-node POI / zoom は 1b-b。OpenCV.js は editor-only lazy load（該当時）。

## 6. verify / acceptance

- vitest: `motionTrackRotationConvert.test.ts`、`rotationEstimator.test.ts`、`bakeRotationKeyframes` 拡張
- Playwright: 既存 3 シナリオ PASS 維持 + `yawPanRotation`
- 無回帰: tsc / vitest 686+ PASS、`src/runtime/` 無変更

## 7. WASM サイズ・ライセンス

- QUAR `inlier_points()` 成功時: 追加 WASM ゼロ
- OpenCV.js: ~8–11 MB Apache-2.0、editor-only

## 8. Phase 1a 無回帰

`motionTrackWorker.ts` / `bakePositionKeyframes` / `smoothTranslations` / 既存 verify アサーションは変更禁止。回転は別ワーカー・別ベイクで並置。

## 9. 実装委任用ドラフト

0b ゲート PASS とユーザー承認後、`delegation.mjs` で DG 起票。詳細は RG-20260703-01 Handback 参照。

## 10. 要ユーザー確認（着手前）

1. 経路 (E) の承認
2. OpenCV.js vendor の可否（`inlier_points()` 不成立時）
3. 1b-a ターゲット = Null + one-node Camera のみ
4. two-node ロール制限（パン/チルトのみ）の可否
5. 焦点距離 = camera zoom + UI スライダー
6. 1b-b は 1b-a 実写フィードバック後に着手
