# fix-plan v3 — 連続再生オーディオマスター（seam declick 全撤去）

- 日付: 2026-07-10
- ブランチ: `fix/bundle-loop-audio-replan`（前提 HEAD: `8fcb694`）
- 方針決定者: ユーザー（「オーディオレイヤーのように扱う／ハードシークせず再生しっぱなし／映像が遅延したらフレームスキップ／declick は無意味に重くなるだけ」）
- 先行プラン: [fix-plan-v2-minimal.md](fix-plan-v2-minimal.md)（c903ab0・gain 分離）→ [fix-plan-v2plus-audio-separation.md](fix-plan-v2plus-audio-separation.md)（8fcb694・音声分離配線）→ 本プラン
- スコープ: **HTML bundle export（§11.7）の再生時のみ**。editor preview / mp4・webm・PNG export / スキーマ / INV には一切触れない。

---

## 0. 核心の発見 — 「残留クリック」の正体はコンテンツ由来だった

v2 / v2-plus で追いかけていた継ぎ目クリックの計測 fixture は **137.3 Hz サイン × 3.0 s ループ = 411.9 サイクル（非整数）**。つまり**素材そのものがループ境界で波形ジャンプ ~0.076 を持っている**（`verify-loop-seam-click.mjs` の冒頭コメントに "raw PCM jump ~0.076 at this exact boundary" と当初から明記されていた）。

これを踏まえて過去の実測を読み直すと:

| 版 | wrapPeakDelta | 解釈 |
|---|---:|---|
| 無修正 | ~0.10 | コンテンツ由来 0.076 ＋ 実装起因（フレームスキップで declick 脱落） |
| c903ab0（gain 分離） | ~0.05 | declick がコンテンツ由来ジャンプまで**化粧で隠した**値 |
| v2-plus（分離＋declick） | 0.07〜0.16 不安定 | declick の `el.volume` が sample 精度でないため化粧が**ランダムに失敗** |

**結論**: 実装が消すべきは「実装が足したクリック」だけ。コンテンツ由来の継ぎ目不一致は standalone audio レイヤーでも同様に鳴る＝**素材側の責務**（After Effects でもループ素材の継ぎ目はコンテンツ author が合わせる。AE parity 的にも正しい）。ユーザーの実耳テスト（「audio レイヤーに分けたらクリックが消えた」）は、ユーザーの実素材が継ぎ目でほぼ無音／連続だったことと整合する。

したがって v3 は **declick で継ぎ目を隠すのをやめ、「音声に一切触らない」ことで実装起因クリックをゼロにする**。

---

## 1. v3 の設計（シンプル版）

### 原則

1. **video 内蔵音声は audio レイヤーと同一の扱い**（v2-plus の分離配線をそのまま維持）。
2. **音声はループ 1 周の間、完全に自由走行** — mid-loop での seek・pause・volume 操作（seam declick）を一切しない。触るのはループ wrap の 1 回の seek のみ（これは standalone audio レイヤーが元々やっていて、ユーザーの耳が既に合格を出している挙動）。
3. **映像が遅れたら映像側がスキップして追いつく** — 既存の `audioMaster: true` ＋ wall-clock frame 導出（`Math.floor(elapsed × fps)`）＋ `adaptiveRenderBudget` で既に実現済み。音声側の帳尻合わせはしない。

### 現状（8fcb694）からの差分 = **削除だけ**

新規機構は追加しない。v2-plus で足した seam declick 機構を撤去する:

| # | 対象 | 変更 |
|---|---|---|
| D1 | `src/player/BundleAudioClock.ts` `tick()` ループ wrap 分岐 | `el.volume = 0;`（seek 直前の強制ミュート hack）を**削除**。seek は残す（wrap の 1 回だけ・必須）。 |
| D2 | `src/player/BundleAudioClock.ts` `applyGains()` | `clampFadeWindowToLoopRange(...)` 呼び出しを**削除**し、v2-plus 以前どおり素の `info.inPoint / info.outPoint` を `autoFadeMultiplierAtFrame` に渡す。→ ループ境界にフェード窓が来なくなる＝継ぎ目で volume を動かさない。 |
| D3 | `src/player/bundleFootageAudio.ts` | `clampFadeWindowToLoopRange` 関数を**削除**（呼び出し元が消え dead code になるため）。 |
| D4 | `test/bundleFootageAudio.test.ts` | `clampFadeWindowToLoopRange` の 4 テストを**削除**。 |

### 維持するもの（触らない）

- **v2-plus の分離配線一式**: `collectBundleFootageAudioSources` / `hasBundleFootageAudio` / `footageAudioMediaTimeSec`（trimStart・inPoint バグ修正を含む）/ `persistentlyMutedVideoIds`（video 常時ミュート・二重音声防止）/ `BundlePlayer` の `audioMaster: true` 配線。
- **§11.5.2 の標準カット端 autoFade**（レイヤー自身の inPoint/outPoint 端でのフェード）。これは spec 既定 ON・preview/export 共有の挙動で、本 issue とは別物。D2 により「ループ境界を疑似カット端扱いする拡張」だけが外れ、v2-plus 以前の spec どおりの挙動に戻る。
- `hasAudioLayers`（editor preview 共有）— 従来どおり不変。
- c903ab0 の `onFrameAudio` / `videoGainOnly` 経路 — bundle では audioClock 分岐が優先されほぼ不達だが、editor preview と共有しており無害。**本プランでは触らない**（掃除するなら別チケット）。

### 禁止事項（従来から継続）

- Web Audio graph / AudioContext / MediaElementAudioSourceNode を player 実装に導入しない（postmortem 参照。計測ハーネス内での使用は可）。
- `hasAudioLayers` のセマンティクス変更禁止。
- export・editor preview・§5 スキーマ・INV に触れない。

---

## 2. 検証（実ブラウザ＋実キャプチャ必須 — 従来どおりこれ以外を合格根拠にしない）

ハーネスは既存の [verify-loop-seam-click.mjs](verify-loop-seam-click.mjs) を使う（`HTMLMediaElement.prototype.play` フック済みで detached `<audio>` も捕捉できる）。

### 2a. ループクリーン fixture の追加（実装起因クリックの分離計測）

現行 fixture（137.3 Hz）はコンテンツ由来ジャンプを持つため「実装がクリックを足していないか」を単独で測れない。**ループ範囲 3.0 s で整数サイクルになる周波数**（例: 110 Hz × 3.0 s = 330 サイクル、または 100 Hz = 300 サイクル）の H.264+AAC fixture を ffmpeg で生成する:

```
ffmpeg -f lavfi -i "sine=frequency=110:duration=5" -f lavfi -i "color=c=blue:s=320x240:d=5" \
  -map 1:v -map 0:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 loopclean_h264_aac.mp4
```

注意: AAC はフレーム境界（1024 samples）とエンコーダディレイを持つため厳密なゼロにはならないが、非整数サイクル素材の 0.076 とは桁で区別できる。生成後、raw PCM で境界ジャンプが十分小さいことをオフラインで確認してから使う（`ffmpeg -i ... -f f32le -` でデコードし、media 時刻 3.0 s と 0 s のサンプル値を比較）。

### 2b. 受け入れ基準

| # | 条件 | 合格ライン |
|---|---|---|
| A | ループクリーン fixture・throttle 6x | `wrapPeakDelta` が background（`backgroundMedianDelta` の数倍以内）に収まる ＝ **実装起因クリックなし** |
| B | ループクリーン fixture・no-throttle | 同上。かつ throttle 有無で結果が乖離しない（フレームスキップが音声に影響していない証明） |
| C | 旧 fixture（137.3 Hz・非整数） | `wrapPeakDelta` ≈ 0.076（コンテンツ由来の理論値）近傍で安定。**それを大きく超えない**（実装が上乗せしていない） |
| D | パリティ | 同一素材を standalone `audio` レイヤーとして置いた bundle と、video 内蔵音声としての bundle で `wrapPeakDelta` が同等（「video 音声＝audio レイヤーと同じ扱い」の直接証明） |
| E | 最終 | ユーザー実機・実耳での Comp 10 確認（automated 合格後に依頼） |

C で 0.076 を大きく超える／run 間で不安定な場合は STOP してユーザーに報告する（wrap seek のタイミング揺れ＝rAF 遅延で継ぎ目位置がランダム化している可能性。その場合の追加策はユーザーと相談 — 勝手にエスカレートしない）。

### 2c. 回帰ゲート

- `npm run typecheck` / 対象 unit tests（`bundleFootageAudio` / `BundleAudioClock` 系 / `previewPlaybackLoop`）
- **`npm run build:player` 必須**（`src/player/` 変更のため。CLAUDE.md の bundle 再ビルド規約）
- `playerBuildFreshness` テスト
- editor preview 側に差分がないこと（`hasAudioLayers` と §11.5.2 標準 autoFade は不変なので diff で確認できる）

---

## 3. 手順まとめ（実装者向けチェックリスト)

1. [ ] D1–D4 の削除を実施（新規コードなし）
2. [ ] `npm run typecheck` ＋ unit tests green
3. [ ] `npm run build:player`
4. [ ] ループクリーン fixture 生成 → オフライン PCM で境界連続性を確認
5. [ ] 受け入れ A〜D を実 Chromium で計測（`VIDEO_PATH=... CPU_THROTTLE=... node doc/issue/static-noise-problem/verify-loop-seam-click.mjs --label ...`）
6. [ ] 結果を本ドキュメント末尾に実測表で追記（不合格でも正直に書く）
7. [ ] `progress.md` 更新
8. [ ] ユーザーに Comp 10 実耳確認を依頼（基準 E）

想定工数: 実装は削除のみで小。大半は fixture 生成と計測。パフォーマンスは declick の毎 tick フェード計算と volume 書き込みが減るため**軽くなる方向のみ**（追加計測不要）。
