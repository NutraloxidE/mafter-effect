# after-v3 implementation report — editor preview の連続オーディオ方針

- 日付: 2026-07-10
- 状態: **設計評価のみ。未実装。**
- 前提: [fix-plan-v3-continuous-audio.md](fix-plan-v3-continuous-audio.md) の bundle 向け v3 は、loop seam の declick を撤去し、音声を 1 周の途中で操作しない方針である。
- 対象: editor preview の重負荷時に発生する音声の途切れ・プチプチ。

---

## 1. ユーザー価値と結論

重い comp を編集するときは、**音声を連続させ、映像をフレームスキップで追従させる**。音声時刻を映像の decode 遅延に合わせて止めない。

これは bundle v3 の `audioMaster: true` と同じ優先順位である。音声が正準の transport clock となり、映像の描画が間に合わなければ中間フレームを捨てて最新の音声時刻に対応するフレームを表示する。

この方針で保証する「ずれない」は **audio clock と timeline frame が同じ時刻を指す** ことをいう。decode が追いつかない video は一時的にコマ落ち、または直近のピクセルを表示することがある。これは物理的に避けられないトレードオフであり、音声を stop/resume してリズムを壊すより editor の体験として優先する。

---

## 2. 現状と問題経路

audio レイヤーが存在する editor preview は `PreviewAudioClock` を使う。video が遅れたと `computePlaybackSyncState()` が `holdTimeline` を返し、現在の `PreviewAudioClock` は次を行う。

1. `frozenFrame` を保存する。
2. `AudioContext.suspend()` を呼ぶ。
3. 映像の遅れが解消すると `AudioContext.resume()` する。

この stop/resume は、重い映像・頻繁な hold で音を断続させる直接の経路である。これは seamless loop のための標準 autoFade とは別問題である。

- [src/editor/previewAudioClock.ts](../../../src/editor/previewAudioClock.ts): audio clock と `holdTimeline` 時の suspend/resume。
- [src/runtime/playbackVideoSync.ts](../../../src/runtime/playbackVideoSync.ts): video lag で `holdTimeline`、video lead で `pauseVideo` を決める状態機械。
- [src/player/BundleAudioClock.ts](../../../src/player/BundleAudioClock.ts): `audioMaster: true` なら `holdTimeline` でも音声を止めない既存の参照実装。

一方、標準の §11.5.2 autoFade は layer 自身の `inPoint/outPoint` で音の pop を防ぐための sample-accurate ramp であり、撤去対象ではない。

---

## 3. 提案: Phase A — standalone audio の audio-master 化

### 変更範囲

`PreviewAudioClock` が有効なときだけ、video lag による `holdTimeline` を音声停止へ変換しない。

- `AudioContext.suspend()` / `resume()` を `holdTimeline` を理由に呼ばない。
- `ctx.currentTime` と `originFrame` から frame を継続算出する。
- `onFrameChange` と Draft の `renderFrame` は現在の frame を受け、途中フレームを描かずに最新 frame を描く。
- video lead の `pauseVideo`、および既存の ±4% playback-rate 補正は維持する。
- `loop` の wrap、scrub、明示 pause/stop は従来どおり audio clock を制御する。

### 期待効果

- 重い映像 decode / effect / raster があっても、audio layer のリズムが止まらない。
- timeline は audio clock 由来なので、音と playhead の時刻がずれない。
- 中間フレームの描画を省くため、重負荷時の UI 応答性が改善する。
- bundle v3 と preview の優先順位が揃う。

### 制約とリスク

- decode が継続的に不足する video は映像が古く見える、またはコマ落ちする。これは音声連続性との意図的な交換である。
- ±4% の video rate 補正では大きな decode 遅延を回復できない。持続する lag は proxy / footage quality / preview cache で解く必要がある。
- `holdTimeline` を単に無視するだけでなく、frame 更新が重い render に待たされないことを実機で確認する。最新 frame 以外を描かないという render-gate の性質を保つ。

### 非変更

- §11.5.2 の標準 autoFade と `scheduleDeclickRamps`。
- `hasAudioLayers` の定義と呼び出し元。
- project schema / serialization / INV。
- bundle export / mp4 / webm / PNG export。

---

## 4. Phase B — video 内蔵音声の完全な一貫性（別チケット）

Phase A の対象は standalone `audio` レイヤーのみである。現 editor preview では video 内蔵音声が `<video>` 要素から直接鳴り、`PreviewAudioClock` の AudioContext には入らない。

従って「**すべての可聴音が audio-master transport に厳密追従する**」保証には、別の設計が必要となる。

1. video 内蔵音声を独立した音声再生経路で用意する。
2. 表示用 `<video>` は常時 mute し、二重再生を防ぐ。
3. `inPoint` / `outPoint` / `trimStart` / gain / autoFade / loop wrap / scrub / hold を独立音声経路へ正しく反映する。
4. video-only、audio-only、混在 comp で実機音声と A/V 時刻を検証する。

これは bundle v2-plus の分離配線に似るが、editor の AudioContext、ユーザー操作による autoplay、動画音声の decode 可否を含むため、Phase A に混ぜない。`hasAudioLayers` の意味を広げず、preview 専用の source collection / clock として設計する。

---

## 5. 検証計画

Phase A は unit test だけで完了にしない。実 Chromium の editor preview で次を確認する。

| # | 条件 | 合格条件 |
|---|---|---|
| A | standalone audio + 重い video/effect、Draft playback | 音声が stop/resume で断続せず、playhead が音声 clock と連続して進む。 |
| B | 同じ comp、負荷なし | 通常再生の A/V 時刻が既存許容範囲に収まる。 |
| C | 意図的に decode を遅らせる | 音声は連続し、中間フレームを捨てて最新時刻へ追従する。video lag が残る場合は見た目の劣化として観測・記録する。 |
| D | loop / scrub / pause / resume | これらの明示操作では正しい seek・停止・再開を行い、ループ中に余分な stop/resume を発生させない。 |
| E | standard autoFade のある audio clip | 本来の in/out カット端の pop 防止が維持される。 |

回帰ゲート:

- `previewAudioClock` / `playbackVideoSync` / `footageAutoFade` の unit tests。
- `npm run typecheck` と通常 test suite。
- Playwright + Chromium での preview 実機確認。音声の連続性は、可能なら音声キャプチャまたは Web Audio の状態遷移ログでも検証する。
- export と bundle の差分が無いことを確認する。

---

## 6. 判断

Phase A を次の実装候補として推奨する。これは新しい音声処理を加えず、既存 AudioContext の clock を video lag で止めない小さな優先順位変更である。

Phase B は、video 内蔵音声も含めた完全な audio-master parity が必要になった時点で、別チケットとして spec・実装・実機検証を行う。

