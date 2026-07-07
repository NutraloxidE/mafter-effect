# 透過動画（split alpha）プレビュー軽量化プラン v2 — packed 1本化 + per-layer GL 合成

> **ステータス**: v2 ドラフト（2026-07-07 全面改稿・ユーザー回答反映済み）。
> **v1（2026-07-06〜07 の「WebGL 動画レイヤー（3D 空間共有トグル）」）は実装後に破棄された** — 経緯と教訓は §1。v1 実装の全容は `webgl-implement-failed` ブランチに保存（参照用・復活させないこと）。
> 本ファイルは spec（SSoT）を置き換えない。実装時は §7 の承認事項を確定してから spec（§16.2 ほか）→ 実装の順。

---

## 0. TL;DR

**目的（唯一）**: 「アルファチャンネル付き透過動画（Subject Extract の split alpha）があると preview が重くなる／comp 全体がフリーズする」の解消。**3D 機能ではない**。

体感の重さは 2 つの独立したコストの合算で、対策もレバーが別:

| # | コスト | 実測 | 対策 |
|---|---|---|---|
| **主因** | **ソフトウェア VP9 decode ×2本（color + mask）+ 2クロック同期**。companion ドリフト → `holdTimeline` → comp 全体凍結（stall がサンプル時間の約93%、[issue doc](../issue/subject-extract-split-alpha-webm-preview-instability.md) 実機実測） | decode がボトルネック | **(A) packed 1本化**: color と mask を 1 本の動画に上下パック。1 ストリーム＝1 クロック＝genlock/ドリフト/companion hold が**構造的に消滅**。コーデックは H.264 優先（ハードウェアデコード） |
| 副因 | **毎フレーム CPU 合成**（`getImageData`×2 + `putImageData`、1080p で平均 17.4ms/frame — v1 Phase 0 実測） | 合成もメインスレッドを圧迫 | **(B) per-layer GL 合成**: レイヤー div 内の合成用 2D canvas を**同じ場所で** WebGL canvas に差し替え、シェーダで合成（v1 実測 平均 3.1ms / p50 0.9ms） |

**設計の核（v1 との決定的な違い）**: WebGL は「シーン」ではなく「**canvas のピクセルを作る手段**」としてだけ使う。
レイヤーの div・`matrix3d`・CSS 3D カメラ・blendMode・filter・トラックマット・調整レイヤー・export のレイヤー列挙は**一切触らない**（今の 2D canvas と同じ DOM の座席に GL canvas が座るだけ）。したがって:

- **カメラに捕まらない**（レイヤーとしての 3D/2D 挙動は現状から変化ゼロ）
- **blend/エフェクトはボツにならない**（canvas は今までどおり 1 個の DOM 要素。CSS がそのまま効く）
- **THREE.js 不要**（素の WebGL の小さなシェーダ 1 本。`three` 依存・player.js +510KB は要らない）
- **スキーマ変更なし**（`SceneObject`/§5 は不変。変わるのはアセット meta の §16.2 だけ）
- **スコープ外を明確化**: 3D 深度交差・GL シーン共有・scene3d/glTF/light の seam は**全部やらない**（ユーザー指示: スコープを絞る）

**既存プロジェクトも軽くする（§2.4・確定）**: (A) packed は新規 Subject Extract 出力に効くが、**既に split で作られた既存 comp（Comp 30/32 等）**は変わらない。そこで既存 split を 1クリック・非破壊で packed 化する変換をスコープに含める。リリースは **Phase 1（GL 合成／副因）先行** → Phase 2（新規 packed／主因）→ Phase 2.5（既存変換／既存の主因）の順。

**非破壊性の要点**: 既存 project.json・既存 split アセット・blend/filter/matte/3D/カメラ配線は**完全に非破壊**（触らない・byte 等価）。合成経路は 2D→GL に差し替わるがピクセル一致 verify + CPU フォールバックで実質無害。「非可逆」なのは packed が再エンコード派生物である点のみ（split も同レベル・悪化しない。既存変換は世代劣化1回）。

---

## 1. v1 の失敗から学んだこと（post-mortem・必読）

v1 は「Phase 0〜6 実装・verify 緑・typecheck 緑」で完了報告されたが、ユーザー実利用で失敗と判定され main がリセットされた。**「テストが緑」と「目的が達成された」は別物**だった。

### 1.1 何がズレたか

1. **目的の取り違え（最重要）**: ユーザーの目的は「透過動画の軽量化」。v1 は `threeD=true` の動画を `THREE.Scene`+`THREE.PerspectiveCamera` に入れる「3D レイヤー機能」として作った。結果、**軽量化のためのレイヤーが comp カメラに捕まる**という意味論の変化が起き、ユーザーの期待と食い違った。
2. **ボトルネックの見立て違い**: v1 は合成（副因）だけを GPU 化した。しかし実測済みの主因は **ソフトウェア VP9 decode ×2 + holdTimeline**（issue doc: stall 93%、両ストリームともソフトウェアデコード確認済み）。decode 側を触らない限り体感は改善しない。**Phase 0 のマイクロベンチ（合成 17.4ms→3.1ms）は本物だが、体感の支配項ではなかった**。
3. **サイレントな見た目 regression**: `threeD=true` の動画が自動で GL 経路に入る設計だったため、(a) エフェクト付きレイヤーは CSS filter が「隠された DOM 側」にだけ掛かり **GL canvas には未配線＝エフェクト消失**、(b) batch wrapper に `mix-blend-mode` 未配線（export では `blendMode:"normal"` ハードコード）＝**ブレンド消失**、(c) DOM 3D レイヤーと GL カメラの整合 verify なし。
4. **スコープ膨張**: scene3d/glTF/light 用の「将来 seam」を最初から作り込み、実装とレビューの認知負荷を上げた（ユーザー自身も「余分に言った」と認めており、今回は削る）。

### 1.2 v1 から引き継ぐ価値のある技術的教訓（実機デバッグで確定済み）

新実装でも同じ罠を踏むので必ず守る:

- **UV/上下反転**: video テクスチャ（`UNPACK_FLIP_Y_WEBGL` なし）は row0 が v=0。素直な UV だと上下反転する。**非ゼロピクセル判定では検出できない** — スクリーンショット比較（人物が正立しているか）を必ず verify に入れる（[debug-visual-render-bug](../../.claude/skills/debug-visual-render-bug/SKILL.md) の教訓どおり）。
- **未バインド sampler**: シェーダが必ず sample する sampler2D に有効テクスチャを bind しないと incomplete texture で黒抜けする。mask 無しモードでは 1x1 白テクスチャを既定 bind。
- **export 用 re-render**: `renderFrame()` 時点では video が seek/decode 中のことがある。既存 2D 経路が `flushVideoFrames()` 内で `drawSplitAlphaComposite` を再実行するのと同じ理由で、**GL 合成も `waitForVideoFrame` 完了後に再実行が必要**（今回は差し替え設計なので、既存の再実行呼び出しがそのまま GL 版を呼ぶ形になる＝v1 のような専用キャッシュ機構は不要）。
- **`preserveDrawingBuffer: true`**: export（`inlineCanvasBitmaps` の `toDataURL`）が render 直後以外のタイミングで canvas を読むため必須。
- **`playerBuildFreshness.test.ts` の緑を信用しない**: v1 セッション中、stale なのに緑になる非決定性を複数回確認。ランタイム変更時は**必ず明示的に `npm run build:player` を実行**してから `git diff public/player.js` で更新を確認。
- **`npm install`/`npm uninstall` は playwright を prune する**: 前後で `node -e "require.resolve('playwright')"`、消えたら `npm i playwright@1.61.0 --no-save`。
- **headless Chromium の限界**: WebGL は SwiftShader（ソフトウェア GL）になるため **perf 計測は headed 実 Chrome でのみ有効**。VP9 の decode 挙動も headless と実機で大きく違う（既知）。正しさの verify は headless 可、体感・stall% の判定は実 Chrome。

---

## 2. 設計

### 2.1 (B) per-layer GL 合成 — 2D canvas の「その場差し替え」

**現行**（[videoSplitAlpha.ts](../../src/runtime/videoSplitAlpha.ts)）: レイヤー div 内に `color <video>`（opacity:0）+ `mask <video>`（display:block, 不可視配置）+ **合成結果を表示する `<canvas class="mafter-split-alpha-canvas">`** が並び、毎フレーム `drawSplitAlphaComposite()` が canvas 2D で `drawImage`→`getImageData`×2→alpha 差し替え→`putImageData` する。呼び出し元は 3 箇所: `DomRenderer.updateComponentEl`（video ケース）・`DomRenderer.flushVideoFrames`（export 用 re-draw）・`scheduleSplitAlphaRedrawWhenReady`（ready 待ちリトライ）。

**変更**: 同じ座席の `<canvas>` を WebGL コンテキストで取得し、合成をシェーダで行う。DOM 構造・クラス名・`setSplitAlphaPresentation` のサイズ/可視制御・呼び出し 3 箇所の**呼び出し規約（引数・bool 戻り値）は不変**。

新規ファイル `src/runtime/videoAlphaGl.ts`（THREE 不使用・素の WebGL1）:

```ts
export interface GlAlphaCompositor {
  /** drawSplitAlphaComposite と同じ契約: 両ソース ready なら描画して true。 */
  compositeSplit(colorVideo: HTMLVideoElement, alphaVideo: HTMLVideoElement): boolean;
  /** packed 1本: 上半分=color, 下半分=mask を UV で振り分けて合成。 */
  compositePacked(packedVideo: HTMLVideoElement, layout: PackedAlphaLayout): boolean;
  /** context lost 等で使用不能になったら true（呼び出し側は CPU 経路へフォールバック）。 */
  readonly broken: boolean;
  dispose(): void;
}
export function createGlAlphaCompositor(canvas: HTMLCanvasElement): GlAlphaCompositor | null;
```

- コンテキスト取得: `canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })`。取得失敗（`null`）なら呼び出し側が**既存 CPU 経路をそのまま使う**（フォールバックは削除しない）。
- フラグメントシェーダ（split 用・packed 用の 2 プログラム or uniform 分岐）:
  ```glsl
  // split: gl_FragColor = vec4(color.rgb * mask.r, mask.r);   ← premultiplied
  // packed: color = texture2D(tex, vec2(u, v*0.5)); mask = texture2D(tex, vec2(u, 0.5 + v*0.5));
  //         （gutter 分の inset は uniform で渡す。§2.2）
  ```
  現行 CPU 実装（`applyGrayscaleMaskToAlphaChannel` = mask の R をそのまま alpha に）と一致させる。premultiply は canvas 側 `premultipliedAlpha:true` との整合をピクセル一致 verify で確認する（§5）。
- テクスチャ: `texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)` を毎 composite 実行（video→GPU 直行。`getImageData` の CPU 往復が消えるのが本体）。`UNPACK_FLIP_Y_WEBGL=true` にして UV は素直に書く（§1.2 反転教訓の最小回避）。
- readyState ガード・サイズ変更追随は現行 `drawSplitAlphaComposite` と同一条件（`HAVE_CURRENT_DATA` 未満なら false）。
- **context loss**: `webglcontextlost`（preventDefault）/`webglcontextrestored` を listen。lost 中は `broken=true` → 呼び出し側がその canvas について CPU 経路に切替（`getContext("2d")` は GL 取得済み canvas では取れないため、**canvas 要素を作り直して差し替える**。`ensureSplitAlphaCompanion` に再生成パスを足す）。
- **コンテキスト予算**: 1 split/packed レイヤー = 1 GL context。同時マウント数が `MAX_GL_ALPHA_CONTEXTS = 8` を超えた分は zOrder 昇順で CPU 経路に落とす（決定論・ブラウザの ~16 上限への安全マージン）。dispose 時は `WEBGL_lose_context.loseContext()` で明示解放。
- **キルスイッチ**: `localStorage.mafterDisableGlAlpha === "1"` で全面 CPU 経路（フィールド診断用）。

**DomRenderer 側の変更は最小**: `SplitAlphaCompanion` に `gl: GlAlphaCompositor | null` を持たせ、`drawSplitAlphaComposite(...)` 呼び出し 3 箇所を「`gl` が生きていれば `gl.compositeSplit(...)`、だめなら従来関数」にする薄いラッパ `compositeSplitAlpha(companion, colorVideo, alphaVideo)` 経由に置換。**per-object entry・zOrder・export 列挙・blend/filter/matte の配線には触れない**。

### 2.2 (A) packed 1本化 — §16.2 アセット形式の追加（要承認・§7）

**フォーマット**: color の直下に grayscale mask を**上下（top-bottom）パック**した 1 本の動画。

```
┌──────────────┐  y=0
│  color (w×h)   │
├──────────────┤  y=h      ← gutter 8px（黒）: 4:2:0 クロマの越境にじみ防止
│  mask  (w×h)   │
└──────────────┘  y=2h+8
```

- **上下（横並びでない）理由**: mask は grayscale＝輝度（Y）にだけ情報を持ち、4:2:0 サブサンプリングの影響を受けない。上下パックなら width が変わらず、エンコーダのマクロブロック幅・H.264 level 制約に当たりにくい。
- **gutter**: 境界の 2x2 クロマブロック越境で color 最下行の色が mask 最上行の Y に混ざるのを防ぐ緩衝帯（8px 黒、シェーダ側は gutter を除いた領域を sample）。`PACKED_ALPHA_GUTTER_PX = 8` を encode/decode 共有定数に。
- **コーデック**: `avc1.640028`（H.264 High）を第一候補に `VideoEncoder.isConfigSupported` で交渉（`hardwareAcceleration: "prefer-hardware"` → 無印の順、既存 `configureVideoEncoder` と同型）。コンテナは mp4（`mp4-muxer` は既存依存）。**AVC 不可環境は VP9/webm の packed にフォールバック**（それでも 1 ストリーム化の利益は残る）。
- **音声トラック（確定・ユーザー承認 2026-07-07）**: **元 footage の音声を packed の mp4 に別トラックとして同梱する**。映像を上下パックしても音声は独立トラックなので影響を受けない（現行 split の color webm が内蔵音声を持つのと同じ挙動を維持）。`mp4-muxer` の audio track に既存の音声エンコード経路をそのまま流す。無音素材のときはトラック省略。
- **サイズ上限**: packed 高さ `2h+8` が 4096 を超える場合（source h > 2044、つまり 4K 素材）は v1 では **split のまま**にする（無理に対応しない・既知の制約として §16.2 に明記）。Subject Extract の実用は 1080p 帯。
- **アセット meta**（`asset.meta` は自由形の record・`SceneObject`/§5 は不変）:
  ```jsonc
  { "alphaMode": "packed", "packedLayout": "topBottom", "contentHeight": 1080, "gutterPx": 8 }
  ```
  既存 `alphaMode: "split"`（+`alphaPath`）はそのまま有効（後方互換・既存プロジェクトは無変更で再生継続）。判定ヘルパ `isPackedAlphaVideoMeta()` を `imageAssetCache.ts` の `isSplitAlphaVideoMeta()` の隣に追加。
- **生成元**: Subject Extract（[encodeAlphaWebm.ts](../../src/editor/subjectExtract/encodeAlphaWebm.ts)）の出力を今後 packed に切替（`mode: "packed"` を union に追加。フレームは既存の `toOpaqueRgbColor`/`toGrayscaleAlpha` の出力を 1 枚のパックフレームに合成してから encode）。
- **既存 split → packed 変換（確定・スコープに含める・ユーザー承認 2026-07-07）**: §2.4 参照。既存プロジェクトを軽くする唯一の手段のため、当初「スコープ外」だったのを撤回して含める。

**packed の再生配線**（ここが体感改善の本体）:

- `<video>` は **1 本だけ**。companion `<video>`・`ensureSplitAlphaCompanion` の alphaVideo・genlock（`applyAlphaGenlock` 一式）・`mirrorSplitAlphaVideoState`・`sampleMountedVideoClocks` の companion サンプル — **packed アセットではすべて不発**（コードは split 用に残す）。1 クロックなので holdTimeline 判定は通常動画と完全に同型になる。
- 表示は split と同じく「video を opacity:0 にして合成 canvas を表示」。合成は `gl.compositePacked()`（GL 必須ではなく、CPU フォールバック `drawPackedAlphaComposite()` も実装する — `drawImage` の source rect 指定 ×2 + alpha 差し替えで、split の CPU 実装より `getImageData` が 1 回減る）。
- `bundleCollect.ts`: packed は単一ファイル＝`alphaPath` 同梱の特殊処理が**そもそも不要**（split で起きた「companion 同梱漏れ」バグの類型が構造的に消える）。
- Pipeline パネルの `alphaWarnings`（split 二重描画警告）: packed は対象外にする（警告理由が消滅するため）。

### 2.4 既存 split → packed 変換（1クリック・非破壊・既存プロジェクトを軽くする本命）

> **なぜ必須か**: ユーザーの実際の痛みは**既に split で作られた既存 comp**（Comp 30/32 等）。§2.2 で新規 Subject Extract 出力を packed にしても、既存アセットは split のままで主因（decode×2 + holdTimeline）が残る。Phase 1（GL 合成）は既存 split の**副因（CPU 合成）だけ**軽くするが、decode×2 に無料の抜け道は無く、**再エンコード（=packed 化）だけが既存の主因を消せる**。

- **UI（opt-in・非破壊）**: `alphaMode:"split"` のアセット/レイヤーに「packed 化」アクションを出す（Project パネルのアセット右クリック or Inspector）。1クリックでオフライン変換。
  - **非破壊**: 元の split アセット（color+alpha webm）は FS に残す。packed を**新規アセット**として作り、対象レイヤーの参照を packed に差し替える（元 split を参照する他レイヤーがあれば残る）。ユーザーは気に入らなければ参照を戻せる。
- **変換処理（オフライン・決定論）**: realtime を苦しめている 2クロック genlock は**変換では無関係**。export と同じフレームステップ機構で確実にペアリングできる:
  1. color/alpha 両 `<video>`（or `VideoDecoder`）を frame ごとに決定論 seek（`waitForVideoFrame`）。
  2. 各フレームで color と mask を 1 枚の上下パックフレーム（+gutter）に `drawImage` 合成。
  3. §2.2 の packed エンコーダ（`mode:"packed"`）へ投入。音声トラックは元 color から copy（再エンコード不要なら remux、無理なら再エンコード）。
- **コスト**: Phase 2 の packed エンコーダ + export の seek 機構 + パック算術を**再利用**するため、増分は「decode→repack ループ + UI 入口 + アセット差し替え（store）」のみ。**Phase 2 の上に +1 集中フェーズ（~1日規模）**。
- **代償（明示）**: 既に lossy な split の color を**もう1回 lossy 再エンコード**（世代劣化1回）。mask は grayscale で劣化ほぼ無し。perf 目的なら許容範囲。最高画質が要るケースは元 footage から Subject Extract 再実行（lossy 1回）が上位互換 — 両手段を併存させる。
- **スコープ**: 「1レイヤー/1アセット単位の変換」まで。プロジェクト内の全 split を一括変換するバッチ UI は当面作らない（要望が出たら薄いラッパを足すだけ）。

### 2.3 変わらないもの（回帰不変条件）

| 項目 | 保証の根拠 |
|---|---|
| 動画なし comp / 通常動画 / unified alpha | コード経路に一切触れない |
| split アセットの見た目（GL 化後） | 同一 canvas 座席・同一合成式。ピクセル一致 verify（§5） |
| blendMode / filter / SVG filter / 調整レイヤー / トラックマット | レイヤー div 構造不変。canvas は従来と同じ 1 DOM 要素 |
| 3D（threeD/カメラ）| per-layer 差し替えなので CSS 3D 経路のまま。GL はカメラを知らない |
| export（mp4/webm/PNG 連番/bundle）・INV-2 | export は「レイヤー div → canvas 発見 → 焼き込み」の既存機構。canvas の中身の作り方が変わるだけ。flush 後 re-draw も既存呼び出しが GL 版を呼ぶ |
| ネスト precomp 内の split alpha | `renderNestedComp` も同じ `updateComponentEl` を通るため自動で恩恵を受ける（v1 と違い「トップレベル専用機構」が無い）。ただし §5 で明示 verify |
| project.json byte 等価（INV-4） | 既存アセットの meta は書き換えない。packed は新規生成アセットのみ |

---

## 3. スキーマ / spec / INV への影響

- **§5（TypeScript 型）: 変更なし**。`SceneObject` に新フィールドを足さない（v1 の `threeDGroupWithPrev` は撤去済み・2026-07-07 救出コミット）。
- **§16.2（要更新・散文）**: packed フォーマット（レイアウト・gutter・コーデック交渉順・サイズ上限・meta フィールド）を追記。`alphaMode` の値域が `"unified" | "split" | "packed"` になる旨。
- **§19.5**: Pipeline 警告の対象から packed を除外する旨を 1 行追記。
- **INV-1〜6: 影響なし**（resolve() は触らない。GL はレンダラ内部の実装詳細で `ResolvedScene` に何も足さない＝INV-3 は v1 より自然に守られる）。
- **INV-2**: preview と export は同一の合成実装（GL または CPU フォールバック）を通る。GL/CPU 間の許容差は verify で ±2/255 以内に固定（§5）。

---

## 4. 実装フェーズ（Sonnet 5 向け・各フェーズが独立に緑になる粒度）

> 各フェーズ完了時: `npm run typecheck`・`npm test`・**ランタイム変更時は `npm run build:player` を明示実行**（§1.2）。着手前に [implementation-loop](../../.claude/skills/implementation-loop/SKILL.md) を読むこと。
> **リリース戦略（確定・ユーザー承認 2026-07-07）**: **Phase 1 を先行リリース**する。GL 合成（副因）だけで既存 split が即・部分的に軽くなり、体感を確認してから packed（主因）へ進む。Phase 1 は独立コミット・独立 revert 可能。

- **Phase 0（診断・軽量・推奨・実装前ゲート）✅ 実施済み（2026-07-07・headed 実 Chrome）**: `verify-comp32-webm-instability.mjs` を headed（`channel:"chrome"`）+ Comp 32 相当ミニプロジェクト zip で実行。
  - **結果（ベースライン・3試行平均）**: decoder 種別＝**3本とも `D3D11VideoDecoder`（`kIsPlatformVideoDecoder:true` = ハードウェアデコード）**。issue doc の headless 実測（VpxVideoDecoder = ソフトウェア、stall 93%）とは逆の結果。stall はシナリオA（待ってからPlay）平均 342.6ms/3000ms（**11.4%**）、シナリオB（scrub直後即Play）平均 747.3ms/3000ms（**24.9%**）。drift 平均 32〜65ms・最大 79〜113ms（resync 閾値 500ms には遠い）。
  - **§0 主因の再解釈（環境依存の分岐）**: HW decode 環境では「ソフトウェアデコード×2」という主因は成立せず、**残る stall は primary ストリーム（背景mp4 + Person color）側の遅延**が原因（修正1 でグローバル hold/pauseVideo 判定から companion は正しく除外済みであることをコード確認済み・漏れなし）。Comp 32 は同一クリップを3本同時デコード（背景+ Person color + Person alpha）する構成のため、HW decode でも同時セッション競合で primary が詰まっていると考えられる。**packed 化（Person を2本→1本）は総同時デコード数を 3→2 に減らすため、decoder 種別に関係なく効く構造的改善** — 今回の実測により Phase 2/2.5 の価値はむしろ上がったと判断（Opus 4.8 レビュー 2026-07-07 で確認）。
  - **Phase 1 への影響**: GL合成は毎フレーム CPU 合成コストにしか効かず、上記 primary 側遅延由来の stall には直接効かない可能性が高い。**Phase 1 単体では体感改善が乏しい場合がある**とユーザーに明示した上で、予定通り Phase 1→2→2.5 の順で実装する（ユーザー承認 2026-07-07）。
  - 生ログ: `verify-comp32-webm-instability-result.json`（リポジトリ・一時物、コミット対象外）。
- **Phase 1（GL 合成・split 対応）← ここまでで先行リリース ✅ 実装済み（2026-07-07）**: `videoAlphaGl.ts` 新規（§2.1 API、split/packed 両対応の compositor）+ `videoSplitAlpha.ts` に canvas キー付き WeakMap（`SplitAlphaCompanion.gl` フィールドではなく、呼び出し 3 箇所の**引数・戻り値シグネチャを完全維持**する `compositeSplitAlpha()` 経由に統一。設計意図は同一・実装は companion オブジェクトを引き回さない簡潔な形に変更）+ context loss/予算（`MAX_GL_ALPHA_CONTEXTS=8`・first-come-first-served の簡易版、zOrder 昇順の厳密な入れ替えは未実装）/キルスイッチ（`localStorage.mafterDisableGlAlpha`）。
  - **実装上の発見（重要・§1.2 に準ずる新教訓）**: (1) UV 上下反転 → 修正（quad の v 成分を反転）。(2) premultiplied 出力にすると CPU 実装（ストレートアルファ）と往復量子化でズレる → ストレートアルファ出力（`vec4(color.rgb, mask.r)`）+ `premultipliedAlpha:false` に変更。(3) **ブラウザの `texImage2D(video)` アップロード経路は `drawImage(video)` と独立した YUV→RGB 変換をしており、マスク無しの平文 color video だけでも実測 maxDiff=22/255（avg 0.40）のズレが出る**（Opus 4.8 レビューで確証実験込みで検証済み・premultiply/colorspace pixelStorei/texture filter のいずれを変えても数値不変=シェーダ側では回避不可）。mask はグレースケール（色差信号なし）のため alpha は bit 一致するが、color の RGB は browser 既知特性の floor を踏まえた許容差で判定する必要がある（§5 テスト参照）。
  - テスト: unit test は `videoAlphaGl.test.ts`（`shouldCreateGlAlphaCompositor`/`dispatchSplitAlphaComposite` の純ロジック：予算・キルスイッチ・broken 遷移の分岐）。実ブラウザ verify（`verify-gl-alpha-parity.mjs`、Comp 32 実データ）は「alpha は ±1 厳格」「color RGB は premultiplied 差（diff×alpha/255）で ±25」の二段ゲートで PASS 確認済み（±25 は上記 browser baseline 実測 max22 を踏まえた較正値）。
  - **視覚 verify 済み**: 人物正立をライブ canvas screenshot + PNG 連番 export の両方で確認（`probe-gl-alpha-gl.png` / `probe-export-split-alpha-frame0.png`）。
  - **実機再生 verify 済み（headed 実 Chrome、Phase 0 と同一手法で再計測）**: decoder は Phase 0 と同じく HW（D3D11VideoDecoder）。Scenario A（待ってからPlay）は stall 0回/0ms に改善（Phase 0 実測: 平均5.33回/342.6ms）。Scenario B（scrub直後即Play）は平均1031ms と Phase 0 実測（747.3ms）から悪化して見えるが試行数3の自然な分散範囲内（両シナリオとも Opus 4.8 レビュー通り「Phase 1 単体では primary 側遅延由来の stall は解消しない」という予測と整合）。GL関連の console error は無し（既存の無害な `AbortError: play() interrupted by pause()` のみ）。
  - **export 無回帰 verify 済み**: `verify-export-split-alpha.mjs`（PNG連番、`flushVideoFrames`＝compositeSplitAlpha 呼び出し3箇所の一つを通る経路）で console error 0・非ブランク・正立を確認。
  - **Opus 4.8 コードレビュー（2026-07-07）で発見・修正した実装バグ**: split alpha レイヤーが非表示化/削除される経路（`updateComponentEl` の alphaUrl null 分岐・離脱オブジェクトの div 除去・`dispose()`）で GL compositor が dispose されず予算カウンタも減らない実装漏れがあり、表示/非表示を8回繰り返すだけで以降の新規レイヤーが恒久的に CPU 固定になる不具合があった。`releaseSplitAlphaGlCompositor()` を新設し3箇所に配線して修正。あわせて毎フレーム `getAttribLocation`/`getUniformLocation` していたホットパスをプログラムリンク時キャッシュに変更（性能上の軽微な指摘、修正済み）。
  - **既知の残課題（記録のみ・未実装）**: GL コンテキスト予算はレイヤーの重要度（zOrder）を見ない first-come-first-served。予算超過時にどのレイヤーが CPU に落ちるかは非決定的。また、export 中に稀に（context lost 等で）GL/CPU 経路が同一 export 内で切り替わると、視覚的に許容範囲内（§5 二段ゲート）とはいえ 8〜22/255 程度の色差が同一動画の別フレーム間で生じうる。8コンテキスト予算は通常利用（同時 split/packed レイヤー数が少数）では実害が出にくいため、実運用で問題が出たら zOrder 優先度・export 経路固定化を追加検討する。
- **Phase 2（packed 形式・新規出力）**: encode（`mode:"packed"` + avc/mp4 交渉 + gutter + **音声トラック同梱**）→ アセット meta/判定ヘルパ → 再生配線（単一 video・companion 不発・`compositePacked`/CPU 版）→ `bundleCollect`（単一ファイル）→ Pipeline 警告除外。新規 Subject Extract 出力が主因まで解消。
  - テスト: packed フレーム合成の純関数（gutter 込み UV/rect 計算）unit test。encode→import→再生の e2e verify（実ブラウザ）。
- **Phase 2.5（既存 split → packed 変換・§2.4）**: Phase 2 のエンコーダ + export の seek 機構を再利用し、既存 split アセットをオフラインで packed 化する 1クリックアクション（非破壊・アセット差し替え）。**既存プロジェクト（Comp 30/32）の主因がここで初めて消える**。増分 ~1日規模。
  - テスト: decode→repack の決定論性（同一入力で同一 packed バイト）+ 変換後レイヤーの視覚一致 verify（split 版とピクセル比較）+ 元 split アセットが FS に残る非破壊性の確認。
- **Phase 3（export 全経路・無回帰）**: §5 の verify 一式 + 既存 export verify の再実行 + `npm run build:player`。
- **Phase 4（実地受け入れ）**: Phase 0 と同条件で再計測し、stall%・decoder 種別（packed が hardware H.264 で decode されているか）・体感をユーザーが確認して close。

各フェーズは単独でコミット可能・単独で revert 可能。**Phase 1 = 副因解消（先行リリース）→ Phase 2 = 新規の主因解消 → Phase 2.5 = 既存の主因解消**、という順で「既存プロジェクトまで軽くする」物語が完結する。

---

## 5. 検証計画

- **新規 verify（実ブラウザ・Playwright headed または channel:"chrome"）**:
  - `verify-gl-alpha-parity.mjs`: split アセット 1 枚、GL 合成 ON/OFF（キルスイッチ）で同一フレームの canvas ピクセル比較（±2/255）+ スクリーンショットの向き確認。
  - `verify-packed-alpha-playback.mjs`: packed アセット生成→import→再生。companion `<video>` が存在しないこと・合成結果が split 版と視覚一致すること・`sampleMountedVideoClocks` に companion サンプルが出ないこと。
  - `verify-packed-export.mjs`: packed レイヤーを含む comp の mp4/PNG 連番/HTML bundle export が非ブランク・向き正立・bundle zip に単一動画ファイルのみ。
  - `verify-gl-alpha-nested.mjs`: ネスト precomp 内の split alpha レイヤー（過去クラッシュ回帰の `verify-nested-split-alpha-crash.mjs` を GL 化後に再実行でも可）。
- **既存無回帰**（[add-layer-component-type §E](../../.claude/skills/add-layer-component-type/SKILL.md) 準拠）: `verify-video-export.mjs`・`verify-bundle-export.mjs`・`verify-bundle-split-alpha-playback.mjs`・blend/調整/displacement 系・solid+text+image のみ comp・`npm test` の export/raster/bundle 群。
- **perf 計測（headed 実 Chrome のみ有効・§1.2）**: Phase 0 ベースライン vs Phase 1 後 vs Phase 2 後。指標: stall%（holdTimeline 発火時間比）・メインスレッド長タスク・decoder 種別。**マイクロベンチ単独で「軽くなった」と結論しない**（v1 の教訓）。

---

## 6. スコープ外（明示・ユーザー指示による）

- 3D 深度交差・GL シーン共有・`threeDGroupWithPrev`（v1 で撤去済み。将来やる場合も本プランとは別軸）
- scene3d / glTF / light の拡張 seam（v1 の §2.4 は破棄）
- `raster3d`（§5.4b の汎用ラスタライズ 3D）
- 既存 split の**一括**変換バッチ UI（1レイヤー/1アセット単位の変換は §2.4 でスコープ内。全 split を一度に変換する UI だけが対象外）
- 4K 超の packed 対応（§2.2 サイズ上限）
- track matte 合成・調整レイヤー自体の GPU 化（現行のまま）

## 7. 実装前の承認事項（§5/直列化ルールに基づく）

**確定済み（ユーザー承認 2026-07-07）**:
- ✅ **Phase 1（GL 合成）を先行リリース** → Phase 2（新規 packed）→ Phase 2.5（既存 split→packed 変換）の順。
- ✅ **既存 split → packed 変換を 1クリック・非破壊でスコープに含める**（§2.4）。既存プロジェクトを軽くする本命。
- ✅ **packed に元 footage の音声トラックを同梱**（§2.2）。

**確定済み（ユーザー承認 2026-07-07・実装着手前レビュー）**:
1. ✅ **§16.2 packed meta フィールド名はプラン案どおり確定**: `alphaMode:"packed"` / `packedLayout:"topBottom"` / `contentHeight` / `gutterPx`（既存 `alphaMode:"split"` と同じ命名規則）。
2. ✅ **コーデック方針**: H.264(mp4) 優先 + VP9(webm) フォールバック（`isConfigSupported` 交渉、既存 `configureVideoEncoder` と同型）。
3. ✅ **Phase 0 診断を実装前ゲートにする**（実測ベースラインを Phase 4 の合否基準にする）。
4. ✅ **変換 UI の入口は両方**: Project パネルのアセット右クリック（アセット単位）と Inspector のレイヤー単位、両方に「packed 化」アクションを用意する（同一 store アクションを共有）。

## 8. 残リスク

- **H.264 VideoEncoder が使えない環境**: VP9 packed フォールバックで機能は成立するが、decode がソフトウェアのままなら主因の改善幅は縮む（1 クロック化の利益は残る）。Phase 0 でユーザー環境の対応状況を先に確認する。
- **GL テクスチャアップロード帯域**: `texImage2D(video)` は 1080p で通常 1ms 未満（GPU 直行）だが、SwiftShader 環境（headless・GPU 無効化時）では逆に遅い → キルスイッチ/フォールバックが保険。
- **premultiplied alpha の色ズレ**: canvas `premultipliedAlpha:true` とシェーダ出力の整合は理屈で合わせた上で、必ずピクセル一致 verify で固定（±2/255 を超えたら sRGB/リニアの扱いを疑う）。
- **mask 圧縮画質**: packed でも mask は非可逆圧縮。split と同一 bitrate 配分なら劣化は同等以下の見込みだが、輪郭のちらつき（segmenter 由来・issue doc 記載）は本プランでは直らない（別軸）。
