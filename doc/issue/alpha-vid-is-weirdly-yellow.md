# タスク: packed alpha 動画の「黄ばみ」色ズレを、元動画の色と一致するよう修正する

あなたは mafter-effect（c:\Workspace\mafter-effect / React+Vite+TS strict）の実装担当です。
まず **CLAUDE.md** と **doc/mafter-effect-spec.md の §16.2b・§2.2**、および
**.claude/skills/implementation-loop/SKILL.md** を読み、「先に spec → 次に実装」を厳守してください。
SSoT は spec。§5 データスキーマ / INV に触れる変更が必要になったら、実装を止めてユーザーに
選択肢＋推奨案を提示して確認すること（`asset.meta` は自由形 record なのでフィールド追加は
§5 変更に当たらない＝確認不要）。

## 症状（ユーザー報告・確定事項）
- packed alpha 動画レイヤー（color+mask を上下パックした1本動画。§16.2b）が、
  **Preview Quality を "Original" にしても**元動画より黄色っぽく（warm/黄ばみ）表示される。
- つまり **proxy（縮小コピー）固有の問題ではない**。原本 packed 動画そのものの色が、
  元のソース動画とズレている。

## 前セッションでの診断（強い仮説・ただし実測で確定させること）
packed 原本は「ソース動画を decode → canvas RGBA → 再エンコード」で作られる。この
**再エンコード（RGB→YUV）と再生時デコード（YUV→RGB）のラウンドトリップが sRGB 中立に
なっていない**ことが原因と見られる。具体的候補:
1. `VideoEncoderConfig` に色空間シグナリング（matrix BT.601/BT.709・range limited/full）が
   一切無く、エンコーダの推測とデコーダの解釈が食い違う（黄/緑寄りの hue シフトの典型原因）。
2. デコード経路の非対称（既に実測済み: `verify-gl-alpha-parity.mjs:159-165` で
   texImage2D 経路と drawImage 経路の間に **maxDiff 22/255** の未解明差異）。

**重要な考え方**: ソース動画を `drawImage(video, canvas)` した時点で、ブラウザがソースの
色空間を解決して **sRGB RGBA** にしてくれている。よって「元動画の色空間を YUV matrix レベルで
複製する」のではなく、**再エンコード→再デコードのラウンドトリップを sRGB 中立（恒等）にする**
のが正しいゴール。これにより出力＝ソースの見た目になる。まず最初にこの前提が正しいか
（drawImage 直後の canvas がソース色を正しく再現しているか）を実測で確認すること。

## 現状のコードマップ（触る/確認する箇所）
- **原本 packed のエンコード（根本原因の第一候補）** `src/editor/subjectExtract/encodeAlphaWebm.ts`
  - H.264/mp4: `encodeRgbaFramesToMp4H264`（`configureVideoEncoder` 呼び出し ~L233-239、
    `new VideoFrame(bitmap, …)` ~L266）
  - VP9/webm フォールバック: `encodeRgbaFramesToVp9Webm`（baseConfig ~L119-129、
    `new VideoFrame` ~L156）
  - どちらも `colorSpace` / `VideoColorSpace` を **一切設定していない**（リポジトリ全体で
    `colorSpace` の出現ゼロ）。
- **split→packed 変換のデコード経路** `src/editor/subjectExtract/convertSplitToPacked.ts:191-201`
  （drawImage→getImageData→pack）。冒頭コメント L5-13 に「decode 色差は環境依存・maxDiff 22/255」
  の既知注意書きあり（原因未診断のまま放置されている）。
- **preview proxy の再エンコード（同じ色ズレを二重に乗せうる）**
  `src/runtime/packedVideoProxy.ts` → `src/runtime/webcodecsVideoEncode.ts`（config ~L100-106・
  やはり colorSpace 無し・`new VideoFrame` ~L115）。
- **合成/表示（デコード側）** WebGL: `src/runtime/videoAlphaGl.ts:300-304`
  （`UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` で GL↔CPU 差を抑える既存処置あり）。
  CPU: `src/runtime/videoPackedAlpha.ts`（`getContext("2d")` の合成）。
- **共有エンコーダ設定（回帰リスク）** `src/runtime/exporter.ts:651 configureVideoEncoder`。
  packed の H.264 経路はこれを共有し、**通常の mp4/webm 書き出し（L299/L363）も同じ関数を通る**。
  ここを触る場合は通常 export への無回帰を必ず確認すること。

## ゴール / 受け入れ条件
1. **視覚一致**: 同一ソースを直接表示した1枚絵と、packed 化後に合成した同フレームの
   ピクセル差が許容内に収まる（黄ばみが消える）。実ブラウザで **数値計測**して before/after を
   示すこと（例: 平均/最大チャンネル差。現状値を測ってから、改善後の閾値を提示）。
2. **INV-2 非干渉**: preview / browser export / headless export の scene 解決値は一致のまま。
   色空間シグナリングの追加は決定論を壊さない範囲で行う。
3. **無回帰**: 通常 video の mp4/webm/PNG 書き出し、split alpha、既存の packed 再生・
   HTML bundle・proxy 生成、`npm test` が緑のまま。特に `configureVideoEncoder` 共有経路。
4. **一貫適用**: 原本エンコード（`encodeAlphaWebm.ts` の H.264・VP9 両方）と proxy 再エンコード
   （`webcodecsVideoEncode.ts`）で **同じ色空間規則**を使う（片方だけ直すと proxy 切替時に
   色が変わる）。

## 実装プロセス（厳守）
- **Phase 0（実測先行・必須）**: 実ブラウザ（Playwright、memory: `runtime-verify-harness`）で
  現象を再現し、黄ばみを数値化する。前セッションの scratchpad に Comp32 の lean fixture がある
  （`C:/Users/resis/AppData/Local/Temp/claude/.../scratchpad/pj22*`、probe-packed-*.mjs 参照）。
  「ソース直接表示」vs「packed 合成」の同フレーム比較で、どのチャンネルがどれだけズレるか、
  matrix 起因（hue シフト）か range 起因（輝度/コントラスト）かを切り分ける。
- **WebCodecs の色空間 API は Opus 4.8 subagent に確認してから実装する**: `VideoEncoderConfig` に
  標準の `colorSpace` フィールドは無い可能性が高い。Chrome の WebCodecs で RGB→YUV の
  matrix/range を確実に制御・シグナルする正しい手段（`VideoFrame.colorSpace` /
  `VideoColorSpaceInit` / エンコード設定 / デコード側との整合）を、subagent に調べさせ、
  推奨 API と代替案・落とし穴を取り寄せてから確定すること。未検証の API を当て推量で書かない。
- **テストは実ブラウザで**: 単体テスト（純関数があれば vitest）に加え、Phase 0 の計測を
  修正後に再実行して改善を数値で示す。**注意（memory: `headless-webcodecs-encode-blocks`）**:
  headless Chromium は WebCodecs VP9 encode を完走できないことがある。encode を伴う検証は
  実ブラウザ or その制約を織り込んだ設計にすること。
- **spec 先行**: §16.2b / §2.2 に「packed の色空間ポリシー（再エンコードは sRGB 中立、
  encode 側で matrix/range を明示シグナルして round-trip を恒等にする）」を追記してから実装。
  §5/INV は変更しない見込み（自由形 meta で足りるはず）。もし schema 変更が要るなら止めて確認。
- **runtime を触ったら `npm run build:player` を実行**（`videoAlphaGl.ts`/`videoPackedAlpha.ts`/
  `webcodecsVideoEncode.ts` 等は player が import する）。`playerBuildFreshness` を緑に。

## 完了の定義（Definition of Done）
- [ ] Phase 0 で黄ばみを数値再現・原因（matrix/range のどちら/両方か）を特定し記録
- [ ] spec §16.2b/§2.2 追記（§5/INV 不変）
- [ ] `encodeAlphaWebm.ts`（H.264・VP9）と `webcodecsVideoEncode.ts` に一貫した色空間シグナル
- [ ] （必要なら）convert/decode 経路の色管理の是正
- [ ] 実ブラウザで before/after のピクセル差を計測し、黄ばみ解消を確認
- [ ] 通常 export・split alpha・既存 packed・bundle・`npm test`・`npm run typecheck` 無回帰
- [ ] `npm run build:player` 済み・freshness 緑
- [ ] `progress.md` 更新（原因・修正・計測結果・残課題）

まず Phase 0 の再現・計測から始め、原因を確定させてから spec→実装に進んでください。
未確定点はユーザーに確認すること。
