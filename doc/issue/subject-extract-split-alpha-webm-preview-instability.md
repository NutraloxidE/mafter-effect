# Subject Extract split-alpha WebM — preview 再生の不安定さ（調査）

> **対象**: Subject Extract（§16.2）で生成される **split alpha WebM**（Chrome 等 `alpha:keep` 非対応環境で color `.webm` + グレースケールマスク `.alpha.webm` の2本に分離されたアセット）の **Preview パネル再生時**の挙動。
> **状態**: 2026-07-06 **修正1・2 実装済み**（下記「実装状況」参照）。修正0/3/4 は未着手。実 Chrome での手動確認は次セッション待ち。
> **2026-07-06 追記**: ユーザー報告により **「Subject Extract の webm と同時にテキストレイヤーもフリーズ／もたつく」** ことを確認。コードレビューの結果、これは副作用ではなく **設計どおりの直結した挙動**（`holdTimeline` が真になっている間、Draft rAF ループ・Best frame clock・AudioClock マスタークロックのいずれも **`onFrameChange` を一切呼ばない** → 対象コンポの **全レイヤーの DOM 更新が完全に止まる）だと判明。詳細は「テキストが一緒にフリーズする理由（確定）」を参照。
> **2026-07-06 追記2**: 「Comp 32 の再生がスムーズなこともある」というユーザー報告を調査し、**Play を押す前の動画 warm-up（先読み）が間に合ったかどうかの非決定的なレースも preview 不安定さの一因**であることを確認。詳細は「[なぜ「毎回ではなく時々」なのか](#なぜ毎回ではなく時々なのか--再生開始前の-warm-up-が勝つか負けるかのレース2026-07-06-追記)」/ [不具合③](#問題の分解--実は独立した3つの不具合) を参照。
> **2026-07-06 追記3（実機 Playwright 検証）**: 他セッションからのフィードバックを受け、`window.__mafterEditorStore` 直接操作 + CDP `Media` ドメインによる実機検証を実施（[verify-comp32-webm-instability.mjs](../../verify-comp32-webm-instability.mjs)）。**holdTimeline の実発火をサンプル時間の約93%という規模で確認**、**Person レイヤーの2ストリームが両方ソフトウェア VP9 デコードだったことを確認**した一方、**warm-up レース（追記2）単独では観測された stall 規模を説明できないと判明**（ready 100% のシナリオと 0% のシナリオで stall 合計時間がほぼ同じ）。詳細は「[実機 Playwright 検証](#実機-playwright-検証2026-07-06-追記他セッションからのフィードバック反映)」を参照。
> **2026-07-06 追記4（修正1・2 実装）**: `filterPrimaryVideoSamples`（companion をグローバル hold/pause 判定から除外）と `computeAlphaGenlockRate`/`applyAlphaGenlock`（color/alpha の playbackRate 微調整 genlock）を実装。`npm test` 884 PASS（新規11件）・`typecheck` 緑・`build:player` 実行済み。**実機（Playwright/実Chrome）での再検証は未実施** — ユーザー希望により次回は実 Chrome での手動確認を予定（Playwright は headless 由来の decode 挙動差が大きく判定に使わない方針）。
> **2026-07-08 追記5（修正4=packed alpha 実装済みだが decode-bound 自体は残存 — Comp32 実機再計測）**: `修正4` は §16.2b **packed alpha として実装済み**（2ストリーム→1ストリーム化）。しかし最新プロジェクト（`mafter-project (22).zip`）の Comp32 Person レイヤーを実機 Playwright で再計測したところ、**1ストリーム化しても decode-bound な stall 自体は解消していない**と判明した。原因は本 doc の主眼（2本独立デコードのドリフト）とは別の要因: この packed アセットは `contentHeight=1138`（packed 高さ ≈2284px）と大きく、**H.264/mp4 ハードデコード優先という §16.2b の既定方針に反して webm（VP9 ソフトウェアデコード）に落ちている**。巨大フレームを 1 本でも実時間デコードしきれず、`holdTimeline` が繰り返し発火 → **8 秒間の壁時計でタイムラインは約 3.9 秒分（≈frame 116）しか進まず、実時間の約半分の速度に低下**。同時に `getVideoPlaybackQuality()` の dropped frame 比率は約 38%（130 decode 中 49 drop）。1本化（修正4）は「color/alpha 間の輪郭ズレ・ドリフト」（不具合②の一部）は原理的に解消するが、**「decode が実時間に追いつかない」という不具合①の根本トリガーはストリーム数ではなくフレームサイズ×コーデックで決まる**ため、1本化だけでは holdTimeline 連発は消えない、という新しい知見。対策は「packed 専用の縮小 preview proxy」（決定論 export は原本のまま）で計測・実装中。詳細は `doc/mafter-effect-spec.md` §16.2b 追記 と実装 plan を参照。計測スクリプトは `probe-packed-drift.mjs`（リポジトリ直下・未コミット）。
> **非対象**: unified モード（Firefox 等 `alpha:keep` 対応環境・1本の VP9 alpha WebM）。単一 `<video>` + ブラウザネイティブ透過なので本 issue の機構は当てはまらない。

**関連 spec**: §16.2 / §11.4 / INV-2
**関連実装**: [encodeAlphaWebm.ts](../../src/editor/subjectExtract/encodeAlphaWebm.ts) / [videoSplitAlpha.ts](../../src/runtime/videoSplitAlpha.ts) / [videoElementSync.ts](../../src/runtime/videoElementSync.ts) / [playbackVideoSync.ts](../../src/runtime/playbackVideoSync.ts) / [DomRenderer.ts](../../src/runtime/DomRenderer.ts) / [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx)
**関連 issue**: [video-preview-playback-stutter-old-hardware.md](./video-preview-playback-stutter-old-hardware.md)（通常 video の再生スタッタ・本 issue の前提知識）

---

## 核心（一言でまとめると）— なぜ「アルファ描画があるだけ」でここまで壊れやすくなるのか

**ブラウザに「透過動画」という一級市民の仕組みが無いから**。それを埋め合わせるために、この機能だけが「1動画＝1クロック」という preview 再生パイプライン全体の前提を破っている。

1. **通常の動画レイヤー** = `<video>` 1本。GPU がそのまま合成し、他レイヤーと完全に独立したクロックとして安定して動く。
2. **透過をつけたい、という一点のせいで**、Chrome では VP9 `alpha:keep` が使えず、**color 動画＋グレースケール mask 動画の2本に分割**し、**毎フレーム CPU で手動合成**（`getImageData` → alpha 差し替え → `putImageData`）するしかなくなる。
3. しかも「2本の `<video>` が常に同じフレームを指している」ことを保証する仕組みはブラウザに無い。それぞれが勝手に decode を進める**独立クロック**であり、`updateComponentEl` が同じ目標時刻 `t` に向けて各々を独立に同期させているだけ（[真因「副因1」](#副因1-color-と-alpha-は独立デコードの2本のvideo--相互のフレーム対応を保証する仕組みがない)）。
4. さらに、元々「映像が遅れたらタイムライン全体を止めて音とのズレを防ぐ」という安全策（`holdTimeline`）が、この**見えない mask 動画の遅れも同列に拾ってしまう**ため（[主因](#主因-alpha-companion-のドリフトが再生タイムライン全体を holdpause-させる)）、本来 Subject Extract レイヤーの中だけで閉じるべき問題が **comp 全体（テキスト等）を巻き込む**ところまで漏れ出す。

つまり「アルファ描画」自体が本質的にバグりやすいのではなく、**他の全機能（テキスト・カメラ・通常動画）は「1動画＝1クロック・GPU合成のみ・CPU介入なし」という前提の上に素直に乗っているから壊れにくく、Subject Extract の split alpha だけがその前提を例外的に破って「2クロック＋CPU合成」をねじ込んでいるから壊れやすい**、という構図になっている。根治するにはこの「2クロック」という構造自体を消す必要があり、[修正4（color/alpha を1本の WebM にパック）](#修正4構造根治要ユーザー確認--coloralpha-を1本の-webm-にパックする)がそれに当たる（§16.2 資産フォーマットに触れるため要ユーザー確認）。

---

## 症状（ユーザー確認済み）

通常の Footage 動画スタッタ（上記関連 issue）は「**その動画レイヤーの映像だけ**ガクつき、他レイヤーはスムーズ」というスコープに閉じていた。Subject Extract の split alpha はこの前提を破り、**Subject Extract レイヤーが 1 枚あるだけで、そのコンポジット全体（他の通常レイヤー・他の動画レイヤーも含む）が再生中に一時停止／ガクつく**症状が起きる。**テキストレイヤーが webm と同時にフリーズ／もたつく**という報告はこの症状そのもの — Subject Extract 以外のレイヤーである text も巻き込まれて止まっている。これは色/透明度チャンネルの分離という実装上の理由により、通常の動画より不安定要因が構造的に多いため。

---

## 背景 — split alpha はなぜ 2 本の `<video>` になるのか

Chrome は VP9 `alpha:keep` エンコードに非対応（`vp09.00.10.08` で `No supported VideoEncoder config` になる）。そのため [encodeAlphaWebm.ts](../../src/editor/subjectExtract/encodeAlphaWebm.ts) は非対応環境で **color（straight RGB）＋ alpha（グレースケールマスクを R=G=B に複製した映像）** の 2 本の WebM を別々にエンコードする（`encodeRgbaFramesToSubjectWebm` の `mode: "split"`）。

再生時は [videoSplitAlpha.ts](../../src/runtime/videoSplitAlpha.ts) の `drawSplitAlphaComposite` が両方の `<video>` から `drawImage` → `getImageData` し、マスクの R チャンネルを color の alpha チャンネルへ CPU 合成して canvas に出す。**つまり「1 レイヤー」に見えるものの実体は独立デコードの `<video>` が 2 本 + 毎フレーム CPU ピクセル合成**である。

---

## 真因（コードレビューで特定した 3 系統）

### 主因: alpha companion のドリフトが再生タイムライン全体を hold/pause させる

[DomRenderer.ts](../../src/runtime/DomRenderer.ts) `sampleMountedVideoClocks()`（L755–780）は、通常の動画レイヤーだけでなく **split alpha の companion（マスク専用 `<video>`）もサンプルに含める**:

```ts
// §16.2 split alpha: color と alpha は独立デコード（ビットレート差が大きい）ので、
// alpha 側だけが遅れても hold/pause 判定に反映されるよう companion も併せてサンプルする。
const alpha = findSplitAlphaVideo(video);
if (alpha) pushSample(alpha);
```

このサンプル列は [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) `applyPlaybackSync()`（L600–611）→ [playbackVideoSync.ts](../../src/runtime/playbackVideoSync.ts) `computePlaybackSyncState()` に渡り、**コンポジット全体で共有される単一の `holdTimeline` / `pauseVideo` 状態**を決める（`maxVideoLagSec` / `maxVideoLeadSec` は全サンプルの中の最大値を採る）。

つまり:

1. マスク専用 `<video>`（ユーザーには見えない裏方ストリーム）が何らかの理由でタイムラインから 1 フレーム超遅れる（`holdThresholdsForFps` の `enterSec` 超）と、
2. `holdTimeline = true` になり、**タイムライン（rAF frame 進行）自体が止まる**（`runPreviewPlaybackLoop` / `runPreviewFrameClock` の `shouldHold`）。
3. これは Subject Extract レイヤーの表示だけでなく、**同じ comp 内の text / solid / カメラ / 他の動画レイヤーの進行も巻き込んで止める**。

この設計はコメントにある通り「alpha 側だけが遅れても検知できるように」という**意図的な安全策**だが、副作用として **本来レイヤー内部の問題（マスク映像のデコード遅延）がコンポジット全体の同期問題に昇格してしまう**。関連 issue（通常動画のスタッタ）で確立された「他レイヤーはタイムライン同期でスムーズ・動画だけ荒れる」という切り分けの前提が、Subject Extract レイヤーがある場合は成立しなくなる。

### テキストが一緒にフリーズする理由（確定）

「動画だけでなくテキストまでフリーズ／もたつく」は上記 `holdTimeline` の直接の帰結であり、**推測ではなく 3 つの再生ループ実装すべてで確認できる**。`holdTimeline` が真の間、いずれの経路も **`onFrameChange` を一切呼ばない** — つまり React 側の `frame` state が更新されず、`resolve(comp, frame)` も走らない。text も solid も 3D カメラも、**Subject Extract レイヤーと無関係な全オブジェクトの DOM 更新が完全に停止する**（「一部だけガクつく」ではなく「全部が完全に静止する」）。

| 再生モード | 実装 | hold 時の挙動 |
|-----------|------|---------------|
| **Draft**（rAF 直接 render） | [previewPlaybackLoop.ts](../../src/editor/previewPlaybackLoop.ts) `runPreviewPlaybackLoop` L39–42 | `shouldHold()` が true → `currentFrame` 据え置きで `requestAnimationFrame(tick)` に再スケジュールするだけ。`onFrameChange` も `renderFrame`（= 全レイヤー再描画）も**呼ばれない** |
| **Best**（frame clock + React effect） | [previewPlaybackLoop.ts](../../src/editor/previewPlaybackLoop.ts) `runPreviewFrameClock` L99–102 | 同上。`onFrameChange` が呼ばれないため React の `frame` state が変わらず、effect も発火しない |
| **音声あり（AudioClock マスタークロック）** | [previewAudioClock.ts](../../src/editor/previewAudioClock.ts) `tick()` L187–196 | `holdTimeline` 中は `frozenFrame` に固定し `applyAudioHold(true)`（音声も止める/フェード）+ `updateLiveGains` のみ実行して **`return`**。`onFrameChange` は呼ばれない |

3経路とも同じ形（`shouldHold()` / `syncState.holdTimeline` が真の間、frame 更新経路の入口で早期 `return`）になっており、**Subject Extract レイヤーを含む comp を再生している限り、どのモードでも同じ理由でテキスト等も一緒にフリーズする**。音声レイヤーがある comp では、hold 中に音声もフェード/停止するため「もたつき」は映像だけでなく音の途切れとしても体感される。

これは「動画のピクセルだけ荒れて他はスムーズ」という通常の動画スタッタ issue との**質的な違い**であり、**alpha companion のドリフト → holdTimeline → フレーム進行の完全停止 → comp 内の全レイヤーが同時にフリーズ**という一本の因果関係で説明できる。ユーザー体感の「テキストまで一緒にフリーズ/もたつく」は、この経路が実際に踏まれていることの強い状況証拠と言える。

### 副因1: color と alpha は独立デコードの2本の `<video>` — 相互のフレーム対応を保証する仕組みがない

[DomRenderer.ts](../../src/runtime/DomRenderer.ts) `updateComponentEl` の `"video"` ケース（L2079–2117）は、color と alpha companion に対して **それぞれ独立に** `syncVideoElementTime(video, t, fps, {...})` を呼ぶ。両者は同じ `targetSec (t)` を渡されるが:

- 各 `<video>` の実際の `currentTime` / decode 状態は完全に独立（ブラウザの decode パイプラインはエレメントごと）。
- 再生中は [videoElementSync.ts](../../src/runtime/videoElementSync.ts) の `PLAYBACK_RESYNC_THRESHOLD_SEC = 0.5`（≈15 frames @30fps）まで drift を許容し、**閾値以下では seek しない**（旧 HW の seek 連鎖対策A）。この判定は color / alpha それぞれの `currentTime` と `targetSec` の差で独立に行われる。
- 結果、**color が正確でも alpha が最大 0.5s 近く遅れて（あるいは逆に先行して）いても是正されない状態が起こりうる**。`drawSplitAlphaComposite` はその瞬間の両 `<video>` の描画内容をそのまま合成するため、**人物の輪郭（マスク）と実際の映像ピクセルの位置がずれる**（動きが速いシーンほど顕著）。

さらに、grayscale マスク映像は色映像より情報量が少なく圧縮効率が高い（コード側コメントにも「ビットレート差が大きい」旨の記載あり）。同一ビットレート・同一キーフレーム間隔（`keyFrame: i === 0 || i % 30 === 0` は両ストリーム共通）でエンコードしていても、**実デコード負荷・バッファリング挙動は color/alpha で異なりうる** — これが上記ドリフトの一因になっていると考えられる。

### 副因2: 毎フレーム CPU 合成のコスト + readyState 不足時のリトライ rAF

`drawSplitAlphaComposite` は再生中も **毎フレーム** 呼ばれ（DomRenderer L2130、`updateComponentEl` から）、full-resolution の `getImageData`（color）+ `getImageData`（mask）+ ループでの alpha 差し替え + `putImageData` を行う。これは通常の `<video>` 表示（GPU compositing のみ）よりも遥かに重い CPU 作業であり、非力な環境やフル HD 超の footage では**それ自体がフレーム落ちの要因**になりうる。

加えて、どちらかの `<video>` が一時的に `HAVE_CURRENT_DATA` 未満（例: 上記ドリフトによる seek 直後）だと `drawSplitAlphaComposite` は `false` を返し、[scheduleSplitAlphaRedrawWhenReady](../../src/runtime/videoSplitAlpha.ts#L165) が**別系統の再試行 rAF ループ**を起動する。メインの再生ループ（`runPreviewPlaybackLoop` 等）と並行して動くため、不安定な readyState が続くと **rAF コールバックが競合し** 体感の不規則さを増幅しうる。

### （preview 固有ではない）副次要因: マスク自体のフレーム間ちらつき

[personSegmenter.ts](../../src/editor/subjectExtract/personSegmenter.ts) は MediaPipe Selfie Segmentation を**フレームごとに独立実行**しており、時系列平滑化（前フレームのマスクを参照する等）は行っていない。これは alpha チャンネルの輪郭が動画そのものに焼き込まれた後のちらつき（shimmer）要因であり、**export した WebM 自体にも同じちらつきが乗る**ため preview 固有の問題ではない。ただし「Subject Extract の見た目が不安定」という体感の一部を占める可能性があるため、別軸の課題として記録しておく（本 issue の主眼＝再生同期の不安定さとは区別）。

---

## 実データ調査（2026-07-06）— Comp 32 で「webm だけがもたつく」構成を確認

> ユーザー報告: 「構成によっては webm だけがもたつくこともあるっぽい」。ダウンロードフォルダの最新 zip（`mafter-project (23).zip`、2026-07-06 09:39 更新）を展開し、`project.json` の **Comp 32**（id `01KWSRT0CQGZKJ0FNKEAD41F7M`）を直接調査した。結論: **「テキストも含め全レイヤーが凍結する」という主因の説明と矛盾しない** — Comp 32 は**たまたま他レイヤーの見た目がほぼ変化しない構成**になっており、同じ `holdTimeline` 凍結が起きても **webm 以外は凍結が目に見えない**。「webm だけ」に見えるのは知覚上の非対称性であり、コードパスが別に存在するわけではない。

### Comp 32 の構成（objects 8個）

| zOrder | オブジェクト | 種別 | in–out (frame) | 備考 |
|--------|--------------|------|-----------------|------|
| 1 | `01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4` | video（生 footage） | 0–150 | 背景プレート。Person 抽出と**同一ソースクリップ**（7.77s）を丸ごと表示 |
| 2 | Text | text | 0–150 | 位置 **0 keyframe**（静止値のみ） |
| 3 | Text | text | 45–150 | 位置 2 keyframe（45→194、範囲の一部だけ可視） |
| 4 | Text | text | 88–150 | 位置 2 keyframe（88→237） |
| 5 | Text | text | 131–150 | 位置 2 keyframe（131→280） |
| 6 | `01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4 — Person` | video（**Subject Extract split alpha**） | 0–150 | asset `01KWSS67VPRA5KE4HWC42D5AKG`。`meta.alphaMode:"split"` + `alphaPath` 確認済み |
| 7 | Text | text | 0–150 | 位置 **0 keyframe**（静止値のみ） |
| 8 | Camera 1 | camera | 0–150 | **position/rotation とも 150 keyframe（毎フレーム）** |

### 他レイヤーの「動き」の実測値

`project.json` を直接パースして各レイヤーのキーフレームを数値で確認した結果:

- **静止テキスト 2枚**（zOrder 2, 7）: transform 全プロパティが **keyframe 0 個**（単一の固定値）。全 150 フレームで一切動かない。
- **スクロールテキスト 3枚**（zOrder 3–5）: position が `x: 1270.35 → 438.35`（線形イージング）の2キーフレームのみ。**1フレームあたり ≈ 5.6px** の緩やかな横スクロール（クレジット風テロップ）。
- **カメラ**（zOrder 8）: 毎フレーム keyframe があるが、実測した frame 1–9 の差分は
  - `position`: `dx = dy = dz = 0.000`（**全フレームで完全に静止**）
  - `rotation`: `dx ≈ -0.03〜-0.09°`, `dy ≈ +0.05〜+0.17°`, `dz ≈ -0.06〜+0.01°`（**1フレームあたり1度未満の微振動** — モーショントラック由来の手持ちシェイク相当）

つまり Comp 32 で「今まさに動いて見えるもの」は実質 **Subject Extract の映像（Person レイヤー）だけ**であり、他の全レイヤー（テキスト・カメラ）は**静止か、1フレームでは知覚できない量しか動かない**。この状態で `holdTimeline` によりフレーム進行が数フレーム〜最大1秒（`maxHoldSec`）止まっても:

- 静止テキストは元々動かないので、止まっても**見た目の変化がゼロ**（気づけない）。
- スクロールテキストは 1フレームで ≈5.6px しか動かないため、数フレーム分の凍結は**肉眼でほぼ判別不能**（保持が `maxHoldSec=1s`＝30フレーム近くまで伸びた場合のみ、約165px 相当のジャンプとして気づかれうる）。
- カメラの手ぶれは1度未満/フレームのため、凍結してもほぼ気づかれない。
- 一方 **Person レイヤーは動画のピクセル内容そのもの**（人物が動く実写映像）。凍結すればコマ落ちとして即座に視認でき、かつ独立デコードの2本 `<video>` 由来のドリフト・輪郭ズレ（副因1）・毎フレーム CPU 合成の重さ（副因2）も本質的にこのレイヤーだけに乗る。

**結論**: 「構成によっては webm だけがもたつく」というユーザー観察は、**先の「テキストも凍結する」という真因分析と矛盾しない**。`holdTimeline` は今回も comp 全体（テキスト・カメラ含む）のフレーム進行を止めているはずだが、Comp 32 のように**他レイヤーがほぼ無変化な構成**では、その凍結が視覚的に webm 以外では気づかれない。逆に、テキストや3Dカメラが大きく・速く動く構成（本 issue の前段でユーザーが「テキストも一緒にフリーズする」と報告したケース）では、同じ凍結がテキスト側でもはっきり視認される。**「何が凍結するか」はコードの分岐ではなく、その瞬間に画面上で変化している量（perceptual salience）の違いで決まる**。

### 追加で判明した副次的な悪化要因: 同一ソースクリップの三重デコード

Comp 32 は **同じ 7.77 秒の元クリップ（`01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4`）** を:

1. zOrder 1 の背景プレートとして**生 mp4 のまま**表示
2. zOrder 6 の Person レイヤーとして**Subject Extract 後の color webm**（`01KWSS67VPRA5KE4HWC42D5AKG.webm`）
3. 同 Person レイヤーの **alpha companion**（`...alpha.webm`）

の **3系統・3本の独立 `<video>` デコードパイプライン**として同時再生している（同じ画を実質2重に持っている構成 — 背景プレート＋人物切り抜きを別々に重ねる合成のため、これ自体は意図的な構図と思われる）。後述「[修正4](#修正4構造根治要ユーザー確認--coloralpha-を1本の-webm-にパックする)」で触れる decode セッション競合は、この Comp では**推測ではなく実際に3本同時デコードが起きている**ことが構成から確認できる。GPU の同時 HW デコードセッション数上限に達しやすい構成であり、**Person レイヤー（2本）が他より不安定になりやすい実例**として Comp 32 は良いテストケースになる。

---

## なぜ「毎回ではなく時々」なのか — 再生開始前の warm-up が勝つか負けるかのレース（2026-07-06 追記）

> ユーザー報告: 「Comp 32 の再生がズレなくスムーズにいくこともある。映像のロードのされ方が関係あるか？」— **関係がある**。preview には Play ボタンを押す**前**に動画を先読みしておく warm-up 機構があり、この先読みが Play を押すまでに間に合うかどうかで体感が大きく変わる。3本同時デコードの Person レイヤーはこの「間に合うかどうか」の影響を人一倍受けやすい。

### 関与する2つの warm-up 経路

| 経路 | 発火条件 | 実装 | 予算 |
|------|----------|------|------|
| **① idle warm-up** | **再生していない間**、frame が変わるたび（scrub 含む）に再スケジュール | [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) L717–742 の `useEffect` → `renderer.primeMountedVideos(fps)` | `requestIdleCallback`（無ければ 200ms 後の `setTimeout`）で起動。各 `<video>` あたり [primeVideoElement](../../src/runtime/videoElementSync.ts#L120) の既定 `DEFAULT_PRIME_TIMEOUT_MS = 800ms` |
| **② Play barrier** | **Play ボタンを押した瞬間** | [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) L674–691 `startPlaybackSynced` → `renderer.syncMountedVideosForPlay(fps, PLAY_GATE_TIMEOUT_MS)` | `PLAY_GATE_TIMEOUT_MS = 500ms`（L54）。**まだ primed でない動画だけ**をこの予算内で追い prime。予算超過・失敗しても** best-effort で握りつぶして再生を開始**（`.catch(() => false)` は戻り値すら見ない） |

`DomRenderer.syncMountedVideosForPlay`（L731–749）は、動画ごとに `isVideoReadyAtTarget(video, targetSec, fps)` が **true**（= 直近の① idle warm-up で既に現フレームまで seek/decode 済み）ならその動画は**追い prime せず即スキップ**する。つまり ② の 500ms 予算は「① が間に合わなかった分」にだけ使われる。

### 「スムーズなとき」と「ガクつくとき」の違い

| ケース | 何が起きているか | 結果 |
|--------|------------------|------|
| **スムーズ** | Play を押す**前**に十分な時間（アイドル状態が続く/scrub 後しばらく操作しない）があり、① idle warm-up が Person の color・alpha companion を含む**全 `<video>` を現フレームまで seek/decode 済み**にできている | ② の barrier は何もせず即完了 → `previewVideoPlayback:true` になった瞬間から**3本とも既に正しいフレームを指した状態**で再生開始 → 序盤から drift が出ず `holdTimeline` も踏まない |
| **ガクつく** | scrub 直後にすぐ Play を押す等で ① が**間に合っていない**（`requestIdleCallback` は「本当に暇なとき」しか呼ばれず、3本同時デコードのぶん決定的に遅れやすい）。② の 500ms 予算内に color/alpha/背景の**全部**を揃えられないと、揃わなかった分は**未 warm のまま再生が始まる**（`.catch(() => false)` で結果を見ずに進む設計のため） | 再生開始直後の数フレームで色/マスクの少なくとも一方が本来位置より遅れた状態からスタート → 早い段階で `sampleMountedVideoClocks` の乖離が閾値を超え `holdTimeline`/`pauseVideo` が発火 → 「テキストも巻き込む凍結」または「Person だけガクつく」が**再生開始直後に集中して**起きる |

### 「映像のロードのされ方」が具体的に何に効くか

1. **初回 decode か、既に一度 decode 済みか** — `imageAssetCache` は asset ごとに blob URL を一度作ればアプリセッション中使い回すが、**decode 済みフレームのキャッシュ**（ブラウザの media cache／実際に seek 済みの `currentTime` 位置）は `<video>` 要素ごとの状態であり、warm-up が済んでいるかどうかで決まる。プロジェクトを読み込んで**初めて** Comp 32 を Play するときは3本とも完全にコールドスタート（① が発火・完了する前に押されがち）になりやすく、**2回目以降の Play（同じフレーム位置から）は ① が前回の warm-up 結果を保持している**ため速い。
2. **scrub の直後か、少し待ってからか** — idle warm-up の `useEffect` は `frame` が変わるたびキャンセル＋再スケジュールされる（L720 依存配列に `frame` を含む）。**スクロールバーを動かした直後にすぐ Play を押すと、① が発火する前にキャンセルされ続けて一度も完了していない**可能性が高い。スクラブ後 200ms〜1秒程度static に止めてから Play を押すと ① が完了しやすい。
3. **3本同時デコードという Comp 32 特有の負荷** — 通常の動画1本なら 500ms の play barrier 予算内で十分間に合うことが多いが、Comp 32 は **背景 mp4 + Person color + Person alpha の3本を同時に prime** する必要がある（`primeMountedVideos` は全 `<video>` を一括で prime、L683–709）。3本纏めて 500ms 以内に decode/seek を終えられるかは、その瞬間の CPU/GPU decode 資源の空き状況次第 — **他のタブ・他の comp のバックグラウンド処理・RAM preview のバックグラウンド bake（再生中は停止するが、Play を押す直前＝まだ再生していない間は動いている）と資源を取り合う**ため、毎回同じ結果になるとは限らない。
4. **GPU の同時 HW デコードセッション数** — 前節で触れた通り環境依存の上限があり、3本要求すると一部が SW decode にフォールバックしうる。フォールバックが起きるかどうか自体が実行タイミング依存で非決定的。

### まとめ

**「映像のロードのされ方」はまさに関係がある** — 具体的には **Play を押す前の idle warm-up（①）が Person レイヤーの3本（背景・color・alpha）すべてを現フレームまで decode し終えているかどうか**が、その回の再生が滑らかに始まるか、序盤からガクつく／comp 全体を巻き込む凍結になるかを分ける。これは実装のどこかにバグがあるというより、**「Play を押した瞬間に必ず全部揃っている」ことを保証する仕組みが無く、500ms の best-effort 予算で間に合わなければそのまま見切り発車する**設計になっているため。[修正1](#修正1必須最小リスク--companion-サンプルをグローバル-holdpause-判定から切り離す)（companion をグローバル hold から外す）が入れば「巻き込み凍結」は消えるが、**この warm-up レース自体は残る**ため、Person レイヤー単体の「再生開始直後だけガクつく／揃うまで数フレームかかる」という体感は warm-up の勝敗に応じて残り続ける可能性が高い。恒久的に安定させるには、[修正4](#修正4構造根治要ユーザー確認--coloralpha-を1本の-webm-にパックする)で3本→2本（将来的には背景との共有まで踏み込めば理論上さらに減らせる）に減らし、warm-up 対象そのものを減らすのが最も効く。

**（下記「実機 Playwright 検証」の結果、上記仮説は一部修正が必要と判明 — ③ warm-up レースは初速にしか効かず、実測された「holdTimeline がサンプル時間の9割を占める」規模の停滞は説明しきれない。詳細は次節。）**

---

## 実機 Playwright 検証（2026-07-06 追記・他セッションからのフィードバック反映）

> 他セッションからの指摘 4点（① holdTimeline の実発火確認、② companion ドリフト実測、③ warm-up レースの再現性、④ decode セッション HW/SW 確認）を実機 Playwright + 実 Chrome の CDP（Chrome DevTools Protocol）で検証した。DevTools Performance パネルの手動録画ではなく、`window.__mafterEditorStore`（既存の verify script 群と同じ export）を直接操作し、`currentFrame` / `<video>` の `currentTime`・`readyState` を rAF ごとにポーリング、加えて CDP `Media` ドメインで decoder 種別を取得する方式にした（手動操作より再現性・数値化に優れる）。

### 手法

- **プロジェクト**: `mafter-project (23).zip`（204MB）は Playwright の `page.evaluate` 引数に丸ごと渡すと V8 heap が溢れて Node プロセスがクラッシュした（`[...buffer]` で 2億要素の配列を作ってしまうため）。そこで **Comp 32 と関連 3 アセットだけを抜き出した最小プロジェクト zip（約 28.9MB）** を作成し（`scratchpad-build-mini-comp32-zip.mjs`）、`page.route()` で仮想 URL に直結してページ内 `fetch()` させる方式に変更（IPC 経由の巨大配列転送を回避）。
- **スクリプト**: [verify-comp32-webm-instability.mjs](../../verify-comp32-webm-instability.mjs)（リポジトリに追加済み）。`chromium.launch({ headless: true })`（**headed 実 Chrome は本検証環境では起動直後にクラッシュしたため headless に切替** — 下記「制約」を参照）。
- **計測方法**: `requestAnimationFrame` ループで `store.getState().currentFrame` / `isPlaying` と、背景 video・Person color video・Person alpha companion video それぞれの `currentTime`/`readyState`/`paused`/`seeking` を 1 tick ごとに記録。
  - **holdTimeline 検出**: `isPlaying===true` の間、`currentFrame` が同じ値のまま 1.5 フレーム分（@30fps ≈ 50ms）を超えて変化しない区間を「stall」として検出（`holdTimeline` 変数自体には触れず、**観測可能な効果＝フレーム進行の停止**で判定）。
  - **ドリフト**: color/alpha 双方が再生中（`!paused`）のサンプルで `color.currentTime - alpha.currentTime` を記録。
  - **decode 種別**: `page.context().newCDPSession(page)` → `Media.enable` → `Media.playerPropertiesChanged` を購読し、`kVideoDecoderName` / `kIsPlatformVideoDecoder` を収集。
- **シナリオ**: **A =「1800ms 待ってから Play」**（idle warm-up が完了する猶予を与える）／**B =「scrub 直後に即 Play」**（frame を3連続で変更した直後、間を置かず Play）。各3回試行、1回あたり3秒間サンプリング。

### 結果（3試行平均、`verify-comp32-webm-instability-result.json` に生ログあり）

| 指標 | シナリオ A（待ってから Play） | シナリオ B（即 Play） |
|------|-------------------------------|------------------------|
| Play 時点で3本とも `readyState>=HAVE_CURRENT_DATA` | **3/3 回とも true**（100%） | **3/3 回とも false**（0%） |
| 3秒間のうち stall（凍結）した回数 | 平均 **4.0 回** | 平均 **4.67 回** |
| 3秒間のうち stall していた**合計時間** | 平均 **2787ms**（サンプル時間の**約93%**） | 平均 **2805ms**（**約93%**） |
| color/alpha ドリフト 最大 | 平均 81.3ms（試行毎 146.9 / 91.7 / 5.2ms） | 平均 116.9ms（試行毎 125.7 / 114.5 / 110.6ms） |
| color/alpha ドリフト 平均 | 33.0ms | 50.5ms |

個々の stall は概ね **500〜600ms** と **1000〜1040ms**（`holdThresholdsForFps` の `maxHoldSec=1.0` フェイルセーフとほぼ一致）の2山に分布しており、`holdTimeline` が発火 → 約1秒のフェイルセーフ上限まで持続 → 強制解除 → 短時間再生 → 再び発火、を**3秒間に3〜4回繰り返す**パターンが3試行・両シナリオで再現した。

### 分かったこと（4点）

1. **① holdTimeline の実発火** — **確認できた。しかも「たまに」ではなく、この検証環境では再生時間の9割以上が stall という支配的な現象だった。** コードレビューだけの推論ではなく実測で裏が取れた。
2. **② companion ドリフト実測** — 33〜117ms の範囲（試行によりばらつき大、最大147ms）。`PLAYBACK_RESYNC_THRESHOLD_SEC=0.5s`（500ms）の**閾値には遠く届いていない**ため、per-element の hard-seek 補正は一度も発火していないはずで、副因1の「独立ドリフトが無補正で蓄積する」仮説と整合する。[修正2](#修正2推奨画質改善--color-と-alpha-のフレーム対応を保証する)の `RATE_GAIN`/`MAX_RATE_ADJUST` 設計に使うなら、**「0.03〜0.15s 帯で穏やかに補正できればよい」**という実測レンジが得られた（既存案の `RATE_CORRECTION_BAND_SEC=[0.05, 0.5]` は概ね妥当だが下限をもう少し下げても良さそう）。
3. **③ warm-up レースの再現性** — **部分的に反証された。** 「Play 時点で3本とも ready か」はシナリオ A/B で **100% vs 0%** ときれいに分離できた（warm-up 自体は狙い通り機能しており、意図した通りの対照実験になっている）にもかかわらず、**stall 回数・stall 合計時間はシナリオ A/B でほぼ同じ**（stall合計時間で見ると 2787ms vs 2805ms、差は誤差の範囲）。つまり **「Play 時点で揃っているかどうか」は、再生開始直後はともかく、その後3秒間に渡って支配的な stall の量にはほとんど影響しない**。ここまでの doc は「warm-up レースが①②の発生頻度を左右する主要因」という書き方をしていたが、**少なくともこの検証環境では、それより持続的な別要因（4番）の影響の方が遥かに大きい**ことが分かった。warm-up レース自体（idle warm-up の debounce・500msの play barrier 予算）は依然として実在するメカニズムだが、**「毎回ではなく時々」の主犯としての比重は本 doc の従来の記述より小さく見積もるべき**。
4. **④ decode セッション HW/SW** — **Person レイヤーの color・alpha companion は両方とも `VpxVideoDecoder`（`kIsPlatformVideoDecoder: false` = ソフトウェアデコード）だった。** GPU ハードウェアデコードは使われていない。VP9 の2本同時ソフトウェアデコードが実時間 30fps 再生に追従できず、`holdTimeline` が繰り返し発火して**サンプル時間の9割が停滞**という規模の不安定さに直結している、というのが最も筋の通る説明になる。

### 制約・注意（過大評価しないために重要）

- **本検証は `headless: true` で実施した。** headed（`channel: "chrome"` の実 Chrome）で起動を試みたが本検証環境（サンドボックス化された自動化セッション、実ディスプレイなし）では起動直後にクラッシュしたため、やむを得ず headless にフォールバックした。**headless Chromium は既知の制約として GPU 動画デコードアクセラレーションを既定で無効化する**ため、上記「両方ソフトウェアデコード」という結果は**headless 固有の可能性がある**。ユーザーの実 Chrome（GPU 有効）では少なくとも一部の状況で **VP9 の HW デコードが使われる可能性があり、その場合は本検証ほど深刻な stall が起きない**、あるいは「HW デコードが取れた回はスムーズ・取れなかった回は本検証相当に荒れる」という**環境依存の分岐**が「ときどきスムーズ」の実態に近いと考えられる。
- 上記を踏まえると、**「warm-up レースが主要因」という当初の仮説は誤りというより、条件が違う（HW decode が使える環境ではそもそも支配的 stall が起きにくいので warm-up の勝敗が体感差として残る／HW decode が使えない環境では warm-up に関わらず支配的 stall が起きる）** という**条件分岐的な理解**に更新するのが正確。修正の優先順位としては、**[修正4](#修正4構造根治要ユーザー確認--coloralpha-を1本の-webm-にパックする)（2ストリーム→1ストリーム化で SW decode 負荷を半減させる）の価値が、この実測により当初より高いと判断すべき**。
- 副次的に、コンソールに `AbortError: The play() request was interrupted by a call to pause()` が記録された。これは `holdTimeline`/`pauseVideo` による頻繁な `play()`/`pause()` の切り替わりが実際に発生していることの追加証拠（`void video.play()` で例外は握りつぶされアプリはクラッシュしないが、コンソールノイズとしては実在する）。
- 3試行×2シナリオという少ない試行数での結果であり、統計的に厳密ではない（分散はそこそこ大きい: ドリフト最大値が試行間で 5.2ms〜147ms とばらつく）。傾向は明確だが、`RATE_GAIN` 等の定数を最終決定する前には試行数を増やすか、実 Chrome（headed）での追試を推奨。

### 再現方法

```bash
# 1. 最小 Comp 32 プロジェクト zip を作る（初回のみ）
node scratchpad-build-mini-comp32-zip.mjs

# 2. dev server を起動済みの状態で（npm run dev, port 5173 既定）
node verify-comp32-webm-instability.mjs
# 環境変数: VERIFY_HEADLESS=0 で headed 実 Chrome を試す（要ディスプレイ）
#           VERIFY_TRIALS=5 で試行回数を増やす
```

---

## 図解

```
timeline (rAF / AudioClock)
   │
   ├─ resolve(frame) → 他レイヤー transform 更新（滑らか・独立）
   │
   ├─ sampleMountedVideoClocks()
   │     ├─ color video sample
   │     └─ alpha companion sample  ← ここが独立デコードでドリフトしうる
   │
   ├─ computePlaybackSyncState(全サンプルの max lag/lead)
   │     └─ holdTimeline / pauseVideo（comp 全体で共有・1つだけ）
   │
   └─ holdTimeline=true → 3経路（Draft rAF / Best frame clock / AudioClock）とも
         onFrameChange を呼ばずに return
         → resolve(frame) が走らない → comp 内の全レイヤー（text 含む）の
           DOM 更新が完全停止 → Subject Extract と無関係なテキストも一緒にフリーズ
```

---

## 解決策（深掘り設計）

### 問題の分解 — 実は独立した3つの不具合

ここまでの調査（コードレビュー + Comp 32 実データ）を踏まえると、「Subject Extract の webm が preview で不安定」は **原因の異なる3つの不具合が重なって見えている**:

| # | 不具合 | スコープ | トリガー | 直す場所 |
|---|--------|----------|----------|----------|
| **① グローバル凍結** | comp 全体（text/camera 含む）が一瞬止まる | `holdTimeline` が真の間だけ | alpha companion のドリフトが `sampleMountedVideoClocks` 経由で**全体**の hold/pause 判定に混入する | `DomRenderer.sampleMountedVideoClocks` / `playbackVideoSync.ts` |
| **② レイヤーローカルな不安定さ** | Person レイヤー自体（映像＋輪郭）だけが荒れる | 常時（hold が発火してもしなくても） | 2本独立デコードの drift・輪郭ズレ・毎フレーム CPU 合成・（Comp 32 のように）3本同時デコードによる decode セッション競合 | `videoSplitAlpha.ts` / `videoElementSync.ts` / `encodeAlphaWebm.ts` |
| **③ warm-up レースによる非決定性** | ①②が**毎回起きるか、その回は起きないか**を左右する | **Play を押した瞬間**。idle warm-up が間に合ったかどうかで結果が変わる | idle warm-up（`requestIdleCallback`/200ms、frame 変化で毎回キャンセル→再スケジュール）が Play までに完了する保証が無く、Play barrier も `PLAY_GATE_TIMEOUT_MS=500ms` の best-effort で結果を見ずに見切り発車する | `PreviewPanel.tsx`（idle warm-up effect・`startPlaybackSynced`）/ `videoWarmupCache.ts` |

①は「webm と一緒にテキストも止まる」を、②は「（① が視認されない構成では）webm だけがもたついて見える」を、③は「**同じ Comp・同じ操作でも、再生するたびに滑らかだったりガクついたりする**」（詳細は「[なぜ「毎回ではなく時々」なのか](#なぜ毎回ではなく時々なのか--再生開始前の-warm-up-が勝つか負けるかのレース2026-07-06-追記)」）を、それぞれ単独で説明できる。**この3つは独立した原因なので、修正も個別に必要**（① だけ直しても Person レイヤー自体の画質・滑らかさの問題は残るし、② だけ直しても他レイヤーを巻き込む凍結は残るし、③ だけ直しても①②そのものは消えず「毎回同じ程度に起きる」ようになるだけ）。以下、優先度順に深掘りする。

---

### 修正0（低リスク・最速で試せる）— warm-up タイミングの調整

**対象**: 不具合③（非決定性そのもの。①②の発生確率を下げるだけで、①②自体は消さない）。

2つの定数・タイミングを調整するだけの実験で、コード構造には触れない:

| 対策 | 内容 | トレードオフ |
|------|------|--------------|
| **idle warm-up の debounce を短縮/確実化** | `PreviewPanel.tsx` L717–742 の `requestIdleCallback` フォールバック（200ms `setTimeout`）をもっと短くする、または `requestIdleCallback` の代わりに固定の短い debounce（例: scrub 停止から 100〜150ms）で確実に発火させる | スクラブ中に無駄な decode/seek が増える可能性（連打的な frame 変化のたびに prime が走ると CPU 消費が増える）。既存の「idle 時だけ」という節度を失う |
| **`PLAY_GATE_TIMEOUT_MS` を伸ばす** | [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) L54 の `500` を大きくし（例: 1000〜1500ms）、Comp 32 のような3本同時 prime でも間に合う猶予を増やす | Play ボタンを押してから実際に再生が始まるまでの体感レイテンシが増える（非力な HW ほど顕著）。「揃うまで待つ」設計に変えるなら、待っている間のローディング表示も検討要 |
| **`syncMountedVideosForPlay` の結果を無視しない** | 現状 `.catch(() => false)` で成否を握りつぶしているが、失敗した動画があれば**再生開始直後の1〜2フレームだけ** `previewVideoPlayback` を遅延させる等、best-effort の質を上げる | 実装がわずかに複雑になる。過度にやると①②同様の「待たせすぎ」になる |

**位置づけ**: これは①②の**根本原因を消す修正ではない**。「warm-up のレースに勝つ確率を上げる／負けたときの被害を減らす」対策であり、**低コストで体感の再現頻度を下げられる**が、**負けたときの①②自体は依然として起こりうる**。修正1・2と独立に、まず試す価値のある安価な実験として位置づける。

**テスト**: 実機で「scrub 直後に即 Play」を意図的に繰り返し、調整前後で①②の発生頻度が下がるかを目視比較（決定論的な unit test は組みにくく、実機観測が主）。

---

### 修正1（必須・最小リスク）— companion サンプルをグローバル hold/pause 判定から切り離す ✅ 実装済み（2026-07-06）

**対象**: 不具合①。

現状 `sampleMountedVideoClocks()`（[DomRenderer.ts](../../src/runtime/DomRenderer.ts) L755–780）は color と alpha companion を区別せず同じ配列に積む。これを **役割タグ付き**にして、`computePlaybackSyncState` に渡すのは「表示に直接使われる主ストリーム」のサンプルだけにする。

```ts
// playbackVideoSync.ts — サンプルに role を持たせる
export interface VideoClockSample {
  targetSec: number;
  currentTimeSec: number;
  paused: boolean;
  ended: boolean;
  error: boolean;
  duration: number;
  /** 追加: "primary" = 表示に直結（色/通常video）。"companion" = 裏方（split alpha mask 等）。 */
  role: "primary" | "companion";
}

// 呼び出し側（PreviewPanel.tsx / previewAudioClock.ts）
const samples = renderer.sampleMountedVideoClocks();
const primarySamples = samples.filter((s) => s.role === "primary");
syncState = computePlaybackSyncState(syncState, primarySamples, thresholds, now);
```

`sampleMountedVideoClocks` 側は現状どおり両方サンプルするが、`role` を付けるだけで済む（DomRenderer L772–778 の `pushSample` 呼び出しに `"primary"` / `"companion"` を渡す）。

**なぜ「除外しても安全」と言えるか**: companion（alpha 側）は `updateComponentEl` の `"video"` ケース（L2079–2117）で **依然として毎フレーム `syncVideoElementTime(companion.alphaVideo, t, fps, {...})` が呼ばれ続ける**。つまりレイヤー内部の per-element resync（±0.5s 閾値）は今までどおり効いており、「グローバル判定から外す＝一切補正されなくなる」わけではない。外れるのは**あくまで「comp 全体を止めてまで companion を待つ」という過剰な安全策**だけ。readyState 不足時は既存の `drawSplitAlphaComposite` 失敗 → `scheduleSplitAlphaRedrawWhenReady` のリトライで拾われる。

**忘れやすいエッジケース**:

- `pauseVideo`（映像先行時に pause する側）も `computePlaybackSyncState` の**同じサンプル集合**から算出され、`renderer.setPlaybackPauseForSync(bool)` は **comp 内の全 `<video>` に無差別適用**される（DomRenderer L2001 `pauseForSync` 引数、L2083/L2116 で color・companion 両方に渡る）。**`holdTimeline` だけでなく `pauseVideo` も companion を除外対象にしないと、companion の先行だけで無関係な他の動画レイヤーが pause してしまう**別バグが残る。修正は同じ `primarySamples` を両方の算出に使えば良い。
- 複数 Subject Extract レイヤーが同一 comp にある場合、companion は**そのレイヤー数だけ**存在する。`role` フィルタは配列全体に対する単純な `filter` なので複数枚でも自然に効く。
- ネスト comp 内の Subject Extract は `forEachVideoElement` が `root.querySelectorAll("video")` で**ネストも含めて**列挙するため、`findSplitAlphaVideo` による companion 判定も同様に効く（追加対応不要）。

**テスト**: `computePlaybackSyncState` に「companion 込み配列」と「`role==="primary"` だけの配列」を渡し、companion だけが遅れているケースで前者は hold、後者は hold しないことを固定する unit test。

---

### 修正2（推奨・画質改善）— color と alpha のフレーム対応を保証する ✅ 実装済み（2026-07-06、B2 方式）

**対象**: 不具合②（輪郭ズレ）。修正1と独立に効く。

現状、color と companion は**同じ理想上のタイムライン目標 `t`** にそれぞれ独立に追従しているだけで、**互いの実際のデコード位置は見ていない**。これを直すには2案ある。

#### B1: ハードシーク方式（シンプルだが seek 連鎖のリスクを引き継ぐ）

毎フレーム `Math.abs(alphaVideo.currentTime - colorVideo.currentTime) > threshold` なら `alphaVideo.currentTime = colorVideo.currentTime` で強制的に合わせる。実装は数行で済むが、**「まさに直そうとしている seek 起因のガクつき」を companion 側に再導入するリスク**がある（`PLAYBACK_RESYNC_THRESHOLD_SEC` を大きく取った設計思想と矛盾する）。

#### B2: 再生速度による soft genlock（推奨）

WebRTC / メディアプレイヤーで一般的な「クロックスキュー補正」と同じ考え方 — **seek ではなく `playbackRate` の微調整**で追従させる。ドリフトが小さいうちは `playbackRate` を 1.0 から数% ずらして自然に追いつかせ、seek による瞬間的なコマ飛びを起こさない。閾値を超える大ドリフトのときだけ B1 のハードシークにフォールバックする。

```ts
// videoSplitAlpha.ts に追加するイメージ（純関数化してテスト可能にする）
const RATE_CORRECTION_BAND_SEC = [0.05, PLAYBACK_RESYNC_THRESHOLD_SEC] as const; // 0.05〜0.5s
const MAX_RATE_ADJUST = 0.08; // ±8%
const RATE_GAIN = 0.3; // ドリフト→レート変換の比例ゲイン

export function computeAlphaGenlockRate(driftSec: number): number {
  const abs = Math.abs(driftSec);
  if (abs < RATE_CORRECTION_BAND_SEC[0]) return 1; // 誤差レベルは補正しない（レート creep 防止）
  if (abs > RATE_CORRECTION_BAND_SEC[1]) return 1; // 大ドリフトは呼び出し側でハードシークに任せる
  // alpha が color より遅れている(drift>0: alpha.currentTime < color.currentTime)→ alpha を速める
  const adjust = Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, driftSec * RATE_GAIN));
  return 1 + adjust;
}

// 呼び出し側（毎フレーム、drawSplitAlphaComposite 直前）
const drift = colorVideo.currentTime - alphaVideo.currentTime;
if (Math.abs(drift) > PLAYBACK_RESYNC_THRESHOLD_SEC) {
  alphaVideo.currentTime = colorVideo.currentTime; // 大ドリフトのみハードシーク（B1 フォールバック）
  alphaVideo.playbackRate = 1;
} else {
  alphaVideo.playbackRate = computeAlphaGenlockRate(drift);
}
```

**なぜ B2 が優れているか**: ハードシークは「decode 再開の待ち時間」というコストを伴う（旧 HW ほど重い — 通常動画スタッタ issue の主因と同じ機構）。playbackRate の微調整は decode パイプラインを止めずに連続再生のまま徐々に収束させるため、**旧 HW での追加コマ落ちを生まない**。

**エッジケース**:

- ループ境界・カット境界（`forceSeek`/`cutSeek` が立つ瞬間）は color/alpha とも通常の決定論 seek パスに乗るため、genlock はその他の**定常再生中のみ**作動させる（`playbackMode && !forceSeek` の間だけ）。
- `pauseForSync` で pause 中は genlock を止め（`playbackRate` を 1 に戻す）、pause 解除時に改めて drift を測る。
- scrub・export（`exportStep`）経路は現状どおり両者を決定論 seek + `waitForVideoFrame` で揃えるため**無関係・無変更**（INV-2 非干渉）。

**テスト**: `computeAlphaGenlockRate` は純関数なので、境界値（0.04s→補正なし、0.2s→穏やかな加速、0.6s→呼び出し側でハードシーク分岐）を素の unit test で固定できる。

---

### 修正3（低リスク・体感の底上げ）— 合成コスト削減 + 冗長描画スキップ

**対象**: 不具合②（CPU 負荷起因のフレーム落ち）。

```ts
// drawSplitAlphaComposite 改修イメージ: ImageData を毎フレーム new しない
const scratchByCanvas = new WeakMap<HTMLCanvasElement, { color: ImageData; mask: ImageData }>();

export function drawSplitAlphaComposite(colorVideo, alphaVideo, canvas, maskScratch): boolean {
  // ...readyState チェックは現状どおり...
  let bufs = scratchByCanvas.get(canvas);
  if (!bufs || bufs.color.width !== w || bufs.color.height !== h) {
    bufs = { color: ctx.createImageData(w, h), mask: maskCtx.createImageData(w, h) };
    scratchByCanvas.set(canvas, bufs);
  }
  // getImageData の代わりに再利用バッファへ描く（putImageData 前の GC 圧を削減）
  ...
}

// 冗長描画のスキップ（呼び出し側 DomRenderer.ts L2130 相当）
const lastDrawnKey = `${colorVideo.currentTime.toFixed(4)}|${alphaVideo.currentTime.toFixed(4)}`;
if (canvas.dataset.lastDrawnKey !== lastDrawnKey) {
  const drew = drawSplitAlphaComposite(...);
  if (drew) canvas.dataset.lastDrawnKey = lastDrawnKey;
}
```

大きな設計変更を伴わず、CPU 負荷を落として修正1・2の効果を底上げする。単独では不具合を解消しないため優先度は低いが、リスクも低い。

---

### 修正4（構造根治・要ユーザー確認）— color/alpha を1本の WebM にパックする

**対象**: 不具合②を**原理的に**無くす（2本デコードという構造そのものを消す）。

#### 設計

エンコード時に color（RGB）と alpha（グレースケール）を**上下に連結した1枚のフレーム**（例: `W × 2H`）として単一 VP9 ストリームにする。

```ts
// encodeAlphaWebm.ts 概念コード
function packColorAlphaFrame(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const packed = new Uint8ClampedArray(w * (h * 2) * 4);
  // 上半分: color（straight RGB, alpha=255）
  packed.set(toOpaqueRgbColor(rgba), 0);
  // 下半分: alpha（グレースケール, R=G=B=元のA）
  packed.set(toGrayscaleAlpha(rgba), w * h * 4);
  return packed;
}
// エンコードは encodeRgbaFramesToVp9Webm(packedFrames, fps, { alphaKeep:false, muxAlpha:false }) の
// 幅=W, 高さ=H*2 版をそのまま使い回せる（キーフレーム/backpressure ロジックは不変）。
```

再生側は `<video>` **1本**。`drawSplitAlphaComposite` 相当は同じ video から2回 `drawImage` で crop するだけ:

```ts
ctx.drawImage(video, 0, 0, w, h, 0, 0, w, h);           // color 領域
maskCtx.drawImage(video, 0, h, w, h, 0, 0, w, h);        // alpha 領域（同一 decode フレームなので原理的にズレない）
```

**この方式が不具合②を「原理的に」無くす理由**: 同じ `<video>` 要素の同じ `drawImage` 呼び出し内で読む2つの領域は**必ず同一デコード済みフレームに由来する**。ブラウザの decode パイプラインが1本だけになるため、drift・輪郭ズレという概念自体が発生しえない。副次的に **decode セッション消費も 2→1 に半減**し、Comp 32 のような「同一クリップから3本デコード」構成の負荷も 3→2 に減る。

#### コスト・トレードオフ

| 項目 | 内容 |
|------|------|
| ビットレート | color 単独と同じ画質を保つには、パック後の1ストリームで**現行の color+alpha 合計とほぼ同等のビットレート**（≈2倍）を割り当てる必要がある。据え置くと画質が両方薄まる |
| エンコード時間 | フレーム総ピクセル数は変わらない（2本→1本は本数が減るだけ）ので大差なし。むしろ `VideoEncoder.configure`/`flush` が1回で済み**エンコード全体の呼び出しオーバーヘッドは減る** |
| シークの seam 汚染 | VP9 のループフィルタ/ブロック分割が color/alpha 境界を跨いで軽微ににじむ可能性（mask 上端 数px）。実測で許容範囲か確認が必要 |
| 既存アセットとの互換性 | 既存プロジェクトの split alpha 資産（`meta.alphaMode:"split"` + `alphaPath`）は**そのまま読める形で残す**必要がある（後方互換）。新規 Extract だけ `meta.alphaMode:"packed"` 等の新形式にし、再生側は `alphaMode` で分岐（`split` は現行 `videoSplitAlpha.ts` 経路、`packed` は新 crop 経路）。**一括マイグレーションは不要**（両方式を共存させられる） |
| spec / データスキーマ | `meta.alphaMode` に新しい値を追加する程度で `project.json` の**型そのもの（§5）は変えずに済む**可能性が高いが、§16.2 の資産フォーマット定義には確実に触れる。**CLAUDE.md の運用ルールに従い、着手前に方針をユーザーへ確認すること**（散文更新で済むか、§5 相当の変更が要るかも含めて要相談） |

#### 却下/保留した派生案

- **G: WebCodecs 手動プレイヤー化** — `<video>` タグを使わず `VideoDecoder` で color/alpha 両ストリームを自前デコードし、**デコード順序（フレーム番号）でペアリング**する。real-time な currentTime 依存を完全に排除できるため理論上は最も厳密（B2 の genlock すら不要になる）。ただし A/V 同期・バッファリング・シーク・エラー処理を含む**ミニ動画プレイヤーの自前実装**が必要で、工数は E よりさらに大きい。将来的に preview 全体を WebCodecs 化する計画がある場合の布石としてのみ検討価値あり。今回のスコープでは見送り。
- **decode に software を強制するエンコーダヒント** — `configureVideoEncoder` の `hardwareAcceleration` はエンコード側の設定であり、**再生時のブラウザ decode セッション割当は JS から制御できない**ため、狙った効果が得られない。却下。
- **Subject Extract がある comp では `holdTimeline` を丸ごと無効化** — 実装は最も簡単だが、`holdTimeline` 本来の目的（A/V ズレ防止・音声とのリップシンク維持）まで失われ、通常動画との組み合わせで別の同期崩れを誘発しうる。場当たり的すぎるため却下（修正1で十分かつ安全に同じ効果が得られる）。

---

### 推奨ロードマップ

| フェーズ | 内容 | 理由 |
|----------|------|------|
| **Phase 0（最速で試せる実験）** | 修正0（warm-up debounce 短縮 / `PLAY_GATE_TIMEOUT_MS` 延長） | 数行の定数調整のみ。ただし実機 Playwright 検証で「warm-up の勝敗は stall 合計時間にほぼ影響しない」ことが分かったため、**期待効果は当初想定より小さい**（優先度は下げてよい） |
| **Phase 1（即着手可・低リスク）** | 修正1（`holdTimeline` + `pauseVideo` 双方から companion 除外）**✅実装済み** + 修正3（合成コスト削減・冗長描画スキップ、未着手） | spec/INV 非変更・既存挙動への副作用が小さい。「webm と一緒にテキストが止まる」を確実に解消 |
| **Phase 2（中期）** | 修正2（B2 rate genlock）**✅実装済み** | Person レイヤー自体の輪郭ズレ・もたつきを大幅改善。実測ドリフト（平均33〜50ms、最大147ms）を踏まえ `RATE_CORRECTION_BAND_SEC` 下限を調整済み |
| **Phase 3（要ユーザー確認・大掛かり、優先度を実測により引き上げ）** | 修正4（パックド1本化） | 実機検証で **Person レイヤーの2ストリームが両方ソフトウェア VP9 デコード（`VpxVideoDecoder`）であり、その状態でサンプル時間の約93%が stall** という規模の不安定さが確認された。2→1 ストリーム化で SW decode 負荷そのものを半減させる本策の価値は、実測前の想定より高いと判断すべき |

Phase 1 → 2 は独立に効果測定できる（Phase 1 だけ入れても② は残るはずなので、Comp 32 で「webm はまだ少しガクつくが、他レイヤーの巻き込みは無い」ことを確認できれば設計どおり）。**Phase 0 は実測で効果が限定的と判明したため、Phase 1/4 を優先し Phase 0 は余力があれば試す位置づけに格下げする。**

---

## 検証・切り分け手順（実装時）

1. **修正1 適用前後で** DevTools Performance を録画し、「Subject Extract レイヤーがある comp」再生中に **他レイヤー（text 等）の `matrix3d` 更新頻度が一定を保つか**を比較。適用後は holdTimeline / pauseVideo の頻度・時間が Subject Extract companion drift と無関係になっているはず。
2. `video.seeking` / `currentTime` 代入イベントを color / alpha 双方で記録し、**両者の乖離幅の時系列**を取る（修正2 適用前後で乖離のピークが縮むか）。
3. 既存回帰: `test/subjectExtractApply.test.ts`、`test/videoElementSync.test.ts`、`test/playbackVideoSync.test.ts` 相当（存在すれば）。
4. 新規 unit 案:
   - `computePlaybackSyncState` に「companion サンプルを含む配列」と「`role==="primary"` だけの配列」を渡して hold/pause 判定が変わることを固定するテスト（修正1 の回帰ガード）。
   - `computeAlphaGenlockRate` の境界値テスト（修正2）。
5. **実機 verify に Comp 32 をそのまま使う** — `mafter-project (23).zip`（本 doc 作成時点でダウンロードフォルダにある最新版）の Comp 32 は、①「静止テキスト2枚・緩やかなスクロールテキスト3枚・微振動カメラ」＋②「同一クリップからの3本同時デコード（背景生 mp4 + Person color/alpha）」という**本 issue の両不具合を再現するのに理想的な実データ**。以下を目視・計測する:
   - 修正1 適用前: 再生中に断続的な全体フリーズ（テキストの一瞬の停止・スクロールのカクつき）が起きるか。
   - 修正1 適用後: 全体フリーズが消え、Person レイヤーの映像だけが荒れる状態に収束するか（②のみ残る）。
   - 修正2 適用後: Person レイヤーの輪郭ズレ・ガクつきが軽減するか（color/alpha の `currentTime` 差の時系列を記録して比較)。
   - `chrome://media-internals` で Comp 32 再生中の decode セッション数を確認し、3本のうちどれが SW フォールバックしているかを診断（修正4 着手判断の参考データにする）。
6. 実機（可能なら非力めの HW）で Subject Extract レイヤー + 通常 text/solid レイヤーが同居する comp を再生し、**他レイヤーが Subject Extract のドリフトに巻き込まれて止まらないこと**を目視確認。

---

## まとめ

- **「webm と同時にテキストもフリーズ/もたつく」は偶然の随伴症状ではなく、コードが直接そう作っている**。`holdTimeline` が真の間、Draft rAF ループ・Best frame clock・AudioClock マスタークロックの**どの経路でも `onFrameChange` が呼ばれず** `resolve(frame)` 自体が走らないため、comp 内の**全レイヤー**（text 含む）の DOM 更新が完全に止まる。Subject Extract の webm 部分だけが止まるのではなく、**再生ループ全体が止まる**（不具合①）。
- **「構成によっては webm だけがもたつく」も同じ①で説明がつく** — Comp 32 の実データ調査で、他レイヤー（静止/微小変化のテキスト・微振動カメラ）は凍結してもほぼ知覚できない量しか変化しないことを確認した。①はコード分岐ではなく**画面上で「その瞬間に変化している量」の違い**によって見え方が変わる。
- それとは独立に、**Person レイヤー自体が「独立デコードの2本の `<video>`」という構造ゆえに常時不安定要因を抱えている**（不具合②）: color/alpha 間にフレーム対応を保証する仕組みがなく独立 drift がそのまま輪郭ズレに直結する、毎フレームの CPU 合成コスト、readyState 不足時の別系統リトライ rAF、そして Comp 32 で確認したような**同一クリップからの3本同時デコード**による decode セッション競合。
- **「同じ Comp・同じ操作でも再生するたびに滑らかだったりガクついたりする」のは、①②に加えてもう一つ独立した原因（不具合③ warm-up レース）がある**が、**実機 Playwright 検証の結果、③単独では実測された stall の規模（サンプル時間の約93%）を説明しきれないと判明した**。Play 時点で3本とも ready だったシナリオ（100%）と、3本とも未 ready だったシナリオ（0%）とで、stall 合計時間はほぼ同じ（2787ms vs 2805ms／3000ms 中）だった。③は実在するメカニズムだが、**「毎回ではなく時々」の主犯としての比重は当初の記述より小さく見積もるべき**。
- **実機検証で新たに判明した、より支配的な要因**: Person レイヤーの color・alpha companion は両方とも **ソフトウェア VP9 デコード**（`VpxVideoDecoder`、GPU 非使用）で再生されていた。2本同時のソフトウェアデコードが実時間 30fps に追従できず、`holdTimeline` が約1秒の上限（`maxHoldSec`）に達しては強制解除され、また発火する、を繰り返す状態が観測された。**「ときどきスムーズ」の実態は、warm-up の勝敗よりも、その回の再生でハードウェアデコードが使えたかどうか（環境・GPU・ドライバ・decode セッション競合に依存）の方が支配的である可能性が高い**（ただし本検証は headless 実施のため、GPU デコードが既定で無効という headless 固有の制約込みの数値である点に注意 — 実 Chrome での追試が望ましい）。
- それとは独立に、**Person レイヤー自体が「独立デコードの2本の `<video>`」という構造ゆえに常時不安定要因を抱えている**（不具合②）: color/alpha 間にフレーム対応を保証する仕組みがなく独立 drift がそのまま輪郭ズレに直結する（実測ドリフト平均33〜50ms・最大147ms）、毎フレームの CPU 合成コスト、readyState 不足時の別系統リトライ rAF、そして Comp 32 で確認したような**同一クリップからの3本同時デコード**による decode セッション競合。
- **修正の優先順位は実測を踏まえて更新**: 修正1（companion を hold/pause 判定から分離・低リスク）で①を確実に解消 → **修正4（1本パック化で2ストリーム→1ストリームにし SW decode 負荷を半減）の価値を実測前より高く評価**（§16.2 資産フォーマットに触れるため着手前にユーザー方針確認は引き続き必要）→ 修正2（color/alpha の rate-based genlock、実測ドリフトレンジで定数を調整）で輪郭ズレを改善 → 修正3（合成コスト削減）で底上げ。修正0（warm-up タイミング調整）は実測で効果が限定的と分かったため優先度を下げる。
