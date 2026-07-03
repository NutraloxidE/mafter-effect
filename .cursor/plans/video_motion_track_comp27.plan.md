---
name: Motion Track Comp 27 Fix
overview: "分かりやすい"住宅街シーン（Comp 27）で Motion Track が無反応になる主因は既定「背景優先」マスクが道路を消すこと。既定を全体に戻し、回転全滅ガードと crowd exclude 縮小を入れる（RG-20260704-02）。
todos:
  - id: default-full
    content: 既定 roiPreset を full に
    status: completed
  - id: validity-guard
    content: summarizeTrackValidity + rotation 全滅時の警告/スキップ
    status: completed
  - id: soften-crowd
    content: TRACK_EXCLUDE_CROWD を手前中央のみに縮小
    status: completed
  - id: equalize-full-only
    content: equalizeHist を full mask 時のみ
    status: completed
  - id: tests-spec
    content: diagnostics/roi テスト + §16.1 散文
    status: completed
isProject: false
---

# Comp 27 修正（RG-20260704-02）

出典: Fable Handback in `.cursor/delegations/handoffs/RG-20260704-02.md`

## 主因
既定 `background` が画面 61% を黒塗りし路面標示を消去。QUAR はマスク境界の静止エッジにロックして「高信頼ゼロ並進」、回転は全滅を無警告で identity ベイク。

## 実装（完了）
1. 既定 `full`
2. `trackDiagnostics.summarizeTrackValidity` + UI ガード
3. crowd exclude 縮小 `{0.15,0.35,0.7,0.6}`
4. equalizeHist は full mask のみ
5. §16.1 散文
