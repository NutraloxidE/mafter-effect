# fix-plan v3 — Codex 実装票（GPT-5.6 terra medium・ワンショット）

> このドキュメントは [fix-plan-v3-continuous-audio.md](fix-plan-v3-continuous-audio.md) を Codex medium が
> **1 回の投入で燃えずに完了できる単一 Ticket** へ落とし込んだもの。設計理由・仮説・背景は本家プランにあり、
> ここには**作業票（allowed / forbidden / steps / commands / stop / report）だけ**を書く。
>
> 実装は「**コード削除のみ**」で新規ロジックはゼロ。Codex は下記 Ticket V3-01 **だけ**を実施する。
> **実ブラウザ音声キャプチャによる受け入れ計測は Codex の完了条件に含めない**（人間 / 計測ハーネス側に残す。
> Codex に自己合格宣言させない）。

---

## Plan intake summary

- Source document: `doc/issue/static-noise-problem/fix-plan-v3-continuous-audio.md`
- Goal: ループ継ぎ目の seam declick 機構（v2-plus で追加）を撤去し、音声をループ 1 周の間ノータッチにする。実装差分は削除のみ。
- Known Phases: v3 単一（削除 D1–D4）
- Known WPs: 1 個（= Ticket V3-01）
- Required gate files: なし（decision-record 等のゲートは本 issue には無い）
- Required status files: `progress.md`（更新は本 Ticket の最後・任意項目。Codex がやってもよいが自己受け入れ宣言はしない）
- Hard forbidden areas: editor preview 経路 / mp4・webm・PNG export / §5 schema / INV / `hasAudioLayers` のセマンティクス / Web Audio graph 導入
- Allowed file policy: 下記 4 ファイルのみ（+ 生成物 `public/player.js`）
- Required commands: `npm run typecheck`、`npm test -- bundleFootageAudio`、`npm test -- BundleAudioClock`（存在する場合）、`npm run build:player`
- Required generated artifacts: `public/player.js`（`src/player/` を変更するため再ビルド必須・commit 対象）
- Human verification required: 実 Chromium + 実音声キャプチャによる受け入れ（`verify-loop-seam-click.mjs`）。**Codex は実施も自己宣言もしない。**
- Ambiguities: なし（削除箇所は下記に exact string で確定済み）
- First safe action: Ticket V3-01 の D1 から順に削除

---

## Ticket V3-01 — seam declick 撤去（deletion-only）

- Owner: Codex medium（GPT-5.6 terra medium）
- Model: medium
- Size: 小（削除のみ・4 ファイル・15〜25 分）
- Purpose: v2-plus で追加した「ループ継ぎ目 declick」機構を撤去し、ループ再生中に音声要素を触らない状態へ戻す。分離配線（video 音声→別 `<audio>`・常時ミュート・trimStart/inPoint 修正・audioMaster）は**維持**する。

### Allowed files（この 4 つ＋生成物のみ）

- `src/player/BundleAudioClock.ts`
- `src/player/bundleFootageAudio.ts`
- `test/bundleFootageAudio.test.ts`
- `public/player.js`（`npm run build:player` による生成物。手編集しない）

### Forbidden files / areas（触るな）

- `src/player/BundlePlayer.ts`（分離配線は維持。触らない）
- `src/runtime/**`（`footageAutoFade.ts` / `footageAudio.ts` / `DomRenderer.ts` / `previewPlaybackLoop.ts` / `videoGainOnly.ts` 等すべて）
- `src/components/PreviewPanel.tsx` ほか editor UI
- `src/runtime/exporter.ts` ほか export 経路 / `src/core/schema.ts`（§5）
- `hasAudioLayers`（`BundleAudioClock.ts` 内）の実装・戻り値・呼び出し元 — **一切変更禁止**
- Web Audio API / AudioContext / MediaElementAudioSourceNode の新規導入禁止
- 本 Ticket の削除に無関係なリファクタ・整形・rename 禁止

### Pre-read（実装前に読む・これ以外は読まなくてよい）

- `src/player/BundleAudioClock.ts`（`tick()` のループ wrap 分岐と `applyGains()`）
- `src/player/bundleFootageAudio.ts`（末尾 `clampFadeWindowToLoopRange`）
- `test/bundleFootageAudio.test.ts`（末尾 `describe("clampFadeWindowToLoopRange …")`）

### Implementation scope（exact edits・4 点）

#### D1 — `src/player/BundleAudioClock.ts` `tick()` のループ wrap 分岐

`el.volume = 0;`（seek 直前の強制ミュート hack）とその直前の説明コメントを削除する。**`el.currentTime = …` の seek と `void el.play();` は残す**（wrap 1 回の seek は必須）。

Before:
```ts
        for (const [id, el] of this.elements) {
          const info = this.gainByObjectId.get(id);
          try {
            // fix-plan-v2plus: ループ継ぎ目の seek はソース波形の不連続を生む。tick は frame>=lastFrame
            // を検出した時点で applyGains を通らずここへ来るため、declick フェードアウトが 0 まで
            // 到達しないまま seek すると不連続が可聴 gain で通過する（＝クリック）。seek の瞬間だけ
            // volume を 0 に落として不連続を無音でくるみ、直後の applyGains（in フェード）で 0→1 へ
            // 戻す。el.volume は完全な sample 精度ではないが、seek 前後を無音側に寄せることで
            // 残留クリックを大幅に低減する。
            el.volume = 0;
            el.currentTime = footageAudioMediaTimeSec(this.rangeStart, info?.inPoint ?? this.rangeStart, info?.trimStart ?? 0, this.fps);
            void el.play();
          } catch {
            /* ignore */
          }
        }
```

After:
```ts
        for (const [id, el] of this.elements) {
          const info = this.gainByObjectId.get(id);
          try {
            // fix-plan-v3: ループ wrap の seek 1 回のみ。継ぎ目 declick はしない（コンテンツ由来の
            // 波形段差は素材側の責務・el.volume は sample 精度でなく隠蔽は逆効果と実測で判明）。
            el.currentTime = footageAudioMediaTimeSec(this.rangeStart, info?.inPoint ?? this.rangeStart, info?.trimStart ?? 0, this.fps);
            void el.play();
          } catch {
            /* ignore */
          }
        }
```

#### D2 — `src/player/BundleAudioClock.ts` `applyGains()`

`clampFadeWindowToLoopRange(...)` 呼び出しを削除し、素の `info.inPoint / info.outPoint` を `autoFadeMultiplierAtFrame` に渡す（v2-plus 以前＝spec §11.5.2 標準挙動へ戻す）。

Before:
```ts
      if (info.autoFade) {
        // fix-plan-v2plus: ループ境界を実質的なカット端として扱い、フェード窓をループ範囲で
        // クランプする（bundleFootageAudio.ts の純関数・unit test 済み）。bundle 専用の
        // autoFadeMultiplierAtFrame 呼び出し引数のみの変更 — 関数自体・他経路は変更しない。
        const fadeWindow = clampFadeWindowToLoopRange(info.inPoint, info.outPoint, this.rangeStart, this.rangeEnd, this.loop);
        v *= autoFadeMultiplierAtFrame(frame, {
          inPoint: fadeWindow.inPoint,
          outPoint: fadeWindow.outPoint,
          fps: this.fps,
          suppression: info.suppression,
        });
      }
```

After:
```ts
      if (info.autoFade) {
        // fix-plan-v3: §11.5.2 標準カット端フェードのみ（素材自身の inPoint/outPoint 端）。
        // ループ境界を疑似カット端扱いする v2-plus 拡張は撤去（継ぎ目で volume を動かさない）。
        v *= autoFadeMultiplierAtFrame(frame, {
          inPoint: info.inPoint,
          outPoint: info.outPoint,
          fps: this.fps,
          suppression: info.suppression,
        });
      }
```

さらに import 行から未使用になる `clampFadeWindowToLoopRange` を除く。

Before（`src/player/BundleAudioClock.ts` の import 行）:
```ts
import { clampFadeWindowToLoopRange, collectBundleFootageAudioSources, footageAudioMediaTimeSec } from "./bundleFootageAudio";
```

After:
```ts
import { collectBundleFootageAudioSources, footageAudioMediaTimeSec } from "./bundleFootageAudio";
```

#### D3 — `src/player/bundleFootageAudio.ts`

`clampFadeWindowToLoopRange` 関数を **JSDoc コメントごと削除**（D2 で唯一の呼び出し元が消え dead code になるため）。ファイル末尾の以下のブロック全体を削除する:

```ts
/**
 * 純関数: ループ再生中の declick フェード窓を、素材自身の inPoint/outPoint からループ範囲で
 * クランプする。
 * … (中略) …
 */
export function clampFadeWindowToLoopRange(
  inPoint: Frame,
  outPoint: Frame,
  rangeStart: Frame,
  rangeEnd: Frame,
  loop: boolean,
): { inPoint: Frame; outPoint: Frame } {
  if (!loop) return { inPoint, outPoint };
  return { inPoint: Math.max(inPoint, rangeStart), outPoint: Math.min(outPoint, rangeEnd) };
}
```

（`collectBundleFootageAudioSources` / `hasBundleFootageAudio` / `footageAudioMediaTimeSec` は残す。）

#### D4 — `test/bundleFootageAudio.test.ts`

`clampFadeWindowToLoopRange` の describe ブロック（`describe("clampFadeWindowToLoopRange …")` 全体・4 テスト）を削除し、import から同名を除く。

Before（import）:
```ts
import {
  clampFadeWindowToLoopRange,
  collectBundleFootageAudioSources,
  footageAudioMediaTimeSec,
  hasBundleFootageAudio,
} from "../src/player/bundleFootageAudio";
```

After（import）:
```ts
import {
  collectBundleFootageAudioSources,
  footageAudioMediaTimeSec,
  hasBundleFootageAudio,
} from "../src/player/bundleFootageAudio";
```

そして末尾の `describe("clampFadeWindowToLoopRange (fix-plan-v2plus — seam declick for mid-file-cut loops)", () => { … });` ブロック全体を削除する。

### Explicit non-goals（やるな）

- 新しい declick / crossfade / Web Audio / fadeGain の実装（v3 は削除のみ）
- `BundlePlayer.ts` の分離配線変更
- `verify-loop-seam-click.mjs` の編集や実行、ループクリーン fixture の生成（これは人間 / 別工程）
- 実ブラウザ音声計測の実施・結果判定・受け入れ自己宣言
- 無関係な整形・rename・import 並べ替え

### Tests / commands（この順で実行）

1. `npm run typecheck` — 型エラーゼロ（未使用 import 残しに注意）
2. `npm test -- bundleFootageAudio` — 残テスト green（14 件想定 / clamp 4 件削除後）
3. `npm test -- BundleAudioClock` — 存在すれば green（無ければスキップ可・報告に明記）
4. `npm run build:player` — `public/player.js` を再生成（`src/player/` 変更のため必須）

### Generated artifacts

- `public/player.js` を再ビルドし **commit 対象に含める**（手編集はしない・`npm run build:player` の出力のみ）。

### Stop conditions（下記に当たったら止めてユーザー/Claude へ報告）

- allowed files 以外の編集が必要になった
- 削除により `clampFadeWindowToLoopRange` 以外の箇所で型エラー / 参照エラーが出て、allowed files 内で解消できない
- `bundleFootageAudio` / `BundleAudioClock` 以外の既存テストが本 Ticket と無関係な理由で落ちる
- `npm run build:player` が失敗する

### Completion report（この形式で報告）

```
Changed files:
Deletions applied: D1 / D2 / D3 / D4（各 done/skip）
typecheck:
npm test -- bundleFootageAudio:
npm test -- BundleAudioClock:
npm run build:player:（public/player.js 更新有無）
Remaining work: 実ブラウザ音声受け入れ計測（Codex 未実施・人間/ハーネス側）
Blockers:
```

**次の Ticket へは進まない。実ブラウザ計測の合否は宣言しない。**

---

## Codex へ渡す最終プロンプト（コピペ用）

```
Implement only Ticket V3-01 from doc/issue/static-noise-problem/fix-plan-v3-codex.md.
This is a deletion-only change (no new logic).

Allowed files (only these + the build output):
- src/player/BundleAudioClock.ts
- src/player/bundleFootageAudio.ts
- test/bundleFootageAudio.test.ts
- public/player.js  (regenerated by npm run build:player only — do not hand-edit)

Forbidden:
- Do not edit BundlePlayer.ts, anything under src/runtime/**, PreviewPanel.tsx,
  exporter.ts, or src/core/schema.ts
- Do not change hasAudioLayers (in BundleAudioClock.ts) at all
- Do not introduce Web Audio / AudioContext / MediaElementAudioSourceNode
- Do not refactor, rename, or reformat anything unrelated to the deletions
- Do not change existing test expectations except deleting the clamp tests below

Do exactly these 4 deletions (exact before/after strings are in the doc):
D1 BundleAudioClock.ts tick() loop-wrap branch: delete `el.volume = 0;` and its
   comment; KEEP el.currentTime seek and void el.play().
D2 BundleAudioClock.ts applyGains(): drop the clampFadeWindowToLoopRange call,
   pass raw info.inPoint / info.outPoint to autoFadeMultiplierAtFrame; remove
   clampFadeWindowToLoopRange from the ./bundleFootageAudio import.
D3 bundleFootageAudio.ts: delete the clampFadeWindowToLoopRange function (with its
   JSDoc). Keep collectBundleFootageAudioSources / hasBundleFootageAudio /
   footageAudioMediaTimeSec.
D4 test/bundleFootageAudio.test.ts: delete the clampFadeWindowToLoopRange describe
   block (4 tests) and remove it from the import.

Run in order:
- npm run typecheck
- npm test -- bundleFootageAudio
- npm test -- BundleAudioClock   (skip & note if it does not exist)
- npm run build:player           (commit the regenerated public/player.js)

Stop if:
- You need to edit any file outside the allowed list
- A type/reference error remains that you cannot fix within the allowed files
- build:player fails
- Unrelated existing tests fail

Report: changed files, which of D1–D4 were applied, each command result, whether
public/player.js changed, remaining work, blockers.

Do NOT run or judge the real-browser audio capture (verify-loop-seam-click.mjs);
that acceptance stays with the human. Do not continue to any other ticket.
```
