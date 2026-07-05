---
name: Bidirectional video/timeline playback sync
overview: 片方向 timeline-hold だけでは「映像以外が遅れる」（映像先行）が残る。映像遅れ→timeline hold、映像先行→video pause の双方向ゲートで同期する。
todos:
  - id: sync-state-machine
    content: playbackVideoSync を双方向（holdTimeline / pauseVideo）状態遷移に拡張
    status: completed
  - id: wire-pause
    content: DomRenderer + videoElementSync に pauseForSync、PreviewPanel/AudioClock 配線
    status: completed
  - id: unit-tests
    content: lead/lag ヒステリシス・相互排他・フェイルセーフ unit
    status: completed
  - id: playwright
    content: verify-video-playback-sync.mjs で |target−currentTime| を実測
    status: completed
  - id: spec-progress
    content: §11.4 散文更新 + progress + build:player
    status: completed
isProject: false
---

# 映像 × タイムライン双方向再生同期プラン

## 一行結論

**映像遅れ → タイムライン hold（既存）** に加え、**映像先行 → video pause（新規）** で双方向に閉じる。seek は使わず、スクラブ応答と旧 HW 対策 A を壊さない。

## 症状解析

| 見え方 | 時計の関係 | `error = targetSec − currentTime` |
|--------|------------|-----------------------------------|
| カメラ／他レイヤーが**速い**（前回修正） | タイムライン先行 | `error > 0`（映像遅れ） |
| カメラ／他レイヤーが**遅い**（今回） | 映像先行 | `error < 0`（映像先行） |

### なぜ片方向 hold だけでは足りないか

```mermaid
sequenceDiagram
  participant TL as Timeline/Camera
  participant Vid as video.play()

  Note over TL,Vid: 重い render / React effect 遅延
  Vid->>Vid: 実時間で currentTime 進行
  TL->>TL: frame 更新が遅れる
  Note over TL,Vid: error &lt; 0 → 映像以外が遅れて見える
```

前回の hold は `error > 0` のときだけ TL を止める。`error < 0`（映像が先）では何もしないため、render が壁時計より遅い・映像が hold 解除直後にわずかに先行する、などで **カメラ／solid／text が映像より遅れて見える**。

hold 中に video は `play()` 継続するため、解除直後に `currentTime ≈ targetSec` でも、その後 TL が 1 フレーム遅れるだけで映像先行が蓄積しうる。

## 非目標

| やらない | 理由 |
|----------|------|
| 再生中の毎フレーム seek | 旧 HW seek 連鎖 |
| scrub / export 変更 | レスポンス・INV-2 |
| video-led clock 全面移行 | AudioClock 統合コスト。pause/hold で足りる |
| §5 / INV / project.json | 不要 |

## 推奨経路（固定）: 経路 H2（双方向ゲート）

| `error = targetSec − currentTime` | アクション |
|-----------------------------------|------------|
| `error > enterSec`（映像遅れ） | **hold timeline**（映像は play 継続） |
| `error < −enterSec`（映像先行） | **pause video**（タイムラインは進行継続） |
| ヒステリシス解除 | hold: `error ≤ exitSec` / pause: `error ≥ −exitSec` |
| フェイルセーフ | 各ゲート連続 1.0s で強制解除 + warn |

**相互排他（複数 video・デッドロック防止）**:

1. いずれかが映像遅れ（lag ≥ enter）→ **hold のみ**（pause しない＝遅れ video が追いつける）
2. 遅れが無く、いずれかが映像先行（lead ≥ enter）→ **pause のみ**
3. 同時に hold+pause はしない

閾値: `enterSec = 1/fps`、`exitSec = videoSeekThresholdSec(fps)`（既存語彙）。

### 適格サンプル

- `ended` / `error` / `targetSec ≥ duration` は除外
- **`paused` は除外しない**（sync pause 中も lead を測る。除外すると pause↔play 発振）

lookahead は root 外のため `sampleMountedVideoClocks` に元から含まれない。

## 影響経路

| 経路 | 変更 |
|------|------|
| preview 再生 | H2 双方向 |
| preview scrub | 不変 |
| bundle | barrier のみ維持（pause hold は autoplay 凍結リスクのため入れない） |
| export | 不変 |

`npm run build:player` 必須。

## 実装詳細

### 1. `playbackVideoSync.ts`

`HoldState` を拡張（または置換）:

```ts
export interface PlaybackSyncState {
  holdTimeline: boolean;
  pauseVideo: boolean;
  holdStartedAtMs: number | null;
  pauseStartedAtMs: number | null;
}

export function maxVideoLeadSec(samples): number  // max(current − target)
export function computePlaybackSyncState(prev, samples, thresholds, nowMs): PlaybackSyncState
```

`computeHoldState` は `holdTimeline` だけ返す薄いラッパに残すか削除して呼び出し側を置換。

### 2. `videoElementSync.ts`

```ts
pauseForSync?: boolean  // playbackMode 中: pause して return（seek しない）
```

### 3. `DomRenderer`

```ts
setPlaybackPauseForSync(pause: boolean): void
// true: 全マウント video を即 pause
// false: previewVideoPlayback 中なら play() 再開（best-effort）
// updateComponentEl → syncVideoElementTime(..., { pauseForSync })
```

### 4. PreviewPanel / PreviewAudioClock

毎 tick `computePlaybackSyncState` → `setPlaybackPauseForSync` + `shouldHold = state.holdTimeline`。

### 5. 受け入れ条件

| ID | 条件 |
|----|------|
| B1 | unit: lag→hold / lead→pause / ヒステリシス / 相互排他 / paused サンプルでも lead 計測 / フェイルセーフ |
| B2 | 既存 videoElementSync + playbackVideoSync 無回帰 |
| B3 | Playwright: 再生 2s サンプリングで `max\|targetSec−currentTime\| < 2/fps`（warm 後） |
| B4 | Playwright: 人工的に video を先行させても pause 後に lead が縮小 |
| B5 | `build:player` exit 0 |

## 実装順序

1. 純関数 + unit（B1）
2. videoElementSync / DomRenderer
3. PreviewPanel / PreviewAudioClock
4. §11.4 散文
5. verify-video-playback-sync.mjs + build:player

## リスク

| リスク | 緩和 |
|--------|------|
| pause/play チャタリング | ヒステリシス + 相互排他 |
| pause を paused 除外すると発振 | paused を適格に含める |
| 内蔵音声が細切れ | enter=1f なので軽微。failsafe 1s |
| bundle autoplay | pause ゲートは Preview のみ |
