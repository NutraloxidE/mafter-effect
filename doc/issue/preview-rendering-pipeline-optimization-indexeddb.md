# Preview Rendering Pipeline Optimization & IndexedDB Bottlenecks

> **対象**: アプリケーション起動時の JavaScript モジュールロード、初期プレビューアセット読み込み、`decodeVideoEntry` によるバイナリデコード
> **状態**: 2026-07-07 **課題抽出・ボトルネック解析完了（実装前）**  
> **再現データ**: -
> **関連 spec**: §11.1 IndexedDbFs / §11.7 bundle player / INV-2（preview ↔ export 同一 scene 解決値）  
> **関連実装**: [imageAssetCache.ts](../../src/runtime/imageAssetCache.ts) / [IndexedDbFs.ts](../../src/fs/IndexedDbFs.ts) / [serialize.ts](../../src/core/serialize.ts) / [FileSystem.ts](../../src/fs/FileSystem.ts) / [vite.config.ts](../../vite.config.ts)

---

## 症状とボトルネック分析

現在のプレビュー描画経路において、以下の3つのフェーズで致命的な遅延が発生しており、起動時のUIフリーズや初期描画（LCP）の遅れを引き起こしている。

| ボトルネック要因 | 現象と影響 |
|:---|:---|
| **JSモジュールの直列ロード** | HTTP/1.1の接続制限により、200以上のJSファイルが順次ロードされ、LCPのRender delay（1,088 ms）の大部分を占めている。 |
| **メインスレッドでのバイナリ操作** | `decodeVideoEntry` 内で `ArrayBuffer.slice` (241 ms) と `URL.createObjectURL` (341 ms) が実行され、動画デコードのためにメインスレッドが数百ミリ秒フリーズし、画面更新（Long task）をブロックしている。 |
| **IndexedDB (疑似FS) の一括処理** | `loadFromProject` にて全アセットを一気にロードする際、IndexedDBから読み出されたバイナリデータが一気にメインスレッドに流し込まれ、ブラウザの描画やLayout開始が数百ミリ秒遅延する。 |
| **シリアライズ・文字列変換** | `deserializeProject` および `bytesToText` (TextDecoderによるデコード) の文字列変換オーバーヘッドにより、プロジェクトのパース処理だけで無視できないオーバーヘッド（計250ms超）が発生している。 |

---

## アーキテクチャ上の真因

### 1. Web Workerの不使用によるバイナリ処理のメインスレッド占有
[imageAssetCache.ts](../../src/runtime/imageAssetCache.ts#L447-L456) の `decodeVideoEntry` は完全にメインスレッドで同期処理として動作している。
```typescript
function decodeVideoEntry(
  buf: Uint8Array,
  mime: string,
  meta: Record<string, unknown> | undefined,
): ImageEntry {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab], { type: mime }));
  const size = ImageAssetCache.sizeFromMeta(meta) ?? { width: 100, height: 100 };
  return { url, size };
}
```
動画ファイルの巨大な `ArrayBuffer` に対する `slice` コピーや、`Blob` インスタンス生成および ObjectURL の発行がメインスレッドで行われるため、UIスレッドが一切描画（Layout / Paint）の機会を与えられずフリーズ状態に陥る。

### 2. IndexedDbFs（疑似FS）のトランザクション多重オーバーヘッドと直列処理
IndexedDBをラップしてファイルシステムとして動作させている `IndexedDbFs` は、ファイル取得時のトランザクション処理および読み出し完了のonsuccessコールバックに大きなオーバーヘッドを抱えている。

*   **トランザクション生成の蓄積**: [IndexedDbFs.ts](../../src/fs/IndexedDbFs.ts#L49-L58) の `read` は、呼び出されるたびに個別に `this.tx("readonly")` を作成している。ループ内で全アセットに対して個別に `fs.read` を呼ぶと、アセット数に応じた膨大なトランザクションの作成・破棄のオーバーヘッドが発生する。
*   **直列 await ループ**: ループ内で同期的に `await fs.read` を繰り返すため、DB操作のレイテンシが直列に足し算され、LCPのRender delayを増大させている。
*   **メインスレッドの占有**: 一括取得したバイナリデータを休止（隙間）なしでメインスレッドに流し込むため、Layout 処理の実行がブロックされる。

### 3. HTTP/1.1 による接続数上限の頭打ち
ローカル開発サーバー起動時、HTTP/1.1 の同時接続数上限（最大6接続）に引っかかり、200本を超えるJavaScriptモジュールの読み込みリクエストがキューイング（Queueing）されてロード時間が数倍に延びている。

### 4. 文字列デコードとパースの中間オーバーヘッド
IndexedDBから読み出された `Uint8Array` を `bytesToText` でデコードしてから `deserializeProject`（`JSON.parse`）に流す二段階の手順において、中間文字列の不要なメモリ割り当てや関数階層の呼び出しがオーバーヘッドを引き起こしている。

---

## 提案する解決策（最適化指示）

### 1. バイナリ処理 of 完全オフロード (Web Worker化)
`decodeVideoEntry` を非同期（`Promise`）化し、内部処理を Web Worker に移行する。
*   **実装**: 
    *   `imageAssetCache.ts` 内にインライン Web Worker を定義する。
    *   メインスレッドでの `slice` コピーを避けるため、`buf.buffer` を `Transferable` として Worker に転送し、所有権を譲渡する（コピーコストゼロ）。
    *   Worker 内部で `slice`、`Blob` 生成、`URL.createObjectURL` を実行し、生成された `url`（文字列）のみをメインスレッドに返却する。
    *   呼び出し元である `loadFromProject`、`loadProxiesFromFs`、`loadSplitAlphaFromFs` を `await` で待ち受けるよう更新する。

### 2. IndexedDB 読み込みの優先度付きストリーミング（バッチ化・フレーム譲渡）
*   **優先順位付けキューの導入**:
    *   プロジェクトの起動時、`project.rootComposition` (初期表示コンポジション) およびそこからネストされているコンポジションを事前に走査し、参照されている「優先アセットID」の集合を特定する。
    *   アセットロード配列 `project.assets` を、優先アセットが先頭に来るようにソートしてからロードを開始する。画面表示に必要なアセットが最速でロード・描画されるようになる。
*   **バッチロードとフレームギャップ (Yielding) の導入**:
    *   `IndexedDbFs` に単一トランザクションで複数キーを一括で取得する `readBatch` メソッドを実装。
    *   `IDBCursor`（`openCursor`）を用いてストアを走査し、一定件数（例: 2〜3件）処理するごとに `setTimeout(..., 0)` 等を挟んで `cursor.continue()` を呼び出す。これにより、アセットロード中にブラウザがレイアウト/画面描画を行う「隙間」を確保し、UIフリーズを防ぐ。
    *   `IndexedDbFs.list` の `getAllKeys` も同様に `openKeyCursor` を使ってバッチ処理に改善する。

### 3. 開発プロトコル最適化（HTTP/2・HTTPS化）
*   `devDependencies` に `@vitejs/plugin-basic-ssl` を追加インストールする。
*   `vite.config.ts` で `basicSsl()` プラグインを導入し、開発サーバーを HTTPS で起動させる。これにより HTTP/2 による JS モジュールやアセットの並列ロードを可能にし、LCPの遅延を大幅に削減する。

### 4. デシリアライズ処理のインライン最適化
*   `deserializeProject` が `Uint8Array | string` を直接受け取れるように拡張。
*   `Uint8Array` の場合は、`serialize.ts` 内で再利用される `TextDecoder` を用いて直接デコードしながら `JSON.parse` に渡し、`bytesToText` による中間文字列割り当てや関数呼び出しオーバーヘッドを削減する。
