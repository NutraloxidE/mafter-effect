# `@mafter/runtime`（境界・INV-7）

> このディレクトリは **将来 `@mafter/runtime` として切り出す単一ランタイム核**である（spec §8 補足 / INV-7）。

## 契約（破ると INV-7 違反）

- **エディタ依存を import しない**: React / Zustand / DOM 編集 UI / 状態管理ストアをここから参照しない。
- 依存してよいのは `../core/schema`（データ型のみ, INV-3）と純粋なユーティリティだけ。
- **決定論を保つ (INV-1)**: `Math.random` / `Date.now` / `performance.now` / network / DOM 読み取りを `resolve` 経路で使わない。再生クロックだけが時間を持つ（それも frame に量子化して渡す）。
- 3 者がこの核を共有する: ①エディタ preview ②video exporter ③web bundle player（§11.7）。

## 構成

| ファイル | 役割 |
|---|---|
| `mat4.ts` | column-major `Mat4` 演算（CSS `matrix3d` と同レイアウト） |
| `easing.ts` | `Easing` → 時間再マップ関数（cubic-bezier ソルバ含む, §10） |
| `interpolate.ts` | `AnimatedProp<T>` を frame でサンプリング（§6.4 補間・端 clamp） |
| `resolved.ts` | `ResolvedScene` / `ResolvedObject` / `ResolvedComponent` 型（§8） |
| `renderer.ts` | `Renderer` インターフェース（§8） |
| `resolve.ts` | `resolve(comp, frame): ResolvedScene` 純関数（§6.3 / §8） |
| `index.ts` | 公開バレル |

DomRenderer / 再生クロック / module loader / expression engine は後続（DOM 依存のものは別ファイルで追加）。
