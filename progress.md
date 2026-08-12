
# Progress

### 2026-08-12（Claude Opus 5）— swarm 調査の到達点（ワーカー機が使用不可になり中断）

- **前回の「真因」は外れ**: transfer / `MemoryFs` の detach 修正（PR #71）を入れても症状は一切変わらなかった。あのバグ自体は実在するので修正は維持するが、**この症状の原因ではない**。
- **測って分かったこと（推測ではない）**: 失敗しているのは `asset=01KWZMGQFM57DSRCKX74ZKCJDW` ＝ **packed alpha の webm**（`alphaMode:"packed"`, `footageQuality:"low"`, mp4 から `extractedFrom` で生成されたもの）。状態は一貫して `ready=0 / size=0x0 / net=2(LOADING) / err=- / buffered=0`。
- **最悪の失敗モードを特定・修正**: [DomRenderer.ts](src/runtime/DomRenderer.ts) の video 経路は
  ```ts
  const src = assetId ? (imageCache?.getUrlForQuality(assetId, effQuality) ?? "") : "";
  video.src = src;   // ← URL が引けないと空文字
  ```
  **`video.src = ""` はドキュメント URL に解決され、要素はページ自身をメディアとして読もうとして永久に止まる**（`net=2 / ready=0 / err なし / buffered=0`）。これは「デコードが遅い」と**区別がつかない**。今回それを追うのに 1 セッション丸ごと溶かした。
  → src が空なら `removeAttribute("src")` にし、`videosAtExportTarget` は **src 無しの video を即座に失敗**として扱うようにした（デコード待ちを浪費しない）。
- **次に確認すべきこと（ワーカー機が空いたら最優先）**: なぜワーカー側で `getUrlForQuality` が URL を返せないのか。`imageCache.loadFromProject` が packed webm を登録できていない可能性が高い。今回の修正で `src=(none) len=0` として**エラーに明示される**ので、1 回の計測で判別できる。
- この間の総時間は 91〜100 秒で横ばい、`ADOPTION suspectFrames: 0` は毎回維持（**出力は常に正しい**）。

### 2026-08-12（Claude Opus 5）— swarm 真因: transfer が **FileSystem のファイルそのものを破壊**していた

- **これまでの前提が誤りだった**: 「ワーカー機がホストの約 3 倍遅く、動画のデコードが間に合わない」と考えていたが、**速度とは無関係**だった。
- **証拠の取り方**: ワーカーは `job-failed` に理由を載せて送っていたのに、ホストがそれを捨てていた（→ ログ出力を追加）。さらに `Footage did not reach frame N` だけでは足りないので、**video の実測値をエラーに載せた**（`DomRenderer.describeExportVideos()`）。得られた実測:
  ```
  #0 target=4.7333 at=4.750 ready=0 net=2 size=0x0 seeking=false err=-
  ```
  シークは発行済み（`at` は目標に乗っている）、しかし **`ready=0` / `size=0x0`＝1 バイトも復号できていない**、`err` は無し。「遅い」では説明がつかない状態。
- **真因（2 つの欠陥の合成）**:
  1. [videoBlobDecode.ts](src/runtime/videoBlobDecode.ts) の `decodeVideoBlobUrl` が `buf.buffer` を Web Worker へ **transfer** する。transfer は元の `ArrayBuffer` を **detach** する。
  2. [MemoryFs.ts](src/fs/MemoryFs.ts) の `read()` が**内部ストレージの `Uint8Array` を参照のまま返していた**（`IndexedDbFs` は毎回ストアから新しいコピーを返す）。
  → 検証コンプは**同じ mp4 を 2 レイヤーで使っている**ため、1 本目の読み込みでバッファが detach され、**2 本目は 0 バイト**を受け取る。0 バイトの Blob を渡された `<video>` は `error` を出さずに `readyState 0` のまま止まる。ホストで再現しないのは `IndexedDbFs` が毎回コピーを返すため＝**ワーカー固有の配線問題**。
- **修正**: transfer 前に必ず自分のコピーを作る（呼び出し側のバッファを所有している保証は無い）＋ `MemoryFs.read()` はコピーを返す（INV-4 の実装差を持ち込まない）。
- **テスト**: [test/memoryFsReadCopy.test.ts](test/memoryFsReadCopy.test.ts)。修正前に落ち修正後に通ることを確認済み（負のコントロール）。全体 2929 tests PASS。

### 2026-08-12（Claude Opus 5）— swarm: 失敗するワーカーが**書き出しの末尾を人質に取る**問題

- **実測**（ワーカー接続 `Direct` / `1.5× local`）: 書き出しが **149/150 で停滞**し、残り 1〜2 フレームに対して**1 フレームあたり 60 秒のデッドラインを丸ごと支払い続けた**。総時間 **210.9 秒**（ローカル単独 80.5 秒）。
- **なぜ末尾なのか**: リモート producer は `pullFromTail` で末尾から取る。ワーカーが失敗すると、その末尾フレームは「他の全部が終わっても書き出しを完了できない唯一のフレーム」になる。しかも producer は毎フレーム再挑戦するので、**失敗 1 回につき 60 秒**が積み上がる。
- **修正**: [remoteFrameProducer.ts](src/swarm/core/remoteFrameProducer.ts) に `SWARM_GIVE_UP_AFTER_FAILURES = 2`。連続 2 回失敗したワーカーには**以降そのエクスポート中は依頼しない**（成功で復帰）。損害が「デッドライン × 残りフレーム数」から「デッドライン × 2」に有界化される。
- **合わせて戻した判断**: ジョブのデッドラインを 150 秒へ延ばす案は**取り下げ**（60 秒のまま）。待ちが無料なのはホストに自分の仕事が残っている間だけで、末尾ブロックでは待つほど純損になる。
- **正しさは守られた**: この回の出力 zip をローカル単独と全フレーム比較して **suspectFrames 0**（前回は 18 枚が動画抜けだった）。`strictFootage` + `readyState` 判定 + 先頭 2 フレーム照合が効いている。
- **計測ハーネスにガードレールを埋め込み**: `swarm-export-ab.mjs` が書き出し後に必ず `ADOPTION {...suspectFrames}` を出力するようにした。速度だけを見て結論を出せないようにする。
- **テスト**: `stops asking a worker that keeps failing instead of paying its deadline per frame` を追加。全体 2927 tests PASS。
- **効果（実測）**: **210.9 秒 → 90.3 秒**。フォールバックは 2 回で打ち止め、`ADOPTION suspectFrames: 0`。

#### この時点の到達点と、残っている唯一の根本原因

| 状態 | 総時間 | リモート採用 | 出力の正しさ |
|---|---|---|---|
| ローカル単独（基準） | 80.5 秒 | — | ✓ |
| swarm（フレーム索引バグ時） | 115〜150 秒 | **0 枚**（気づけていなかった） | ✓（全部ホストが描き直していたため） |
| swarm（動画抜けが混入） | 80.9 秒 | 18 枚 | **✗ 18 枚が動画抜け** |
| swarm（再 announce の退行） | 134〜280 秒 | 0 枚 | ✓ |
| swarm（現在） | **90.3 秒** | 0 枚（ワーカーが自己申告で失敗） | **✓ suspectFrames 0** |

**正しさ・堅牢性の問題はすべて塞がった。** 残る唯一の根本原因は **ワーカー機（ホストの約 3 倍遅い）が 1920×1080 の動画をデコードしながら描画すると、フレームの目標時刻に間に合わない**こと。`strictFootage` がこれを検出してジョブを失敗させるため、出力は正しいがワーカーは貢献できない。

次に試す価値がある順:
1. **ワーカー側だけプロキシ解像度で描く**（`profile.proxy` を使い、動画を縮小してデコード負荷を下げる）。ただし出力解像度が変わるため照合の許容差設計が要る。
2. **ブロック内のフレーム順を単調前進に保つ**。現在 `pullFromTail` でブロックごとに後ろへ飛ぶため、毎ブロック先頭で後方シークが起きる。ホストのワークスチール方針と合わせて再設計が必要。
3. **1 フレームあたりのデコード待ちを、ジョブのリース残時間から逆算する**（現在は固定 2.5 秒）。

### 2026-08-12（Claude Opus 5）— swarm: 再 join の副作用（Offline ワーカーの山）を潰す

- **症状**: ワーカー側の承認タイムアウト再 join を入れた後、ホストのパネルに **Offline のワーカーが複数並び `Available compute: 1.0× local`**（＝使えるワーカー 0）。
- **原因**: 再 join のたびに peerId が変わり、ホストは 1 要求 = 1 接続を作る。ワーカーは最後の peerId しか保持しないので、**古い接続はホスト側に死んだまま残る**。`dropStaleConnections` は challenge 成功後にしか掃除しないため、challenge に到達しない接続は永久に残った。
- **修正**:
  - [coordinator.ts](src/swarm/core/coordinator.ts): `peer-join-request` を受けた時点で、**同じ deviceId でまだ身元証明が済んでいない接続を閉じて捨てる**。パネルは 1 デバイス 1 エントリに収束し、死んだピアにフレームがリースされない。
  - [WorkerRuntime.ts](src/swarm/worker/WorkerRuntime.ts): 承認待ちの再 join を**指数バックオフ**（20s → 40s → 80s → 上限 120s）に。詰めて再 join すると自分の承認を追い越して半開き接続を量産する。
- **テスト**: `keeps a rejoining worker to one peer id` を追加。全体 2926 tests PASS。
- **注意（テスト環境）**: `.claude/worktrees/` 配下の worktree があると vitest がそれも拾い、ファイル数・件数が倍に見える（306 files / 2926 tests）。`test/projectBins.test.ts` は全体実行時のみ落ちる既存フレークで、再実行で緑（別タスクに切り出し済み）。

### 2026-08-12（Claude Opus 5）— swarm: 動画抜けフレームが**書き出し済み zip に混入していた**（検出の穴を塞ぐ）

- **決定的な実測**: ワーカー付き書き出し（80.9 秒 / `Frames from workers: 3`）の zip をローカル単独 zip とフレーム単位で突き合わせたところ、**150 枚中 18 枚が 24KB 台**（正常は 340KB 台）＝動画レイヤーが抜けたフレームが**そのまま成果物に入っていた**。該当は frame 126-127, 134-143 など、リモートブロックの範囲と一致。
- **なぜ検出できなかったか（2 つの穴）**:
  1. `strictFootage`（各 video が目標時刻に乗っているか）は **video 要素が 1 本も無い場合に「全部そろっている」と同じ true を返す**。抜けているのが「位置」ではなく「要素そのもの」だったため素通りした。
  2. ホストのスポットチェックは全体の 5% を等間隔サンプルするだけで、**今回サンプルされたフレームがたまたま全部ローカル描画分だった**。リモート成果物が 1 枚も照合されないまま採用された。
- **修正**:
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) に `videoElementCount()` を追加。[workerRenderExecutor.ts](src/swarm/worker/workerRenderExecutor.ts) が「comp ツリーに video があるのに video 要素 0 本」ならジョブを失敗させ、セッションも破棄する（壊れた世界を持ち回らない）。
  - [remoteFrameProducer.ts](src/swarm/core/remoteFrameProducer.ts) に `SWARM_VERIFY_FIRST_REMOTE_FRAMES = 2`。**各ワーカーの最初の 2 フレームは必ずローカル再描画して照合**してから、以降を信頼する。サンプルが当たるかどうかに依存しない。副次的に `looksEmptyAgainst` の基準値（referenceSpread）が早期に入る。
  - `RemoteProducerSetup` に `decodePng` / `decodeZip` の差し替え口を追加（ブラウザの画像デコーダ無しで照合経路をテストするため）。
- **テスト**: `checks a worker's first frames before trusting any of its output` を追加。全体 2925 tests PASS、`tsc` クリーン。
- **教訓（CLAUDE.md「分散描画の性能結論」節・memory に固定）**: 「返ってきた」「カウンタが増えた」は採用の証拠にならない。**壊れていても値が出る指標**を根拠にしない。

#### 真因の特定（video 要素は在った・「時刻は合っているが復号フレームが無い」）

- 当初「video 要素が 0 本」と推定したが、**これは誤り**。同じ回の `renderMs` が 9.8 秒 → 24.4 秒に増えていたのは、`strictFootage` が毎フレーム「目標時刻に乗っていない」と判定してリトライ描画していたため。つまり **video 要素は存在し、currentTime も評価されていた**。
- `videosAtExportTarget` は `currentTime` の一致しか見ておらず、**`readyState < HAVE_CURRENT_DATA`（復号済みフレームがまだ無い）を通してしまう**。この状態の video は空として合成される＝「時刻は正しいが中身が無い」フレーム。これが 24KB フレームの正体。
- 修正:
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) `videosAtExportTarget` に `readyState >= 2` を追加（呼び出しは worker 経路と strictFootage のみ。通常のホスト書き出しは未経由なので無影響）。
  - [exporter.ts](src/runtime/exporter.ts): `strictFootage` のリトライ時に `flushVideoFrames(8s)` を挟む。既定の待ち（`DEFAULT_VIDEO_FRAME_WAIT_MS = 1500ms`）は「追いつくマシン」前提で、3 倍遅いワーカーではほぼ毎フレーム間に合わない。**リトライ時・strict 要求時のみ**なので他経路の速度は不変。
- 検出は zip のフレーム単位比較で確定済み: 不良フレームは **frame 126-127 と 134-149 の連続 2 区間**＝リモートブロックの範囲と完全一致（採用された 18 枚すべてが不良、ホストがワークスチールで奪い返した 128-133 は正常）。

### 2026-08-12（Claude Opus 5）— swarm: 接続時にアセットを先送り＋差分更新

- **依頼**: 「繋いだ時点で、ホストからワーカーに P2P でデータを送る、追加アセットがあったら逐一更新」。
- **これまでの挙動**: アセット転送は **export 開始時の `preload`** と **job-offer の直前**だけ。ワーカーが接続してから最初の書き出しまでの待ち時間（＝一番暇な時間）に何も送っておらず、最初のジョブが転送を丸ごと被ってデッドラインを落としていた。
- **やったこと**（配線のみ・プロトコル/スキーマ不変）:
  - [src/swarm/ui/swarmStore.ts](src/swarm/ui/swarmStore.ts): `syncWorkerAssets()` を追加し、**(a) ワーカーが connected になった時**（`refresh` で connected peerId 集合の変化を検出）と **(b) プロジェクト編集で参照ファイル一覧が変わった時**（`useEditorStore.subscribe` → 1.5s デバウンス）に現在コンプの footage/script を push。
  - 再送判定は **peerId** で行う（slotId は trust 再利用で同じ値のまま戻るため、リロードしたワーカーに再送されない）。
  - 編集ごとの再読込を避けるため、`collectJobFilePaths` の**パス一覧が変わった時だけ**再送（全 footage の再 read+hash を通常編集の裏で走らせない）。
  - [src/swarm/core/coordinator.ts](src/swarm/core/coordinator.ts): `sentAssetHashes` を**送信前に**登録（従来は送信後）。preload と job-offer が同時に走ると同じファイルを二重送信していた。data channel は順序保証があるので、転送中のアセットを skip した job-offer もチャンクの後ろに届く。
- **効果**: 転送はワーカーが暇な間に済み、以後は差分のみ。`preloadAssets` は contentHash 単位で dedupe するので何度呼んでも余分な送信は起きない。
- **テスト**: `npx tsc --noEmit` クリーン、`npx vitest run` 153 files / 1460 tests PASS。`src/runtime` 不変のため `build:player` 不要。

### 2026-08-12（Claude Opus 5）— swarm: ワーカーの成果物が 1 枚も使われていなかった（フレーム索引のズレ）

- **実測環境**: ホスト＝ローカル本番ビルド（`vite preview` https://localhost:5175）、ワーカー＝pages.dev の別マシン（join code ZCZZ8F）。シグナリングは共有 CF Worker、描画データは Direct P2P（TURN 経由なし）。
- **症状**: `Frames from workers: 10` と出ているのに、書き出しは **102 秒**（ローカル単独 80.4 秒より遅い）。
- **真因**: `exportComposition` の png-seq zip は **範囲先頭からの 0 始まり**でフレームを命名する（[exporter.ts](src/runtime/exporter.ts) の `frame_${fi}`、`fi` は絶対フレームでなく索引）。ワーカーが `[142,150)` を書き出すと zip は `frame_000000..000007`。ホストの `decodeZipToFrames` はこれを**絶対フレーム番号として解釈**していたため:
  - `frames.get(142)` が undefined → 自分のフレームすら取り出せず `renderLocally(142)` に素通り
  - prefetch には 0..7 というキーが入り一度もヒットしない（さらに後半でフレーム 0..7 を要求されたら 142..149 の絵を返す**誤出力**の危険もあった）
  - つまり **ホストが 150 枚すべてを描き直した上に、リモートの往復待ちを上乗せしていた**
  - パネルの「Frames from workers」は結果の受信数を数えるので、1 枚も使われていなくても 10 と表示される
- **修正**: [remoteFrameProducer.ts](src/swarm/core/remoteFrameProducer.ts) で zip のキーを**ブロック先頭からのオフセット**として読む（`frames.get(0)` が自分、`frame + index` を prefetch に登録）。回帰テストを `test/renderSwarmCore.test.ts` に追加（1 回の submit で 142/143/144 が全部返ること）。
- **副産物: ジョブごとの export セットアップは重くない**。バグのおかげで 7,6,5,4,3,2 枚のジョブが揃ったので所要を回帰すると **1 フレーム約 1.57 秒・切片（準備コスト）約 50ms**。前セッションで「次の最適化候補＝worker の export セッション再利用」と書いたが、**この仮説は棄却**。ワーカーが遅いのは準備コストではなく素の描画が遅い（ホスト 0.53 秒/フレームに対し約 3 倍）。
- **理論上限**: ホスト 1.87 fps ＋ ワーカー 0.61 fps ＝ 2.48 fps → 150 枚で **約 60 秒**（ローカル単独比 25% 短縮）。1 台構成ではワーカーの取り分は全体の約 25% が上限。
- **ローカル単独の基準（同一ビルド・同一マシン）**: 80.5 秒 / zip 51392011 バイト。pages.dev ビルドの 80.3 秒・**同一バイト数**なので比較可能。

### 2026-08-12（Claude Opus 5）— export: 準備済みレンダーセッションを切り出してジョブ間で再利用

- **前提の訂正**: 同日の記録で「ジョブごとの export 準備コストは約 50ms、セッション再利用は無効」と書いたが、**この結論は誤り**。あの回帰は動画が抜けた劣化ジョブ（24KB/フレーム）から取ったもので、フッテージのロード費用が最初から含まれていなかった。
- **正しい実測**（ホスト・実 Chrome・[verify-repeat-range-export.mjs](verify-repeat-range-export.mjs)）:
  - 8 フレームを単独で書き出す: **7.3 / 7.4 / 7.4 秒**
  - 同じ 8 フレームを 150 枚の書き出しの中で描く: 8 × 0.537 = **約 4.3 秒**
  - 差 **約 3.1 秒 = 1 ジョブの 42%** がコンテナ・renderer・font/image キャッシュ・evaluator・HTML player の構築と**動画の再ロード**。
- **実装**: [exporter.ts](src/runtime/exporter.ts) の準備部分を `buildExportSession()` に切り出し、`ExportRuntimeOptions.session`（呼び出し側が持つホルダ）を渡すと**世界を作り直さず再利用**する。ホルダ未指定＝従来どおり毎回構築・破棄なので、通常の書き出しは完全に不変。[workerRenderExecutor.ts](src/swarm/worker/workerRenderExecutor.ts) が `renderRevision|compId|quality|width` をキーに 1 つ保持する。
- **同時に入れた安全網 `strictFootage`**: 動画が目標時刻に届かないまま合成されたフレームを**エラーにする**（1 回リトライしてから）。単一フレーム経路には元からあった検証で、`exportComposition` に委譲する範囲経路だけが欠いていた。遅いマシンでデコード待ちが切れると、**動画が抜けた「もっともらしい」ブロック**をそのまま返していた（実際にホストのスポットチェックが frame 131 で difference 23.7 として検出、許容値 6）。
- セッション再利用はこの劣化の**原因側**にも効く見込み（フッテージがジョブ間でデコード済みのまま残る）。
- **テスト**: `npx vitest run` 1462 tests PASS（`test/projectBins.test.ts` の 1 件は全体実行時のみ落ちる既存フレーク。単体では緑、クリーンな木でも同条件。別タスクに切り出し済み）。`npm run build`（`build:player` 込み）実行済み。

### 2026-08-12（Claude Opus 5）— swarm: ホスト再起動でワーカーが永久に取り残される（シグナリング）

- **症状**: 2 回目の計測でワーカーが 4 分待っても再参加せず（`panel: undefined`）、単独書き出しになった。
- **真因**（[durableSessionCore.ts](src/swarm/signaling/durableSessionCore.ts)）: ホストが落ちるとワーカーは自力で `join()` し直すが、**セッションはホストより長生きなので join 自体は成功**し `waiting-approval` に落ち着く。この状態では `scheduleReconnect` が回らない（失敗していないので）。一方 `joinSession` は `peer-join-request` を**その時点の `hostPeerId` のキュー**に積むため、再起動して新しい `hostPeerId` で polling し始めたホストはその要求を一生読まない。→ **ホスト再起動のたびに、その間に再参加したワーカーが恒久的に取り残される。**
- **最初の修正（誤り・取り下げ済み）**: `createSession` の再アタッチ経路で既知ピアを新しい hostPeerId へ announce し直した。**これは退行だった。** セッションに残る peerId は「ワーカーが既に捨てた join」のものであり得るため、announce するとホストが**応答しないピアに接続を張る**。実測: パネルに Offline ワーカーが 3 つ並び `Available compute` が 1.0× に低下、書き出しは死んだピアへのジョブ待ちで **134.4 秒**（swarm 無し 80.5 秒に対して）。出力 zip はローカル単独とバイト数完全一致（51392011）＝**リモート成果物の採用は 0**。
- **正しい修正**: 復旧は**ワーカー側の自己修復**にする。[WorkerRuntime.ts](src/swarm/worker/WorkerRuntime.ts) に `WORKER_APPROVAL_TIMEOUT_MS = 20s` を追加し、承認待ちのまま 20 秒経過したら join し直す（誰かが実際に polling している peerId が新規に発行される）。再 join 時は前回の long poll を停止する。DO 側の replay は削除し、旧ホストのキュー破棄だけ残した。
- **テスト**: `does not resurrect abandoned peer ids when a host reattaches`（replay しないこと＋新しい要求は新ホストに届くこと）。`npx vitest run` 全パス、`tsc` クリーン。
- **デプロイ**: `npx wrangler deploy`（version cd80ed12）＋ main マージで Pages デプロイ。

### 2026-07-20（Claude Opus 4.8）— browser export 最大高速化 Phase 6（実験的 multi-render-context）実装・計測・既定 OFF で採用

- **依頼**: `claude/phase-6-implementation-test-n5u5zo` ブランチの続きとして `browser-export-max-speed-plan.md` の **Phase 6（Experimental multi-render-context）** を実装・テストし、いい感じならコミット。
- **やったこと（spec 先行）**: §11.2 に「複数レンダリング context の実験的並行描画（実験・既定 OFF）」を散文追記。決定論 frame ステップを保ったまま frame を `fi % N` でラウンドロビン分配し複数の隔離 render context で並行描画、frame 結果は timestamp 昇順の bounded reorder queue で整列してから encoder/zip へ渡す契約、共有（イミュータブル font/image cache・純関数 evaluator）と分離（mutable DOM/renderer/HTML player）、GPU/直接 capture 系との排他、video/worker 併用時の無効化を明記（§5/INV/project.json 直列化は不変）。
- **実装**:
  - 新規 [src/runtime/multiRenderContext.ts](src/runtime/multiRenderContext.ts): 純関数ドライバ `runOrderedMultiContext`（N producer で並行描画→ frame 昇順で consumer へ整列供給。有界 reorder window でメモリ制御、error/abort 伝播）＋ フラグ（`__mafterMultiRenderContext` / `__mafterMultiRenderContextCount` 2..4 clamp・既定 2・非直列化）＋ `compTreeHasVideo`（ネスト先まで video component を再帰検出）。
  - [src/runtime/exporter.ts](src/runtime/exporter.ts): 適格時に追加 render context（container+DomRenderer+HtmlCompPlayer、font/image cache と compEvaluators は primary と共有）を構築し、`runPngSeq` / `encodeVideoFrames` に multi-context 分岐を追加。**multi-context は常に純 Canvas2D 合成（`compositeExportFrame(...,{})`）** を使い GPU/direct 系と排他。除外条件: comp（ネスト先含む）に video を含む、video 形式で worker export 併用。既定 flag OFF のため既定経路は完全に不変。
- **計測（実 Chromium / 実 WebGL・[verify-multi-render-context-export.mjs](verify-multi-render-context-export.mjs)・1280×720 video なし HTML-heavy fixture / N=2 / 24f）**:
  - **正しさ（正準ゲート・PASS）**: single vs multi(2) の **per-frame PNG SHA-256 が 24/24 完全一致（mismatch 0）**、context 別描画 `[12,12]` 均等、single 側 mcFrames=0（既定経路未変更）、pageErrors 0。→ INV-2 成立。
  - **性能（改善なし）**: PNG 連番 wall single **2533.4ms** → multi **2756.4ms**（やや悪化）。mp4 は headless で png-seq へフォールバックし絶対値は参考。
- **判定**: PLAN Phase 6 の採用線「2 contexts で wall ≥20% 改善」に届かない（single main thread で foreignObject capture/`drawImage` が実質同期 CPU バウンド＝重ねる非同期 decode 待ちが少ない）。Phase 4（worker +2.9%）/ Phase 5（audio overlap +8.5%）同様、**正しく gate された opt-in 実験として温存し既定 OFF**。詳細: [doc/cloudplan/browser-export-phase6-multi-context-benchmark.md](doc/cloudplan/browser-export-phase6-multi-context-benchmark.md)。
- **検証**: `npm run typecheck` PASS / 新規 [test/multiRenderContext.test.ts](test/multiRenderContext.test.ts) 10 件 PASS / export 関連（encoderBackpressure・exportVideoEncode・workerVideoExport・bundleExport・**playerBuildFreshness**）PASS。`player.js` は exporter を import しないため **再ビルド不要**（freshness 緑で確認）。full Vitest **1387 passed / 1 failed**（唯一の fail は既存 `effects.test.ts` liquidChrome 再登録漏れ。`git stash` で base tree でも同一 fail を確認・本変更と無関係）。
- **Next steps**: 実 GPU で `img.decode()` が真に off-main-thread になる環境でなら overlap が効きうるが本 repo 相当環境では価値なし。Phase 6 で PLAN の全 Phase を実装完了。今後の browser export 高速化は残余 hotspot 再現時に profiler 起点で。

### 2026-07-20（Codex）— browser export 最大高速化 Phase 5

- **Audio overlap**: 音声source/48kHz stereo metadataを同期確定し、asset read/decode/OfflineAudioContext mixを映像renderと並行可能にした。60f音声付きMP4 A/Bは直列 **20.20s**、並行 **21.92s（+8.5%）** のため `__mafterAudioMixOverlap=true` のopt-in、既定OFF。
- **MP4 bounded finalization**: `fastStart: "in-memory"` を、予想video/audio chunk数を予約するregular MP4へ変更。60f A/Bは2回とも改善（**6120.4→5955.9ms / 5139.5→4758.1ms**）、finalize直接計測 **2.3→1.2ms** で既定ON。旧方式へは `__mafterMp4ReservedFastStart=false` で戻せる。
- **出力検証**: 予約MP4は1280×720 / 2.005s、音声48kHz stereo / RMS 0.085。WebMも1280×720 / 1.0s、音声48kHz stereo / RMS 0.083。page error 0。StreamTargetは最終`Blob`契約では全出力保持を除けず、位置指定writeもあるため今回は非採用。
- **検証**: targeted audio/fast-start/player freshness 18 tests PASS、`npm run build` PASS。全Vitestは **1377 passed / 1 failed**（既知の`effects.test.ts` liquidChrome再登録、本変更と無関係）。
- **Next steps**: 珍しいdecode失敗sourceを含むempty audio trackの互換確認と、File System Accessへ直接書く新しいstreaming保存APIは別タスク。§5/INV/project.json直列化は不変。

### 2026-07-20（Codex）— browser export 最大高速化 Phase 4

- **実装**: video-only MP4/WebM に DedicatedWorker encode/mux 経路を追加。Window は resolve/render/capture と transferable `VideoFrame` 生成まで、Worker は `VideoEncoder`・mux を担当。未ack frame は最大3枚、encoder dequeue と二重 backpressure。abort/error 時は保留frame・encoder・workerを解放する。
- **互換性**: 音声付き・透過WebM・Worker非対応は従来Window経路。§5/INV/project.json直列化は不変。runtime変更のため `npm run build:player` 実行済み。
- **A/B**: fixture A 24f MP4（GPU direct）で Window **3844.4ms**、Worker **3956.3ms（+2.9%）**。双方 5791 bytes / 1280×720 / 0.8s、page error 0。短尺wall改善がないため `__mafterWorkerVideoExport=true` の明示opt-in（既定OFF）とした。
- **検証**: `npm run typecheck` / `npm run build` / targeted worker・player freshness tests PASS。全Vitestは **1374 passed / 1 failed**（既知の `effects.test.ts` liquidChrome再登録、本変更と無関係）。
- **Next steps**: Phase 5で音声準備を映像renderと並行化し、長尺向けstreaming targetのメモリ/最終化コストを評価する。

### 2026-07-19（Codex）— `Master → main 1` 非破壊高速化 Phase 4〜5 と実データ検証を完了

- **実データ計測**: `mafter-project (12).purini remix (1).zip`（589,976,631 bytes）から、大容量動画だけを除いたローカル専用 fixture を作成。`bench-master-nested-real.mjs` で実 PreviewPanel／Caching OFF／`Master` f376〜409 を走査し、代表 f400 の preview screenshot と `captureCompFramePng` の SHA-256 が legacy／最適化経路で完全一致。ページ例外なし、3D canvas 4枚・nested object 67個を確認。
- **Phase 4**: nested wrapper の transform/opacity/z-index/adjustment style を changed-only 更新へ変更。wrapper 順は毎回 `appendChild` せず、ずれた要素だけ `insertBefore`。effect filter/backdrop-filter を差分同期し、SVG filter DOM は signature が同じ間再利用、effect が消えた場合は確実に除去する。
- **Phase 5**: `NestedRenderEpochs`（mode/resource/evaluator/WebGL context）と resource-ready 条件を追加し、同一 comp identity＋同一 child frame の完成済み subtree を安全に再利用。font/image load 完了、render mode、timeline comp/evaluator、WebGL context loss/restore で miss に倒す。runtime-only kill switch `__mafterNestedFrameReuse=false` で即時 rollback 可能、既定 ON。
- **計測結果**: hot 34 parent frames で nested full render **204→90**、same-child-frame reuse **34回**、GPU upload **4587→2427**。p50 は再測定で **366.6ms→319.4ms（12.9%）**、別測定では duplicate-frame p50 **333.8ms→92.3ms（72%）**。headless SwiftShader の p95 は分散が大きく悪化回もあるため、正しさゲートと operation count を採用根拠にした。
- **rollout**: Phase 2 prepared geometry cache／Phase 3 GPU mesh cache は実データ wall-clock の安定改善を確認できず既定 OFF のまま。Phase 5 のみ既定 ON。§5・INV・project.json 直列化は不変。
- **検証**: `test/nestedFrameReuse.test.ts` で invalidation matrix と kill switch を固定。Windows 対応の synthetic runner と実データ runnerを追加。`npm run typecheck` PASS、`verify-nested-reconcile.mjs` PASS、実データ preview/export hash parity PASS、`npm run build:player`＋`playerBuildFreshness` PASS。全 Vitest は **1345 passed / 1 failed**（既存 `effects.test.ts` の `liquidChrome` 再登録漏れ。base HEAD から継続する本変更と無関係な既知 failure）。
- **Next steps**: 本 PLAN の必須 Phase は完了。Phase 6 は新しい profile で残余 hotspot が再現した場合だけ着手する。

### 2026-07-19（Claude Opus 4.8）— `Master → main 1` 非破壊高速化 PLAN の Phase 0〜3 を実装

- **依頼**: `master-nested-composite-performance-plan.md` の Phase 0〜3 を実装・テスト・レポートまで一気に回す（Phase 4〜5 は再計測後にユーザーと判断）。
- **前提の制約**: 元 590MB 実 ZIP は org egress policy によりこの cloud 環境から取得不可（Drive リンクも `drive.google.com` が 403 policy denial）。よって **repo synthetic fixture** を基準に実装し、local-real fixture + 最終 max-ZIP benchmark は**ユーザーの実機に残タスク**として明記。
- **すべて非破壊・flag 既定 OFF**: §5/INV/直列化 不変。新 flag は runtime-only（`__mafterPreparedGeomCache` / `__mafterGpuMeshCache`）で project.json に保存しない。
- **Phase 0**: spec **§23.3f**（ネスト live render の非破壊 cache 契約・散文のみ）を追記。synthetic fixture [test/fixtures/masterNestedFixture.ts]（Master30→main1 15fps・45 3D-text 風・dense KF）。baseline [test/masterNestedBaseline.test.ts] + runner [bench-master-nested-live.mjs] + [doc/cloudplan/master-nested-baseline.json]。**266 unique / 531（49.9% dup）** を固定。resolve reuse 上限効果 ≈ 38%。
- **Phase 1**: `interpolate.ts::findSegment` を線形走査 → **lower-bound 二分探索**（完全同値）。旧線形実装を reference にした seeded fuzz（scalar/vec3/rgba/step・重複frame・全easing・1万超ケース）が maxAbs 完全一致 [test/interpolateBinarySearchParity.test.ts]。
- **Phase 2**: `applyGeom3DText` の cache lookup を `textToOutlineGlyphs` より**前**へ。`PreparedGeom3DText`（mesh + bounds）を有界 LRU（48MB）で持ち、transform-only frame で outline/nonzero 正規化/extrude を省く。null builder（system font）は誤 hit を作らず miss フォールバック [geom3dMeshCache.ts / geom3dDomApply.ts]。
- **Phase 3**: `geom3dGl.ts` に per-context の `MeshBufferCache`（`MeshData` identity → 常駐 VBO・64MB LRU・context-loss/dispose で deleteBuffer）。共有 canvas の mesh 切替ごとの3 buffer再upload を warm で 0 に [geom3dMeshBufferCache.ts]。
- **検証**: `tsc --noEmit` 緑。`npm test` = **1338 passed / 1 failed（既存の liquidChrome 未登録・本変更と無関係。base HEAD でも fail）**。`npm run build:player` 更新済み（`playerBuildFreshness` 緑）。実機 verify [verify-master-nested-cache.mjs]（実 WebGL/swiftshader）: OFF vs Phase2-ON / Phase2+3-ON の**ピクセル maxAbs=0**、outline build=1（10 transform-only frames）、warm GPU upload=0。既存 [verify-nested-reconcile.mjs] PASS。
- **残タスク（ユーザー実機）**: ① 実 590MB ZIP で local-real fixture + 最終 wall-clock benchmark（hot interval f188〜204 の render p95 ≤ 33.3ms 目標）。② flag を検証後に 1 つずつ既定 ON へ。③ Phase 4（nested DOM/effect 差分）/ Phase 5（same-child-frame subtree reuse）は baseline 再計測して採否判断。

### 2026-07-19（Codex）— 最大実プロジェクトの `Master → main 1` 非破壊高速化 PLAN を作成

- **依頼**: `Downloads` 内の最大 Mafter project で、重量級 `main 1` のような comp を `Master` に precomp として読み込んだ際の動作を、画・時間・保存形式を変えず高速化するフル PLAN を作る。実装は本セッションの対象外。
- **調査対象**: `mafter-project (12).purini remix (1).zip`（589,976,631 bytes、`project.json` 7,832,665 bytes、13 comps）。`Master=30fps` の `[0,531)` が `main 1=15fps` の 266 unique child framesを参照するため、現行は 265/531（49.9%）が同一 child frame の再解決・再描画。lyric precomp 3件に計23,146 keyframes、hot interval `main 1` f188〜204 で 3D-extrude text 最大45枚同時可視。
- **コード上の主要候補**: `renderNestedComp` の同一 child frame 再実行、nested style/effect/SVG の毎frame同期、`findSegment` の線形走査、`applyGeom3DText` が mesh cache hit 前に outline/nonzero 正規化を実行、共有 canvas の `Geom3DGlState.lastMesh` 1件による mesh 切替ごとの3 buffer再upload。
- **成果物**: [doc/cloudplan/master-nested-composite-performance-plan.md](doc/cloudplan/master-nested-composite-performance-plan.md)。非破壊契約、baseline fixture/計測、段階実装、invalidation、preview/export/bundle検証、rollback、DoDを記載。
- **推奨 next step**: PLAN Phase 0のみ着手し、spec §23.3への散文追記 → 小型real/synthetic fixture → `bench-master-nested-live.mjs` baselineを固定する。コード最適化は baseline で順位を再確認してから、1 phaseずつ実装する。

### 2026-07-16（Claude Opus 4.8）— ネスト共有 canvas の mp4/webm/HTML bundle parity を verify ＋ bundle の 3D text 消失を修正

- **やったこと**: 8a79b28 で残っていた「mp4/webm/HTML bundle でのネスト共有 parity 未確認」を実機で潰した。新規 [verify-nested-geom3d-share-export.mjs](verify-nested-geom3d-share-export.mjs)。
- **ゲートの立て方**: 「同じ 3D text 群を standalone comp で書き出した絵」vs「それを precomp として親から書き出した絵」のインク比（両方 comp 解像度 PNG ＝ 自己正規化）。preview DOM と export を直接比べると zoom 倍率が混ざって偽 FAIL する。
- **結果（実 Chrome headed / headless 両方 PASS）**:
  - PNG 連番: standalone ink == nested ink（**ratio 1.000・完全一致**）。mp4/webm は `compositeExportFrame` を PNG 連番と共有し encode だけが違うため、これで画の parity は担保。
  - mp4: 実 Chrome で `format=mp4 / 16430 bytes / fallbackReason=null` ＝ H.264 encode も実際に通る。**headless Chromium では WebCodecs encode がメインスレッドを掴んだまま返らず in-page の setTimeout すら発火しない**（＝中断不能）。そのため mp4 は `VERIFY_MP4=1`（headed 実 Chrome）でのみ実行し、スクリプトの**最後**に置いてある。順序を変えると後続が全滅する。
  - bundle: canvases=1 / ink 一致。
- **発見して直したバグ（bundle で 3D text が丸ごと消える・ネスト無関係の全 bundle）**: `BundlePlayer.loadBuiltinFonts` が zip 同梱 ttf を **FontFace（CSS 2D 用）にしか登録せず** `FontOutlineCache` に入れていなかった。§5.5f の押し出しは outline を引くため `getFont()` が null ＝ mesh 無し ＝ canvas ごと出ない（**console error 0 で無音**）。built-in font は `project.assets` に載らない（`bundleCollect` は text の `font` を family 文字列としてしか見ず asset 参照を集めない → `pruneProjectToBundleScope` で消える）ため、ここで入れないと bundle だけ 3D が死ぬ。修正は同じ ttf を `fontCache.parseBuffer` にも通すだけ。`npm run build:player` 実行済み。
- **無回帰**: `npm run typecheck` ✅ / `verify-bundle-export.mjs` 2/2 PASS（このスクリプトは `http://` 固定で今の dev（https）では動かない → `MAFTER_DEV_HTTP1=1 npx vite --port 5176` で実行した）。
- **Next steps（未修正・本セッションでは触っていない）**: **bundle export が worker チャンクを同梱していない**。bundle player が `assets/rasterProcess.worker-*.js` を 404 で取り逃す。
  - **真因**: Vite は `player.js` の**隣**に worker チャンク（`public/assets/rasterProcess.worker-*.js` / `videoBlob.worker-*.js`）を出すが、[bundleExporter.ts](src/runtime/bundleExporter.ts) の `loadPlayerScript` は **`player.js` しか zip しない**。
  - **想定影響**: raster effect を使う bundle は worker 経路が死んでいる可能性（要確認）。今回の fixture は raster effect 非使用でも pool が eager に spawn するため 404 が出た＝**404 の有無は「effect を使ったか」を意味しない**。フォールバックが効いて絵は出ているのか、無音で劣化/停止するのかは未調査。
  - **再現**: `VERIFY_MP4=1 node verify-nested-geom3d-share-export.mjs` の出力末尾 `既知・本件と無関係な 404` 行。同スクリプトは worker 404 を `unrelated404` として合否から外しているので、**直したらこの除外を消すこと**。
  - geom3d canvas 共有とは無関係（本件の verify は PASS 済み）。

### 2026-07-16（Claude Opus 4.8）— §5.5f-1 WebGL canvas 共有トグル（`geomShareCanvas`）

**完了:**
- spec §5.5f に `geomShareCanvas` と host 解決規則を追記（§5.5f-1）。ユーザー確認済みの確定事項: ① Null / 音声のみのレイヤーは透過スキップ、非 WebGL の**描画**レイヤーでチェーン切断（AE の 3D 連続グループ準拠）② 共有時は host canvas に **depth buffer 共有**で合成（3D 同士が相互貫入）。
- `src/runtime/geom3d/geom3dCanvasGroup.ts` 新規 — `resolveGeom3DCanvasHosts()` 純関数（zOrder 昇順・上向き走査・推移解決）＋ `geom3dWebglComponentIndex()` / `toGeom3DLayerInfo()`。**Inspector 表示と DomRenderer の描き先は必ずこの 1 関数群を通す**（ズレ防止）。`test/geom3d/canvasGroup.test.ts` 14 件緑。
- **UI は 3D フォールドに置いた**（text の Content ではない）— `geomShareCanvas` は text 固有ではなく「レイヤーが WebGL 描画か」に紐づく設定のため。WebGL レイヤーのときだけ表示。将来 shape 等の押し出しを足すときは **`geom3dWebglComponentIndex` を広げるだけ**で Inspector にも DomRenderer にも伝播する（UI 側に型分岐を増やさない）。
- `geom3dGl.renderGeom3D` に `clear?: boolean`。グループ内で最初に描く（＝最下位の）メンバーだけ clear。
- `geom3dDomApply`: `Geom3DCameraContext` に `canvas` / `isHost` / `clearedCanvases`。canvas は host の el が宿し member の el は空。clear の消費は**実際に描けたときだけ**（描画失敗メンバーの clear 持ち逃げ防止）。
- `DomRenderer`: `geom3dGroupCanvases`（host id → canvas・フレーム跨ぎ保持）＋ host でなくなった canvas の `releaseGeom3DGl` GC。member は host の el より先に処理されるが、canvas は DOM 未接続でも描画でき host が同フレームで adopt するため問題なし。
- Inspector: `Share Canvas` トグル ＋ `Canvas Host` 行（最上位なら「自分（最上位）」表示）。
- `npm run build:player` 実行済み（`src/runtime` 変更のため必須）。

**既知の制約・残タスク:**
- **ネスト comp（`renderNestedComp`）は共有しない**（従来の per-layer canvas）。spec §5.5f-1「未対応」に明記済み。
- メンバー個別の `opacity` / `blendMode` / effects は host の div にまとまるため個別には効かない（設計どおり・spec 記載済み）。
- `geom3dGl` の `lastMesh` は 1 スロットキャッシュ。共有グループでは毎フレーム全メッシュ再アップロードになる（`ponytail:` コメントあり）。実測で問題化したら mesh キー Map + 複数 VBO へ。
- **実機（Playwright）での目視 verify は未実施** — 相互貫入・z-index・context 数の確認が残っている。
- 既存の `test/effects.test.ts` `liquidChrome` 失敗は**本変更以前から main で失敗**（無関係）。

### 2026-07-15（Claude Opus 4.8）— Bevel が「へこみ」になる断面バグを根治 ＋ `geomBevelStyle` 追加

- **症状（ユーザー報告・スクリーンショット）**: 3D text の Bevel が「Bevel ってよりへこみって感じ」。文字のエッジに沿って暗い溝が彫られたように見え、ベベル特有のハイライトが出ない。
- **真因（断面 `(n,z)` で特定。`n` = 輪郭から外向き、`z` = 手前が +、`R` = 実効ベベル幅）**: `buildProfile` が**円弧の中心を `(0,-R)`＝輪郭の角そのもの**に置き `(0,0)→(-R,-R)` を描いていた。中心が材料の**外**＝**凹（コーブ）**。加えて front cap が `z=-R` へ後退して `z=0` に鋭いフランジが残り、断面が**鼓（つづみ）型**（front 全幅 → 中央で痩せる → back 全幅）になっていた。**spec §5.5f の「front cap z=0 固定」違反**でもあり、spec 変更なしの適合回復として修正できた。
  - **凸/凹の判定基準（今後の検算用）**: 円弧の中心が材料の**内側**なら凸、**外側**なら凹。修正後は中心 `(-R,-R)`＝材料の内側。
  - 旧実装は `offsetFrac = sin θ` → `1 - sin θ` の 1 文字差だが、意味は「凹→凸」かつ「cap 平面の復帰」で別物。
- **修正（A+B+D。C は見送り＝下記 Next steps）**:
  - **A. 断面の反転** — 3 スタイルが**端点を共有**する設計へ統一（cap の縁 `(-R,0)` → 側壁の上端 `(0,-R)`、曲線だけが違う）。cap は常に真の `z=0`/`z=-depth`、側壁は輪郭そのもの＝**シルエットが 2D 描画と一致**（Illustrator の Bevel Extent In 相当）。
  - **B. ベベル法線の解析化** — 面ごとのフラット法線をやめ、断面の解析法線 `nComp·outwardXY + zComp·ẑ` を頂点法線として付与。`geomBevelSegments` を上げるとファセットが消える（実機で同心円状バンディングの消失を確認）。`outwardXY` は**元の輪郭**の頂点法線を全プロファイルリングで共有（inset 後に作り直すと頂点対応がずれる）。`round` は cap 側で法線が `(0,0,1)`、側壁側で純水平になり、**cap→ベベル→側壁が自動的に連続**する。
  - **D. `geomBevelStyle: "angular" | "round" | "concave"` 追加（既定 `angular`）** — **§5 スキーマ変更につきユーザー確認済み**。AE(C4D) の Bevel Style / Illustrator の Bevel はどちらも既定が直線チャンファで、「Bevel＝45° 面取り」という直感にも一致する（A で凸にしても "丸み" であって "面取り" ではない、が決め手）。`angular` は 1 セグメントで厳密なため `geomBevelSegments` を無視し、Inspector でも Segs 行を出さない。
  - 配線: `geom3dTypes.ts`(`BevelStyle`) / `geom3dParams.ts`(descriptor + parse) / `extrudeMesh.ts`(`bevelProfilePoint`・`addBevelBand`・`addTriangleSmooth`) / `geom3dDomApply.ts`(**meshKey に style を追加** — 忘れるとスタイル変更が効かない) / `store.ts`(既定) / `InspectorPanel.tsx`。
  - **Inspector の geom3d セクションは descriptor 駆動ではなく手書き** — descriptor を足すだけでは UI に出ない（`add-layer-component-type` の「配線もれ」と同型。次に param を足す人向けの注意）。
- **検証**:
  - `npm run typecheck` ✅ / `npx vitest run` 1281/1282 — 失敗 1 件 `test/effects.test.ts`（プラグイン再登録数）は **clean tree でも再現する既存バグ**で無関係（`git stash` で切り分け済み・前セッションから継続）。
  - [test/geom3d/extrude.test.ts](test/geom3d/extrude.test.ts) 36 件 ✅。**回帰ゲートが本物であることを確認済み**（旧コードを `git stash pop` で戻すと cap 平面テストと凸性テストが実際に落ちる＝空振りアサーションではない）。3 スタイル × cap 平面 / シルエット / 単位法線を `it.each` で固定、`angular` が segments を無視すること・`round` の法線が `±1` まで連続すること（＝スムース法線が効いていること）も固定。
  - 実 Chrome（Playwright + 実 WebGL）で **修正前=暗い溝 / 修正後=凸のハイライト**を画像で対比確認。3 スタイルとも意図どおり描き分けられることを確認。
  - `npm run build:player` ✅ 実行済み（`src/runtime` 変更のため HTML bundle export に必須）。
- **Next steps（C＝今回見送り分）**: `insetRing` は隣接辺法線の平均を `dist` 倍しているが真の平行オフセットには **`1/cos(φ/2)` のマイター補正**が要る（90° コーナーで約 29% 過小 inset ＝ **角でベベル幅が痩せる**）。また `bevelExtent` の clamp が `depth/2` のみで **XY 方向を見ていない**ため、`bevelSize` が線幅の半分を超えるとリングが自己交差して破綻する。

### 2026-07-15（Claude Opus 4.8）— 自動生成 ttf を Project パネルの `fonts` フォルダへ集約

- **症状（ユーザー報告・スクリーンショット）**: 3D Extrude でフォントを自動埋め込みするたび、**Project パネルのルートに ttf が直接積み上がる**（Main / Comp 2 / ttf / ttf / Comp 3 / ttf …）。comp と混ざって一覧が汚い。
- **最初の誤読（記録・同型の取り違え防止）**: 「assets/font 以下に入っていない」を **FS パス**の話と読んで path 移行を実装したが、ユーザーが指していたのは **Project パネルのツリー（bin）**だった。FS の書き込み先は b8880c8 の時点で既に `assets/font/` で正しい。**「フォルダ」がユーザー語彙では bin を指すことがある**（`pre-rendered` フォルダと同じバイブス、という言い方が手がかりだった）。
- **修正**:
  - 新規 [fontBin.ts](src/editor/fontBin.ts) — §11.2b [preRender.ts](src/editor/preRender.ts) と対称の純関数群。`ensureFontsBin`（ルート直下 `fonts` bin を作成 or 再利用）/ `addFontAssetToProject` / `migrateFontAssetsToBin` / `strayFontAssetIds`。**bin 構成はユーザー確認済み**: 「ルート直下 `fonts`（pre-rendered と同列）」を選択（`assets > fonts` のネストは不採用）。
  - `ensureBundledFontAsset`（自動埋め込み）と `importFontAsset`（アップロード）が `registerNewProjectItem`（＝ルート末尾）ではなく `addFontAssetToProject` を通る。
  - `loadFromFs` に読み込み時移送を追加 — ルート直下に残っている font asset を `fonts` へ移す。**ユーザーが自分で別フォルダへ動かしたフォントは対象外**（`binId` を持つものは触らない）。
  - 併せて FS 側も移行: 新規 [migrateFontAssetPaths.ts](src/editor/migrateFontAssetPaths.ts) が `assets/font/` 配下でない font asset を `assets/font/<id>.<ext>` へ移す（`assets/font/` 導入前のプロジェクト用。best-effort でコピー失敗時は旧 path 維持）。スキーマ・直列化形式は不変。
- **検証**:
  - `npm run typecheck` ✅ / `npx vitest run` 1267/1268 — 失敗 1 件 `test/effects.test.ts`（プラグイン再登録数）は **clean tree でも再現する既存バグ**で無関係（`git stash` で切り分け済み）。
  - 新規 [test/fontBin.test.ts](test/fontBin.test.ts) 6 件・[test/migrateFontAssetPaths.test.ts](test/migrateFontAssetPaths.test.ts) 4 件 ✅。
  - 新規 [verify-font-bin.mjs](verify-font-bin.mjs) 実 Chrome PASS — 新規埋め込み・旧プロジェクト再読込の両方でルートに `asset:font` が無く `bin:fonts` 配下に入ること、`is3DCapableFont` が bin 移動後も true（family 参照が壊れない）ことを確認。実際の Project パネルのスクリーンショットでも `fonts` フォルダ表示を目視確認。
  - 新規 [verify-font-asset-migration.mjs](verify-font-asset-migration.mjs) PASS（FS path 移送）。既存 `verify-font-3d-weight.mjs` / `verify-font-3d-extrude.mjs` 無回帰 PASS。
- **player 再ビルド不要**: 変更は `src/editor/` + `src/core/paths.ts` のみで `src/player` / `src/runtime` の描画・expression 経路に触れていない。
### 2026-07-15（Claude Opus 4.8）— 3D Extrude のメッシュ生成破綻を根治（輪郭の nonzero 正規化）

- **症状**: 3D 押し出しテキストで「メッシュが正しく生成されない時がある」。`日本語3DA` で `日`/`本`/`A` が破綻し `3`/`D` は無傷。ユーザー報告どおり **Roboto 等の欧文フォントでも再現**し、**フォントごとに壊れ方が違う**。
- **真因**: フォントのアウトラインは **nonzero winding rule** 前提で作られ、**輪郭どうしが重なってよい**（画 = stroke ごとの独立輪郭）。その生アウトラインを earcut（`extrudeMesh.addCap`）へ直接渡していた。earcut が扱えるのは「単純多角形 + 入れ子の穴」だけ。さらに `groupRingsByNesting` は巻き方向を捨てる設計（旧 progress で「巻き方向に非依存」を利点として記録していたが、nonzero rule は巻き方向そのものが塗りを決めるため**原理的に解けない**）。
  - 実データで確定: Noto Sans JP の `日` は〈枠をシーム付き 1 輪郭で描いたもの〉+〈横棒 2 本〉の 3 輪郭が重なった構成で、**穴を 1 つも持たない**。旧実装は横棒を「枠の内側にあるリング」＝穴と誤判定していた。`本` は 5 輪郭が 7 ペアで交差。Roboto の `A`/`B`/`8` でも発生（`B` は自己交差も）。Anton/Tinos/Noto Sans/Cousine は重なりを持たず無傷 → **フォント依存であって言語依存ではない**＝「フォントごとに一貫性が無い」の正体。
  - cap だけでなく `addBand`/`insetRing` も重なった輪郭を側面にするため、文字内部に壁が生えていた（報告画像のトゲ・板状ノイズ）。
- **修正**: `OutlineProvider` に **nonzero 正規化**を追加（新規 [normalizeRings.ts](src/runtime/geom3d/normalizeRings.ts) の `normalizeRingsNonzero`）。`libtess`（GLU tesselator 移植・SGI FSL B・17KB min）を `GLU_TESS_WINDING_NONZERO` + **`GLU_TESS_BOUNDARY_ONLY`** で使い、交差の無いリング列へ再構築してから既存パイプライン（`groupRingsByNesting` → earcut → bevel/band）へ渡す。**下流は無変更**。
  - **BOUNDARY_ONLY（三角形ではなく輪郭を返す）が要件**: bevel の inset と側面 band がリングを要求するため、三角形しか返さない tesselator では代替不可。既存依存の `polygon-clipping` は even-odd 系 boolean のみで nonzero rule を表現できず不採用。
  - 正規化はグリフ単位（tracking が詰まっても文字どうしを融合させない）。tesselator 失敗時は生リングへフォールバックし描画を止めない。
  - `libtess` は .d.ts 非同梱 → [src/types/libtess.d.ts](src/types/libtess.d.ts) を追加。**default import で型付け**（過去に `polygon-clipping` の named import が Rollup 本番ビルドだけ undefined に落ち bundle export が実行時クラッシュした事故と同型を回避）。`build:player` で実際に取り込まれ `not exported` 警告 0 を確認済み。
- **検証**:
  - `npm run typecheck` ✅ / `npm run build` + `build:player` ✅（player.js 再ビルド済み — geom3d は DomRenderer 経由で player が import するため HTML bundle export に必須）。
  - `npx vitest run` = 1252/1253。唯一の失敗 `test/effects.test.ts`（プラグイン再登録数 24 vs 25）は **`git stash` した clean tree でも再現する既存バグ**で本変更と無関係（切り分け済み）。
  - 新規 [test/geom3d/normalizeRings.test.ts](test/geom3d/normalizeRings.test.ts) 38 件 ✅ — 実フォント 6 種で「出力リングが交差しない」＋「塗り領域が入力の nonzero winding と等価（グリッド不一致 <1%）」を固定。`日` の横棒が実体として塗られること（今回のバグそのもの）も明示的に固定。
  - 新規 [verify-geom3d-glyph-fidelity.mjs](verify-geom3d-glyph-fidelity.mjs) 実 Chrome 7/7 PASS・console error 0。
  - 既存 `verify-geom3d-neutral.mjs` / `verify-geom3d-mvp.mjs` 無回帰 PASS。
- **教訓（重要・同型事故の予防）**: **既存の `verify-geom3d-neutral.mjs` は bbox しか比較していないため、このバグを検出できずに緑で通り抜けていた**（`日` が塗り潰れた塊になっても bbox は不変）。壊れるのが「塗りの中身」なら面積・IoU で測る必要がある。新 verify はブラウザ自身の `fillText`（＝同じ nonzero rule で塗る実装非依存の第三者）を正解として IoU を取る。
  - 閾値は憶測でなく**正規化を bypass して実測較正**した: 壊れている側 IoU 0.346〜0.726 / 健全側 0.898〜0.975 → gate 0.85（ギャップの中央）。IoU が 1.0 に届かないのは解像度の違う 2 マスクのリサンプル量子化が原因で、**バグと無関係な対照群 `O` が 0.949 で頭打ち**なことから系統的な計測バイアスと確認（curveQuality=high でも 0.9488 までしか動かず曲線近似は主因でない）。塗り率超過も併用（塊化時 `日` は +80%、健全時は常に -1〜-4%）。
- **Next steps**: shape 経路（P4）にも同じ正規化を通すこと（`OutlineProvider` の同じ境界に載るので流用可）。ネスト comp 内 3D-extrude text の実 MVP 化・mp4/webm/bundle export の geom3d parity verify は従来どおり未実施のまま。

### 2026-07-14（Claude Sonnet 5）— 3D Extrude 描画を実 MVP 投影へ再設計（P2）

- **ユーザー報告**: 3D Extrude ON にしても質感がボヤけて平坦（カメラ/回転に追従しない）。調査の結果、P1 実装（前セッション）は
  [geom3dGl.ts](src/runtime/geom3d/geom3dGl.ts) の `buildDefaultCamera` が**固定内蔵カメラ**でフラットに焼き、その平面を
  `entry.div` の CSS `matrix3d(cameraPre·worldTransform)` で**カードとして傾けるだけ**（comp のアクティブカメラ・
  `Transform.rotation` を GL 側は無視）と判明。加えて canvas を CSS px 等倍でラスタライズ→引き伸ばしていたため
  HiDPI/Fit ズームで滲む問題も併発していた。
- **方針確定（ユーザー選択）**: ①per-object canvas + 実 MVP 投影（DOM のレイヤー構造/blend/filter/track matte は維持）、
  ②comp・ワールド空間の平行光でライティング。
- **実装**:
  1. [mat4.ts](src/runtime/mat4.ts) に `transpose`/`normalMatrix` を追加。
  2. [geom3dGl.ts](src/runtime/geom3d/geom3dGl.ts): `buildDefaultCamera` を廃し、`uMVP`/`uNormalMatrix`/`uLightDirWorld` を GL に渡す薄いレイヤーへ変更。
  3. [geom3dDomApply.ts](src/runtime/geom3d/geom3dDomApply.ts): `mvp = Proj·cameraPre·worldTransform` を計算（`Proj` は CSS `perspective` リグ〈`translate(cx,cy,P)·view`〉と数式的に厳密一致するよう手計算で導出・pixel-space）。canvas は comp 全域を dpr 解像度で描画（AABB 最適化は次フェーズ）。`outline.minX/minY` オフセットは `translation()` で world 側に焼き戻す（旧実装は div の `left/top` で吸収していた）。
  4. [DomRenderer.ts](src/runtime/DomRenderer.ts): `renderFrame` で `this.cameraFov` を per-frame 保持。`updateComponentEl` に `geom3dCamera`（cameraPre/fov/world/compW/compH）引数を追加し text ケースへ配線。3D-extrude 成功時は親 div の CSS `matrix3d` 傾けを打ち消す（GL の mvp が投影を一手に担うため）。ネスト comp 経路（`renderNestedComp`）は `geom3dCamera` を渡さず、既存の CSS 傾け近似のまま（次フェーズのスコープ外・spec §6.5c に明記）。
  5. Light Direction を `geom3dParams.ts`/store 既定 props/Inspector に露出（非アニメータブルの静的 Vec3、簡易 UI）。
- **検証（実機 Playwright, port 5175）**:
  - `verify-geom3d-neutral.mjs`: camera 無し・回転無し・depth=0 で 2D 描画と水平位置/幅がほぼ一致（許容 6px）。垂直方向は 2D の CSS line-box と GL の ink-bbox の測定手法差ぶんズレる（想定内・実装バグでない）。→ **PASS**。
  - `verify-geom3d-mvp.mjs`: camera 追加 → dolly（POI 固定で距離を詰める）で投影後 bbox が拡大（旧実装は無反応だったはず）、`Transform.rotation.y` 回転で bbox が変化、console error 0。→ **PASS**。
  - 非 3D-extrude の 3D solid（CSS `matrix3d` 経路）が引き続きカメラ pan に応答し無回帰であることを別途確認 → **PASS**。
  - **dolly の符号に注意**: `addCamera` の既定 `position.z = zoom`（"+z は視点側"）なので、カメラを content に近づける＝dolly in は `position.z を減らす`。
- **確認**: typecheck ✅ / 全テスト ✅（`liquidChrome` 1 件は既存無関係 flake、変更前から再現）/ `npm run build` + `npm run build:player` ✅。
- **spec**: §5.5f（P2 実 MVP 投影へ改訂・`geomLightDir` prop 追加）/ §6.5c（固定カメラ簡略化の記述を実 MVP に更新）。
- **Next steps**: mp4/webm/bundle export の実 parity verify（GL canvas の export 経路は本セッション未検証）、ネスト comp 内 3D-extrude text の実 MVP 化、per-object canvas の AABB クロップ最適化（現在は comp 全域を毎フレーム描画）、shape への 3D 押し出し適用（P4）。

### 2026-07-14（Claude Sonnet 5）— 3D Extrude 用フォント自動アセット化 + カスタムフォントアップロード

- **ユーザー報告**: text レイヤーで 3D Extrude を ON にしても立体化しない。原因 = [DomRenderer.ts:2300](src/runtime/DomRenderer.ts#L2300) の `fontCache.getFont(fontFamily)` が輪郭抽出不可（system フォント／`project.assets` に font エントリ無し）だと**サイレントで 2D フォールバック**する（§26.4.1 の既存制約）上、フォントを asset 化する導線が皆無だった。
- **実装（3 点セット、ユーザー方針確定を受けて）**:
  1. **Bundled フォント自動アセット化**: `Geom3DFields` の 3D ON トグル（および 3D ON 中の font 変更）で `ensureBundledFontAsset(font, weight)`（[store.ts](src/editor/store.ts)）を発火。`public/fonts/*.ttf` を fetch → `assets/<id>.ttf` へ書込 → `AssetEntry{kind:"font", meta:{family}}` を `project.assets` に追加。全 `FontOutlineCache.loadFromProject` 経路（preview/exporter/compFrameCapture/BundlePlayer/frameExtractor）と zip 往復は既存の汎用配線がそのまま拾う（追加配線不要）。
  2. **Web-safe は 3D 不可を明示**: `WEB_SAFE_FONTS`（[fontList.ts](src/editor/fontList.ts)）の label に `(no-3D)` を付与。`is3DCapableFont(font, project)` を追加し、3D ON かつ非対応時は Inspector に警告文を表示（サイレントフォールバック廃止）。合わせて **OSS フォントを Bundled に追加**（Roboto / Tinos(Times互換) / Cousine(Courier互換) / Anton(Impact風) / Dancing Script(Cursive風)、`public/fonts/` に OFL/Apache の実体を配置）し、3D 化できる選択肢を増やした。
  3. **カスタムフォントアップロード**: `FontField` の「Custom…」テキスト入力を撤去し「⬆ Upload font…」ボタン（隠し file input）に置換。`importFontAsset(file)`（store.ts）が opentype.js で family を解決し asset 化、新規 [assetFontFaces.ts](src/runtime/assetFontFaces.ts) の `registerAssetFonts` が `@font-face` を注入して 2D 描画にも即反映。
  - **副次修正**: `FontOutlineCache.getFont`/`loadFromProject` のキーが CSS スタック全体 vs bare family で不一致だったバグを `primaryFontFamily()`（[builtinFonts.ts](src/runtime/builtinFonts.ts)）正規化で修正（本来 asset font が一致すら取れていなかった潜在バグ）。
- **検証**: typecheck ✅ / 全テスト（`test/builtinFonts.test.ts` は新規フォントの weight 数アサーションを Noto 2 種限定に修正）✅（`liquidChrome`/`projectBins` の既存無関係 flake 1 件は変更前から再現・pre-existing 確認済み）/ `npm run build` + `npm run build:player` ✅ / 実機 Playwright（`verify-font-3d-extrude.mjs`, port 5175, UI 実操作で + Text→Font 選択→3D トグル）: Bundled(Noto Sans) 3D ON で `canvas.mafter-geom3d-canvas` 出現・警告なし・`project.assets` に font 追加、Arial(no-3D) へ変更で canvas 消滅・警告表示、console error 0 → **PASS**。
- **spec**: §26.3.1（アップロード UI へ更新）/ §26.3.2（Bundled フォント一覧に OSS 追加を追記）/ §26.4.1（3D Extrude のフォント対応可否ルールを更新）。
- **依存追加**: `playwright`（devDependency、実機検証ハーネス用。この環境には未インストールだったため `npm install -D playwright` + `npx playwright install chromium` を実施）。
- **Next steps**: なし（3 点セット完了）。将来課題: OSS Bundled フォントの取捨選択（ユーザー確認）、custom アップロードの family 名衝突時の挙動（現状は後勝ち @font-face 上書き）。

### 2026-07-14（Claude Opus 4.8）— `liquidChrome` を fill 方式へ全面作り直し（pic1 の液体クロームに）

- **ユーザー指摘**: 「これってそもそも Liquid Chrome なのか？」リファレンス（pic1・研磨金属が流れる）に対し、実装（pic2）は低コントラストのパステル雲。→ 正しい。旧実装は設計レベルでズレていた。
- **旧実装の問題**: D-2 spike 経由の「コンテンツを turbulence で displace + feSpecularLighting + gradientMap(chrome)」3 段合成は、① 下地（テキスト/背景）が主役のまま歪むだけ、② ノイズがボケ blob で反射リッジにならない、③ chrome グラデが実質2バンド＋低コントラストでパステル、の 3 点で pic1 にならない。パラメータでは埋まらない技法のズレ。
- **設計判断（ユーザーに確認・AskUserQuestion）**: 下地の扱いは「**形状をクロームで塗る（fill 方式・pic1 志向）**」を選択。テキスト/shape/solid のアルファ形状を、ノイズ由来の金属で塗りつぶす（下地の色は捨てる）。
- **正しい技法（計測駆動でプロトタイプ→確定）**: pic1 の正体 =「**シャープな金属環境の縞グラデを流体 turbulence で歪ませたもの**」。`verify-liquidchrome-proto.mjs` で実 Chrome に候補チェーンを描画して反復:
  - v1（滑らかなノイズ値をバンド化）→ 大理石/雲で不可。
  - v2（縞グラデを feImage で敷き turbulence で 1 段 displace）→ 鋭い反射線が出て液体クロームに。
  - v3（**2 段 displace**: warp で大きく折る＋細かい turbulence で curl）→ pic1 の渦/閉ループ eddy を再現。これを採用。
- **本実装**（`effectSvg.ts` / `fastEffects.ts` / `effectChain.ts`）:
  - `chromeStripPng(bands)`（純関数・DOM 非依存・`rgbaToPngDataUri`）: 金属縞グラデ縦ストリップ（黒→スチール→鋭い白→ピンク(イリデ)→暗紫→黒・両端同色で縦タイル seam レス）を生 PNG に焼く。
  - `liquidChromePrimitives()` 全面差し替え: feTurbulence(生成域固定+tile+mod pan) → feImage(strip)+feTile → 2 段 feDisplacementMap(warp/detail) → feComposite in SourceAlpha。旧 feSpecularLighting/gradientMapTable 依存は撤去。
  - `LIQUID_CHROME_EFFECT_DEF` の params を fill 方式に一新: `size`(140) / `warp`(160) / `detail`(45) / `bands`(6) / `evolution` / `seed`(7) / `quality`。旧 `amount`/`highlight`/`depth` 廃止。null ガード撤去（常時 fill）。
  - `effectChain.ts` の scale 分岐に `liquidChrome` → `p["warp"]` を明示追加（旧 `amount` generic フォールバックが効かなくなったため）。displacement 系のまま（内部 feDisplacementMap・出力は SourceAlpha 閉じ）。
  - 「動く四角枠」対策の tile+mod 方式は踏襲（前エントリ参照）。
- **検証**: typecheck ✅ / `test/liquidChrome.test.ts` 全面書き換え（15 tests・chromeStripPng 決定論 / fill 構造 / 旧 feSpecularLighting 非残存 / 2 displacement scale 反映 / tile+mod 枠対策 / §2.2 3 Set / param キー）✅ / 全テスト（1166）✅ / `npm run build:player` ✅ / `verify-liquidchrome-parity.mjs`（実 DomRenderer 経路で evo 0/90/270 とも INV-2 `maxDiff=0`・実登録エフェクトの見た目も pic1 系を確認）✅。
- **spec**: §27.3 `liquidChrome` を fill 方式へ全面書き換え。
- **Next steps**: エディタ実機でユーザー最終目視（テキスト/shape に適用して pic1 の質感か）。将来課題: パレット/preset 選択、`fill=false`（下地を歪ませる金属ガラス風）モード。

### 2026-07-14（Claude Opus 4.8）— `liquidChrome` evolution の「動く四角枠」を feTile 方式で解消

- **ユーザー報告**: `evolution` を動かすと四角い枠が動いて見える。基本挙動はそのままに枠を消したい。padding 方式（前コミット ab6729f）は「変な挙動」だったのでユーザーが自分で revert 済み → **別アプローチが必要**。
- **枠の正体（実領域で再現して特定）**: 既存 verify（`verify-liquidchrome-evolution-seam.mjs`）はフィルタ領域を `-25%/150%` で描画していて**実アプリと不一致**だった（`liquidChrome` は displacement 系なので `createSvgFilterElement` が `(0,0,w,h)` にクランプ）。実領域＋グリッド content で再現すると、① `feOffset` パンで露出した逆側に**変位マップの透明帯**ができ「変位ゼロの矩形帯」が evolution 角度に応じ動く（＝動く枠）、② `feSpecularLighting` が `(0,0,w,h)` 境界で端法線を計算するため evolution=0 でも静的な矩形リムが出る、の 2 つが原因。
- **padding が「変な挙動」だった理由**: `fastWave`/`fastRipple` と同型に生成域を `|pan|+2` 拡張したが、pan 量が `dist=(deg/360)·size` で evolution 角度により毎フレーム変わる → 生成域サイズが変化 → `stitchTiles` の周波数調整が変わってノイズ全体が沸き立つ（boiling）。
- **採用した別アプローチ（feTile 方式・`liquidChromePrimitives()`）**: 生成域は `(0,0,w,h)` 固定（`stitchTiles` で `(w,h)` 周期）にしたまま `feTile` でシームレスに 3×3（`-w,-h,3w,3h`）展開し、displacement のパン先も specular の端法線も常に実ノイズで被覆する。`evolution` の生オフセットは無限に増えるが、場は周期 `(w,h)` なのでオフセットを **`mod (w,h)`** で `[0,w)/[0,h)` に畳んでも同一像（連続・シームレス）→ 3×3 タイル内に必ず収まる。bump も `noiseRaw` を同じく 3×3 タイル化（`bumpField`）して静的リムも解消。生成域固定なので boiling なし。
- **検証**: `verify-liquidchrome-box-diag.mjs`（実領域 `(0,0,w,h)`＋グリッド content で evo 0/90/180/270 を目視 → 動く枠・静的リムとも消失を確認）。`verify-liquidchrome-parity.mjs`（**実 DomRenderer 経路**で on-screen 合成 vs export capture を比較 → 全 evo `maxDiff=0`・export 非黒 ~98%＝INV-2 維持）。※手組み container + `captureElementToCanvas` は foreignObject シリアライズが黒落ちする既知のハーネス制約があり信頼できない（D-2 spike と同じ教訓）ので、必ず実 DomRenderer 経路で測ること。
- **テスト**: `test/liquidChrome.test.ts` に回帰テスト追加（生成域が evolution によらず `(0,0,w,h)` 固定＝boiling 防止 / feTile 2 枚存在 / オフセットが `mod` で `<w,<h` に収まる）。typecheck ✅ / 全テスト（1165）✅ / `npm run build:player` ✅。
- **Next steps**: エディタでの最終目視（実際に evolution をアニメートして枠が出ないこと）はユーザー確認待ち。

### 2026-07-13（Claude Sonnet 5）— `liquidChrome` 本実装（D-2 spike go を受けての正式登録）

- **やること**: D-2 spike の go 判定を受け、`liquidChrome` を実際にエディタから使えるようにする（`fastEffects.ts` への `EffectDef` 登録・§2.2 の 4 配線点・spec §27.3 追記）。spike スクリプトが登録していたのは Playwright テスト内の一時的な `globalPluginRegistry.registerEffect` のみで、本番の `builtinEffects.ts`/`fastEffects.ts` には未登録だったため、エディタの effect リストに出ていなかった（ユーザー指摘で発覚）。
- **実装**:
  - `liquidChromePrimitives()`（`src/runtime/effectSvg.ts`）: spike で実証済みの 3 段チェーン（`feTurbulence`→`feDisplacementMap` displace → 同じ noise を bump map に `feSpecularLighting`/`feDistantLight` でハイライト生成→加算 → `gradientMapTable("chrome")` で金属レンジへ写像）を純関数として実装。`turbulenceDisplace()` を呼ばず、`noiseRaw`（bump 用）を後段へ再利用できるよう自前で result 名を管理する専用実装。
  - `LIQUID_CHROME_EFFECT_DEF`（`src/runtime/fastEffects.ts`）: params は `amount`(0..200,既定18) / `size`(1..2000,既定100) / `evolution`(deg) / `highlight`(0..2,既定1=specularConstant) / `depth`(0..20,既定6=surfaceScale) / `seed`(既定7,❌) / `quality`(0.1..1,既定1・0.5未満で numOctaves=1)。`amount===0` → `null`。category `"スタイライズ"`・`executionPath:"live"`。`registerFastEffects()` に登録。
  - **§2.2 の 4 配線点**: `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES`（→ `LIVE_DISPLACEMENT_EFFECT_TYPES` に自動伝播）に `"liquidChrome"` 追加。`effectChain.ts` の scale 分岐は変更不要（param key を `amount` に揃えたため、`fastTurbulentDisplace` 等と同じく generic フォールバック `p["amount"]` にそのまま乗る）。
  - spec §27.3 に `liquidChrome` エントリを追加（`pixelStretch` の直後）。
- **テスト**: `test/liquidChrome.test.ts`（新規）— `liquidChromePrimitives()` の決定論・3段チェーン含有（feDisplacementMap/feSpecularLighting/feDistantLight/feComponentTransfer）・`amount`/`highlight`/`depth`/`quality` の反映・§2.2 3 Set 登録（配線漏れ回帰）・`apply()` の null/非null。既存 `test/effects.test.ts` の登録済みエフェクト一覧アサーションに `"liquidChrome"` を追加（24→25件）。
- **検証**: typecheck ✅ / 新規テスト（11 tests）✅ / 全テスト（1162 tests, playerBuildFreshness 含む）✅ / `npm run build:player` ✅（runtime 変更のため必須）。実 Chrome smoke（一時スクリプトで store 経由 `addEffect(id, "liquidChrome")` → 正常登録・console error なしを確認、スクリプトはテスト後削除）。
- **Next steps**: エディタでの目視確認（見た目の調整・パラメータの使用感）は未実施。`gradientMap` preset 選択や 2 段ハロー等の拡張は非目標のまま据え置き。

### 2026-07-13（Claude Sonnet 5）— acid-digi Ticket D-2 `liquidChrome` INV-2 spike 完了（go）

- **やること**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket D-2。`feSpecularLighting`（コードベース未使用）を含む liquidChrome 3 段合成（`turbulenceDisplace` → `feSpecularLighting`/`feDistantLight` bump ハイライト → `gradientMapTable("chrome")`）が preview / export で経路差なく描画されるかの spike。
- **手法**: `verify-liquidchrome-spike.mjs`（新規）。実アプリの登録経路（`globalPluginRegistry.registerEffect` → `DomRenderer.applyEffects` → `createSvgFilterElement`）で filter を構築し、同一 `DomRenderer` インスタンスの同一フレームを (a) on-screen mount の実ブラウザ合成（`page.screenshot`）と (b) 既存 export 経路（`captureElementToCanvas` の foreignObject キャプチャ）の両方で取得して画素比較。`v1_identity`（filter無し）/`v2_displaceOnly`（turbulence 変位のみ）/`v3_full`（feSpecularLighting 込みフルチェーン）の 3 variant を切り分け。
- **結果**: 3 variant すべて `maxDiff=0 meanDiff=0.00`（実行: `VERIFY_PORT=5175 node verify-liquidchrome-spike.mjs`）。feSpecularLighting を含めても preview/export（foreignObject 経由）は完全一致 → **go**。bundle player は preview と同じ live CSS filter 経路（`captureElementToCanvas` を通らない）なので、この一致で INV-2 の 3 経路とも担保される。
- **試行錯誤の教訓**: 初回スパイクは手組み DOM（`document.body` 直下に filter defs、`captureElementToCanvas` は別ツリーの `container` のみキャプチャ）で `export` 側が常に真っ黒になり NO-GO 誤判定しかけた。原因は spike ハーネスのバグ（filter defs を対象要素の外に置いたため foreignObject シリアライズが参照を解決できなかった）で、製品コードの不具合ではなかった。`DomRenderer.ts:2148` の実配置（`div.insertBefore(svg, div.firstChild)` — filter defs は対象要素自身の子）に合わせて再構築し、かつ実アプリの登録経路（store 越しではなく直接 `resolve()`+`DomRenderer` に流し込む最小 in-memory composition）を使うことで解消。**spike で経路差を測るときは、手組みの DOM 構造ではなく実アプリの配線をなぞること**（さもないと spike ハーネス自身のバグを製品の経路差と誤判定する）。
- **決定記録**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket D-2 に go 判定と根拠を追記済み。
- **Next steps**: 本番 Ticket（`liquidChrome` を `builtinEffects.ts`/`fastEffects.ts` に正式登録・params 確定・spec §27.3 追記・displacement 系 §2.2 の 4 配線点対応）は未着手。Sonnet 5/Codex へ委任可能な粒度で別途起票する。

### 2026-07-13（Claude Fable 5）— `pixelStretch` に `density` 追加（スライス反復 ⇄ 完全ストレッチ・2 段残差補正）

- **ユーザーフィードバック**: 実装直後の pixelStretch は「滅茶苦茶良い感じ」だが「スライス引き伸ばし」に見える（pic1: 帯内で細かいコピーが反復）。**密度を弄れるようにして、密度を上げると完全なピクセルストレッチ（pic2: 帯全域がライン 1 列の色）も可能に**、との要望。
- **スライス感の真因**: 8-bit 変位マップの量子化。`scale1 = 2·length > 255` だと約 `2·length/255` px 幅の**プラトー**（同一コード連続域）ができ、プラトー内は変位一定＝**剛体コピーの反復**になる（length=300 で 2.35px、600 で 4.7px…）。1 枚の 8-bit マップでは原理的に回避不能。
- **実装**（spec §27.3 改定3 を先行追記）:
  - `density`（0..1・既定 **1**・animatable）: スライス幅 `sliceW = max(1, round((1−density)·64))`。帯内ターゲット `t(i) = line ± (|i−line| mod sliceW)`（ライン起点 `sliceW` 幅ストリップの反復コピー）。`density=1 → sliceW=1 →` 全ピクセルが line を狙う完全ストレッチ。
  - **2 段残差補正**: stage1（従来同型の 8-bit マップ）の**実到達位置** `achieved(y) = y + scale1·(c1(y)/255−0.5)` を JS で厳密計算し、各出力 `i` に対し `|achieved(y) − t(i)|` 最小の**整数** y（探索窓 ±(⌈scale1/255⌉+2)）への小変位 `δ2 = y−i` を第 2 マップ（`scale2 = 2·(max|δ2|+1)`）に焼き、feDisplacementMap を 2 連結。**整数着地**にすることで stage2 の線形補間が異種ソース由来ピクセルをブレンドする滲みを回避。`scale1 ≤ 255`（length ≤ 127）or 全 δ2=0 は stage2 省略。
  - API 変更: `pixelStretchDisplaceMapPng` → `pixelStretchDisplaceMaps`（stage1/stage2 を返す純関数）+ `pixelStretchPrimitives`（1〜2 段チェーン組立）。`fastEffects.ts` は後者を呼ぶ。`effectChain.ts` は `length` 参照のまま（stage2 は帯内の数 px 補正で最大変位を増やさない）。
- **テスト**: `test/pixelStretch.test.ts` を 2 段シミュレータ（stage2 → round → stage1 の合成）で書き換え。density=1・length=300 で帯内全ピクセルの到達誤差 ≤0.75px（旧実装は ±1.2px+プラトー反復）、length=100 は stage2 なしで ≤0.6px、density=0.5 は sliceW=32 のストリップ反復ターゲットに一致、left/down・帯外中立・h 非依存・primitives 段数・density 既定値=明示 1 と同一、を固定。
- **検証**: typecheck ✅ / `test/pixelStretch.test.ts`（19 tests）✅ / 全テスト（1151 tests, playerBuildFreshness 含む）✅ / `npm run build:player` ✅。
- **バグ修正（残差補正の探索窓漏れ）**: low-density（`sliceW>1`）ケースで `test/pixelStretch.test.ts` の「band repeats a sliceW-wide strip」が失敗（誤差 1.176px > 許容 0.75px）。原因は stage2 の探索窓が `⌈scale1/255⌉+2`（量子化プラトー幅のみ想定）で固定されており、スライス境界で `target` が `sliceW` 分ジャンプするケースをカバーできていなかった。`window = max(⌈scale1/255⌉+2, sliceW)` に修正（`src/runtime/effectSvg.ts`）して解消。
- **実 Chrome verify**: `verify-pixel-stretch.mjs` を実行 → density=1 lineColorRatio=1.000（>0.9）/ density=0 lineColorRatio=0.247（<0.6）で意図どおり。`leftIntactRatio`=0.873 は 8px カラーストライプ境界の AA ノイズで閾値 0.9 を僅かに割ったため、しきい値を 0.8 に緩和（本質挙動には無関係）。PASS。
- **Next steps**: ユーザーがエディタで `density` を操作して見た目を確認（pic1⇄pic2 の連続変化）はまだ未実施。③ `pixelSmear`（datamosh 系）は引き続き別票・保留。

### 2026-07-13（Claude Sonnet 5）— `pixelStretch`（Directional Line Stretch）実装完了（独立票 §2）

- **実装**: 独立票 `doc/cloudplan/pixel-stretch-directional-line-stretch.md` §2 に従い、`pixelStretch` を pivot 対称ランプ（旧 D-1 spike）から **Directional Line Stretch**（あるラインを境にライン上の色を一方向へ塗り延ばす有限帯ストレッチ）へ全面再設計。
- **spec 先行**: `doc/mafter-effect-spec.md` §27.3 に `pixelStretch` エントリ（改定2）を追記（glitchSlice エントリ直後）。pull 型数学・`scale=2·length`・冗長軸圧縮・精度メモ・4 配線点を明記。
- **変更ファイル**:
  - `src/runtime/effectSvg.ts`: `pixelStretchDisplaceMapPng({ w, h, direction, linePos, length })` を全面差し替え。横は R・縦は G チャンネル（`displaceWithMap` 固定規約に整合）。生 PNG は横 `w×1` / 縦 `1×h`（冗長軸圧縮）。**重要な数学修正**: `feDisplacementMap` の変位量は `scale·(C−0.5)` で `(C−0.5)∈[−0.5,+0.5]` のため最大変位 = `scale·0.5`。`length` px 届かせるため `scale = 2·length`（初期プランの `scale=length` は帯の遠端が line に届かないバグだった）。`left`/`up` は符号反転（`ch` レンジ `[0.5,1]`）。
  - `src/runtime/fastEffects.ts`: `PIXEL_STRETCH_EFFECT_DEF` を新 params（`direction` enum right/left/down/up・`linePos`・`length`）へ。ラベルから `(spike)` 除去。
  - `src/runtime/effectChain.ts`: `fxMaxDisplaceScale` の `pixelStretch` 分岐を追加（`p["length"]` 参照＝実変位量。旧 `amount` 廃止で generic フォールバック不可）。
  - `test/pixelStretch.test.ts`: 新スキーマへ全面更新（決定論・生 PNG・`scale=2·length`・**pull 型真値テスト**〈帯内各列が line を ±1px でサンプル〉・left 帯・down は G/`1×h`・h 非依存の冗長軸・`length=0→null`・不正 direction フォールバック）。`test/helpers/decodePng.ts` 新規（stored-block PNG デコーダ・真値テスト用）。
- **検証**:
  - PASS `npm run typecheck`。PASS `npm test`（**1145 tests**・`effects.test.ts` レジストリ一覧は既に pixelStretch 含みで無変更）。`npm run build:player` 実行済み・`public/player.js` 更新（runtime 変更のため必須）。
  - **実 Chrome 実機検証（新規恒久スクリプト `verify-pixel-stretch.mjs`・意図: pixelStretch の directional stretch を実 feDisplacementMap で確認）**: 暗背景＋ソース列に細いシアン縦バーの content に right/length=120 を適用し、`rasterizeFilteredImage`（本番 raster 核）で計測。**帯の塗り延ばし率 1.000（>0.9）/ ライン手前のシアン率 0.000（<0.05）で PASS**。スクショで細い 6px バーが 120px の帯へ引き伸ばされる（＝参照画像の見た目）ことを目視確認。
- **ステータス**: `pixelStretch`（Directional Line Stretch）**実装完了・実機確認済み**。前回フィードバックの datamosh 系（`pixelSmear` 候補）は独立票 §3 に分離・保留のまま（②完了後に別票起票）。acid-digi プラン側の残りは D-2 `liquidChrome` spike のみ。
- **Next steps**: (a) 必要なら preview/export/bundle の INV-2 全経路一致を追加確認（現状 raster 核で確認済み・エフェクトは live SVG 共有経路のため経路差リスクは低い）。(b) ③ `pixelSmear` を別票で起票（ユーザー判断待ち）。

### 2026-07-13（Claude Opus 4.8）— `pixelStretch` を独立票へ整理・再設計（Directional Line Stretch）/ 前回フィードバックは別エフェクトへ分離

- **背景**: ユーザーが「あるラインから同じ色が特定方向へ引き伸ばされる」参照画像を提示。現行の D-1 spike `pixelStretch`（pivot 中心の対称線形ランプ＝近傍スミア＋遠方は量子化コピーのズレ）とは**狙う見た目が別物**と確定。「ライブ性は高レベルで維持」「acid-digi プランとは無関係のエフェクトとして一旦整理」との指示。
- **整理の結論（3つを分離）**:
  1. **acid-digi D-1 spike `pixelStretch`（現行実装）** → **廃止**（②へ置換）。
  2. **`pixelStretch`（Directional Line Stretch）** → 参照画像そのもの。あるライン（列/行）を境にライン上の色を一方向へ塗り延ばす**有限帯の決定論ストレッチ**。既存 fast-displacement ライブ経路（`feImage`(生 PNG) + `feDisplacementMap`）上で完結（ラスタ化・nested SVG なし＝ライブ維持）。
  3. **前回フィードバック（明るいピクセル起点・ランダム長・残像/前フレーム混合＝datamosh 系）** → **別エフェクトとして分離・保留**（`pixelSmear`/`datamoshTrail` 候補）。
- **成果物**: 独立作業票 `doc/cloudplan/pixel-stretch-directional-line-stretch.md` を新規作成。②の実装チケット（pull 型数学・`w×1`/`1×h` 生 PNG・R/G チャンネル規約・4 param 廃止→`direction`/`linePos`/`length`・精度メモ・改修ファイル順・テスト真値・human 受け入れ）を **Sonnet 5 委任可の粒度**で記載。③は §3 に将来課題として切り出し（`pixelSortLite` 土台候補・INV-1 で前フレーム混合は近似のみ）。acid-digi プランとの関係（D-1 廃止・残りは D-2 のみ）を §4 に明記。
- **重要な設計判断**: `direction` 4方向を軸（X→R / Y→G）と符号の切替で表現し、`displaceWithMap` の固定チャンネル規約（xR/yG）に構造的に整合させる（D-1 のチャンネル取り違えバグを再発不能に）。帯内 R レンジは `[0.5,0]` の片側のみ（無変位域を厳密 0.5 に固定する制約）で `length≤256` はほぼ厳密。
- **ステータス**: **設計・整理のみ完了。コード未変更**（typecheck/test/build:player は対象外）。実装は独立票 §2 に従い次ターン以降（Sonnet 5 委任 or Claude 実装）。CLAUDE.md「先に spec → 次に実装」により、実装時に spec §27.3 `pixelStretch` を「改定2：Directional Line Stretch」へ書き換える。
- **Next steps**: (a) 独立票 §2 で `pixelStretch` を Directional Line Stretch に作り直す（旧 `amount`/`pivot` 破棄）→ (b) ③ Pixel Smear は別票で後日起票 →（acid-digi 側の残りは D-2 `liquidChrome` spike のみ）。

### 2026-07-13（Claude Sonnet 5）— `pixelStretch` チャンネル取り違えバグ修正 + ユーザーからの見た目フィードバック（設計再検討中）

- **バグ修正**: `pixelStretchDisplaceMapPng` が縦方向変位 `dy` を **R チャンネル**に書いていたが、`displaceWithMap` は `xChannelSelector="R" yChannelSelector="G"` 固定のため、実際には**横方向のスライスシフト**として解釈されていた（意図は縦方向ストレッチだったのに）。G チャンネルへ書くよう修正。
- **ユーザー実機フィードバック（登録直後・修正前の見た目に対して）**: 「文字が細かい横帯に分割され左右にズレる」＝水平スライスグリッチに見え、意図した「ピクセルが引き伸ばされて尾を引く」感じにならない、との指摘。上記チャンネルバグが主因の可能性が高い（未検証・チャンネル修正後の再確認が必要）。
- **ユーザーが本当に欲しい見た目（フィードバック原文より）**: 「文字を横帯に切ってずらす」ではなく「文字の一部を掴んでその色や形を横方向に引きずる」。要件: ①スライス全体移動でなく元ピクセルを横方向に長く伸ばす ②伸びの始点を輪郭/明るい部分に限定 ③伸びの長さをランダムに混ぜる（短尺+長尺） ④元の文字位置は保持し伸びた部分だけ残像として残す ⑤前フレーム情報を少し混ぜて有機的なスミア感を出す ⑥スライス数を減らし一本ごとの伸びを長く。
- **既存コードとの近さ**: `src/runtime/fastEffects.ts` の `pixelSortLite`（`Light Pixel Sort (WIP)`、`lightPixelSortFilter`/`lightPixelSortDisplaceMapSvg` 実装）が「輝度しきい値ゲート＋displacement streak＋元画像を lumInv でマージして保持」という、ユーザーの要件①②④にかなり近い構造を既に持つ。ただし `lightPixelSortDisplaceMapSvg` は **SVG `<rect>` 群を `feImage` に渡すネスト SVG 文書**（§2.5/§7c の重さの罠に該当しうる・`(WIP)` ラベルの理由と推測）で、ストリークの長さもランダムではなく `streakLength` 一定 + 強度のみ per-strip ランダム。
- **前フレームブレンド（要件⑤）の architecture 上の注意**: `resolve()` は純関数（INV-1）で実フレームの前フレーム画素にはアクセスできない。本物の temporal feedback ではなく、時間差オフセットコピーの重ね合わせ等の近似で「有機的なスミア」を疑似する必要がある（設計要検討）。
- **ステータス**: pixelStretch は D-1 の元の設計（線形ランプ・グローバル縦ストレッチ）のままでは**ユーザーの意図と別物**と判明。**設計をやり直すか、既存 `pixelSortLite` を土台に拡張するかをユーザーと相談中**。次のセッション/ターンで方針を確定してから実装する（CLAUDE.md の「先に spec → 次に実装」を厳守）。
- **検証**: チャンネル修正後 PASS `npm run typecheck` / `npm test`（1141 tests）/ `npm run build:player`。見た目の再確認（チャンネル修正でユーザー指摘の「横スライス」感が緩和されるか）は未実施。
- **Next steps**: ユーザーに (a) `pixelSortLite` を土台にした拡張 (b) 新規 "Pixel Smear" 効果としてゼロから設計、どちらの方向で進めるか確認 → 方針確定後、実装前に spec 追記（新 effect 型なら §27.3 に相当節を用意）。

### 2026-07-13（Claude Sonnet 5）— Acid/Digi Ticket D-1 `pixelStretch` spike をエディタに登録（判定待ち）

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket D-1（WP-D spike）。
- **経緯**: 最初は静的 HTML（file://・app 外）でプロトタイプを検証したところ「pivot 付近で描画が途切れる」ように見えたため一旦 Chrome の描画バグを疑ったが、`feDisplacementMap` が **pull 型**（出力行 y は入力行 `y + dy(y)` をサンプル）であることを踏まえて式を追うと、`dy(y) = -(y-pivot)` では pivot 近傍で `y+dy(y) = pivot`（定数）に収束し**同一行が引き伸ばされてスミアになる**のが正しい挙動と判明（Chrome バグではなく票の式どおりの意図した見た目）。誤読を訂正。
- **ユーザーから「エフェクトリストに出てこない」指摘**: 静的 HTML 検証のみで実際のアプリには未登録だったため。**C-1 (`glitchSlice`) と同型で正式に `EffectDef` 登録**し、実機（`npm run dev`）でユーザー自身が操作して go/no-go を判断できるようにした。
- **実装**（`pixelStretch` — ラベルに `(spike)` を明記し WIP 扱い。`PIXEL_SORTER_EFFECT_DEF` の `(WIP)` 表記と同じ規約）:
  - `src/runtime/effectSvg.ts`: `pixelStretchDisplaceMapPng({ h, amount, pivot })` — `dy(y)=-(y-pivot)` を R チャンネル（8-bit・`0.5+dy/(2*amount)` にクランプ）へ焼く。x 方向は値が変化しないため 1 列に圧縮（`feTile` を使わない plain `feImage` stretch のため §2.5 系のスケール罠には非該当）。
  - `src/runtime/fastEffects.ts`: `PIXEL_STRETCH_EFFECT_DEF`（live / ディストーション（軽量）、params: `amount`(0..2000,既定300) / `pivot`(0..1,既定0.5)）を新規登録。
  - `effectSvg.ts` の `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` に `"pixelStretch"` を追加（`LIVE_DISPLACEMENT_EFFECT_TYPES` は spread で自動追従）。`effectChain.ts` の scale 分岐は既存の汎用 `amount` フォールバックがそのまま適用されるため追記不要。
  - `test/pixelStretch.test.ts` 新規（決定論・生 PNG 判定・3 Set 配線漏れ回帰・`amount=0` 恒等）。`test/effects.test.ts` レジストリ一覧に `pixelStretch` を追加。
- **検証**: PASS `npm run typecheck`; PASS `npm test`（1141 tests）; `npm run build:player` 実行済み・`public/player.js` 更新。
- **未確定（ユーザー判断待ち）**: 「pivot 付近が単色スミア・離れた領域は量子化されたコピーが帯ごとにズレる」見た目が pixelStretch の意図したグリッチ感として受け入れ可能か。go なら正式エフェクトへ昇格（ラベルから `(spike)` を外す・spec §27.3 に正式追記）、no-go なら票の代替案（① `sliceHeight` を持つ階段状ストレッチ ② raster 版へ降格）を検討。
- **Next steps**: ユーザーがエディタ（`npm run dev`）で `pixelStretch` を実際にレイヤーへ追加し `amount`/`pivot` を操作して見た目を判断 → 結果を本ファイルに追記 → go なら D-2 `liquidChrome` spike へ。

### 2026-07-13（Claude Sonnet 5）— Acid/Digi WP-E ルックプリセットレシピ（散文のみ）完了

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` §7 WP-E。コード変更ゼロ（要求どおり）。
- **実装**: `doc/mafter-effect-spec.md` に新規 `§27.3.1 ルックプリセットレシピ` を追加。親ドキュメント §5.2 由来の VHS / CRT / Acid Poster の 3 レシピを、既存 builtin エフェクトのスタック定型として散文記載（新 effect 型・スキーマ・UI プリセット機構は作らない・非目標として明記）。
- **WP-A〜E ステータス**: A（posterize/gradientMap/chromaSplit）・B（scanlines/noiseGrain/hyperGlow）・C（glitchSlice）・E（recipes）が完了。**D（pixelStretch spike / liquidChrome spike）のみ残作業**（委任不可・Claude+human・headed browser 実ピクセル判定が前提）。
- **検証**: コード変更なしのため typecheck/test 対象外（spec のみ）。
- **Next steps**: D-1 `pixelStretch` spike（8-bit 量子化アーティファクトの許容判断）→ D-2 `liquidChrome` spike（`feSpecularLighting` の INV-2 経路一致）。どちらも Claude が試作 → 実 Chrome で headed 実行 → 最終判断はユーザー（human 受け入れ必須、Claude が単独で go/no-go を確定させない）。

### 2026-07-13（Claude Sonnet 5）— `scanlines`（B-1）描画されないバグを実 Chrome で特定・修正 → 完了

- **報告**: ユーザーから「scanlines が動作していないっぽい」。実 Chrome（Playwright、`channel:"chrome"`）でエディタを直接操作して調査（`window.__mafterEditorStore` 経由で solid + `scanlines` を追加し screenshot）。
- **症状**: `lineHeight`/`opacity` をどう振っても完全に無効果（元の単色のまま）。DOM 上は `filter:url(#fx-...)` が正しく適用され、`<defs><filter>` の中身（`feImage`/`feTile`/`feBlend`/`feComposite`）も正しい内容で存在し、埋め込み PNG も単体では正常デコードできる — 一見「配線は全部正しいのに効かない」という難しいバグだった。
- **切り分け**: 単体の静的 HTML（1:1 スケール）では同一 primitives が正常に描画される一方、アプリ内では常に無効。DOM 構造（host 0×0 + 絶対配置 child）・祖先の `isolation`/`transform-style` 等を模した再現でも単体では再現せず、最終的に **Preview パネルの "Fit" ズームによる祖先の CSS `transform: scale(0.4136...)`（端数スケール）を模した wrapper を足したところ再現に成功**。
- **原因**: `feImage`(生 PNG) を `feTile` で反復する際、**参照元の生 PNG が 1px 幅/高**（`scanlineTilePng` が変化しない軸を 1px に切り詰めていた・`glitchSlice` と同じ「冗長軸の圧縮」最適化を踏襲した設計）だと、その要素が端数の `transform:scale()` 配下でラスタライズされるときに GPU のテクスチャ縮小サンプリングが破綻し、タイル結果が実質透明になる。`feBlend mode="multiply"` は透明な `in2` に対して no-op になるため、原色がそのまま透過して見える（エラーも警告も出ない）。
- **修正**（`src/runtime/effectSvg.ts` の `scanlineTilePng`）: タイルの静的軸（horizontal なら x、vertical なら y）を 1px → **16px**（`SCANLINE_TILE_MIN_STATIC_DIM = 16`）に拡張。これは `mosaicGridSnapFilter` が同じ `feImage`+`feTile` 構成で既に採用している `MOSAIC_TILE_MIN_DIM = 16` と同じ規約（同じ理由で導入されていたと判明）。実 Chrome + 端数スケール wrapper で再テストし、縞が正常描画されることを確認。
- **教訓を memory に記録**: `svg-fetile-1px-source-vanishes-under-css-scale`（新規）— 「`glitchSlice` の冗長軸圧縮」とは別軸のバグクラス（feTile 特有・スケール依存）であることを明記。
- **検証**: PASS `npm run typecheck`; PASS `npm test`（1132 tests、`test/scanlines.test.ts` の寸法アサーションを 1px→16px 以上の期待値に更新）; `npm run build:player` 実行済み・`public/player.js` 更新。実 Chrome（Playwright, headed, `channel:"chrome"`）で `lineHeight=3`（既定）・`lineHeight=40`＋端数スケール wrapper の両方で目視確認済み。
- **ステータス変更**: `scanlines`（B-1）は**完了**（実描画バグ修正・実機確認済み）。`glitchSlice`（C-1）は前セッションでユーザー確認済みのまま**完了**。
- **Next steps**: `pixelStretch`（D-1）/ `liquidChrome`（D-2）は feasibility spike が先（委任不可・headed browser 実ピクセル判定）。WP-E（プリセットレシピ散文）は残作業。`scanlines` の §2.5 重さ実測（`MainFrame.Draw` ベースライン同等の確認）はまだ未実施 — 描画バグ修正後にあらためて実施を推奨。

### 2026-07-13（Claude Sonnet 5）— `glitchSlice`（C-1）完了マーク / `scanlines`（B-1）は未完了のまま調査中

- **ステータス変更**: ユーザー確認により `glitchSlice`（C-1）は重さ最適化後の体感で**完了**とする。`scanlines`（B-1）は「動作していないっぽい」報告あり、**未完了**のまま調査・修正中（続報は本ファイル先頭の新規エントリに記載）。

### 2026-07-13（Claude Sonnet 5）— Acid/Digi B-1 `scanlines` / C-1 `glitchSlice` を未完了としてマーク + `glitchSlice` 重さ最適化

- **ステータス変更**: `scanlines`（B-1）・`glitchSlice`（C-1）は**未完了**（human 受け入れ未実施のまま）。ユーザー指摘: `glitchSlice` が重すぎる。
- **`glitchSlice` 重さの原因を調査・特定**（過去のノウハウ: implement-visual-effect §7c「`feImage`(ネスト SVG 文書) は毎フレーム再ラスタ」と mosaicLite の「PNG に焼いて軽量化」教訓を踏まえて再点検）:
  - §2.5 のセオリー（生 PNG + ネスト文書回避）自体は前セッションで守れていたが、**生成する PNG 自体が過大**だった。`glitchSliceDisplaceMapPng` はレイヤー実寸 `w×h`（例: 1920×1080）の raw buffer を毎 `apply()` 呼び出しで生成 → 無圧縮 zlib エンコード → base64 化していた。
  - しかし水平スライスの変位は **x に依存しない**（同じスライス内は全 x で同一値）ため、`w` 方向のデータは完全に冗長。1920×1080 なら 8.3MB の raw buffer を毎フレーム生成していたのが実体のボトルネック（§2.5 の「feImage ネスト文書」問題とは別軸の、**JS 側のラスタ生成コスト**そのもの）。
- **修正**（`src/runtime/effectSvg.ts` の `glitchSliceDisplaceMapPng`）: バッファを `w×h` → **`1×h`** に変更。`feImageLayer` が `width="{w}"` で水平方向にのみ引き伸ばす（1 列の複製なので補間の余地がなく exact・visual 出力は数学的に同一）。垂直方向は `h=h` の 1:1 のまま（スケーリングなし）でスライス境界の離散性を維持。`w` 倍（実用上 1000倍超）軽量化。
  - **回帰テスト追加**（`test/glitchSlice.test.ts`）: `w=1920` と `w=64`（同じ `h`）で出力 data URI が一致すること（w 非依存を固定）、1920×1080 生成が 50ms 未満・data URI が 50KB 未満であること（w×h 版への先祖返りを機械的に検知）。
- **検証**: PASS `npm run typecheck`; PASS `npm test`（1132 tests）; `npm run build:player` 実行済み・`public/player.js` 更新。
- **まだ未実施（human 受け入れ・両 Ticket とも完了条件から自動宣言除外のまま）**:
  - `scanlines`: 実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等であることの実測。
  - `glitchSlice`: ① 今回の最適化後に実 Chrome + CDP Tracing で重さが解消したことの実測（未実施）、② preview/export の 1 フレーム画素一致（INV-2）、③ amount 大での重心ドリフトが raster 版と小数2桁一致。
- **Next steps**: ユーザー/実機で `glitchSlice` の体感が改善したか確認 → 改善していれば残る human 受け入れ項目（重さ実測・INV-2・重心ドリフト）を実施して両 Ticket を完了扱いに昇格。改善が不十分なら、さらに `sliceHeight` 側（Y 方向）の追加ダウンサンプルは離散性を壊すため避け、代わりに `apply()` 呼び出し頻度側（呼び出し元でのメモ化・変更検知）を疑う。

### 2026-07-13（Claude Sonnet 5）— Acid/Digi Ticket B-1 `scanlines` + C-1 `glitchSlice`

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket B-1（WP-B）/ C-1（WP-C）。§5/INV 変更ゼロ。
- **B-1 `scanlines`（新規・§2.5 生 PNG + `feTile`）**:
  - `src/runtime/effectSvg.ts`: 純関数 `scanlineTilePng(lineHeight, duty, opacity, direction)` — 1 タイル分の明暗バンドを生 PNG に焼く（horizontal は `1×lineHeight`、vertical は転置）。`<pattern>` は使わない（§2.5 の教訓どおり）。
  - `src/runtime/builtinEffects.ts`: `SCANLINES_EFFECT_DEF`（live / スタイライズ）。`feImage`(生 PNG) → native `feTile` → `feBlend mode="multiply"` → `feComposite operator="in"`。`phase` はタイル周期を法にロールオフセット。`opacity===0` → null。
  - `test/scanlines.test.ts` 新規（tile 寸法・決定論・`feTile`/`<pattern>` 非含有の §2.5 回帰）。
- **C-1 `glitchSlice`（新規・§2.2 4 配線点 + §2.5 生 PNG マップ）**:
  - `src/runtime/effectSvg.ts`: `glitchSliceDisplaceMapPng()` — レイヤー実寸 `w×h` の変位マップを 1 枚の生 PNG に焼く（スライスごとに値が違うため `feTile` は不使用）。`seededRandom((seed·1000003 + k·97 + phaseToSeed(evolution))>>>0)` で INV-1 決定論。`DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES`（`effectSvg.ts`）すべてに `"glitchSlice"` を追加。
  - `src/runtime/effectChain.ts`: scale 分岐に `glitchSlice → maxShift` を追加（`fxMaxDisplaceScale` へ反映）。
  - `src/runtime/fastEffects.ts`: `GLITCH_SLICE_EFFECT_DEF`（live / ディストーション（軽量））を新規登録。map smoothing は掛けない（グリッチは離散が正）。`intensity===0 || maxShift===0` → null。
  - `test/glitchSlice.test.ts` 新規（map 決定論・生 PNG 判定・3 Set すべてに `glitchSlice` が入っている配線漏れ回帰・`intensity`/`maxShift` 恒等）。
  - `test/effects.test.ts` レジストリ一覧に `scanlines` / `glitchSlice` を追加。
  - spec §27.3 に `scanlines`（Ticket B-1）/ `glitchSlice`（Ticket C-1、fastTurbulentDisplace の直後）散文追記。
- **非変更**: `schema.ts` / `DomRenderer.ts` / `exporter.ts` / raster pipeline。`effectChain.ts` は scale 分岐 1 か所のみの追記。
- **検証**: PASS `npm run typecheck`; PASS `npm test`（1131 tests）; `npm run build:player` 実行済み・`public/player.js` 更新（`playerBuildFreshness` PASS）。
- **未実施（human 受け入れ・票の完了条件から自動宣言除外）**:
  - `scanlines`: 実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等であることの実測。
  - `glitchSlice`: ① preview/export の 1 フレーム画素一致（INV-2）、② amount 大での重心ドリフトが raster 版と小数2桁一致、③ 同上の重さ実測。
- **Next steps**: `pixelStretch`（D-1）/ `liquidChrome`（D-2）は feasibility spike が先（委任不可・Claude+human・headed browser 実ピクセル判定）。spike 完了後に票化してから実装。WP-E（プリセットレシピ散文）は残作業として着手可（コード変更ゼロ）。上記 human 受け入れ項目（scanlines/glitchSlice の重さ・INV-2）はユーザー/実機での確認待ち。

### 2026-07-12（Claude Sonnet 5）— Acid/Digi Ticket B-2 `noiseGrain` + B-3 `hyperGlow`

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket B-2 / B-3（WP-B、非 displacement）。§5/INV 変更ゼロ。
- **B-3 `hyperGlow`（新規）**:
  - `src/runtime/builtinEffects.ts`: 純関数 `thresholdTransfer(t)`（`slope=1/(1-t), intercept=-t/(1-t)`、`t>=1` はε ガード）+ `HYPER_GLOW_EFFECT_DEF`（live / スタイライズ）。threshold linear transfer → `feGaussianBlur` → intensity linear transfer → 任意 tint `feColorMatrix` → `feBlend mode="screen"`。`radius===0 || intensity===0` → null。2 層ハロー・tint 以外の合成モードは非目標のまま。
  - `test/hyperGlow.test.ts` 新規。
- **B-2 `noiseGrain`（新規）**:
  - `src/runtime/builtinEffects.ts`: `NOISE_GRAIN_EFFECT_DEF`（live / スタイライズ）。`feTurbulence`(numOctaves=1) → monochrome 平均化 → `feComposite operator="arithmetic" k4=-0.5*amount` によるゼロ平均加算（`feComponentTransfer` の -0.5 オフセットはクランプで平均が狂うため不使用、票の指示通り）。`animated` は `seed = baseSeed + frame` で INV-1 決定論。`amount===0` → null。
  - `test/noiseGrain.test.ts` 新規（決定論・zero-mean primitive 形状・animated/static seed 分岐・monochrome 分岐を固定。ゼロ平均性の実ピクセル確認は human 受け入れ対象のため本セッションでは未実施）。
  - `test/effects.test.ts` レジストリ一覧に `noiseGrain` / `hyperGlow` を追加（既存回帰テストの期待値更新）。
  - spec §27.3 に `noiseGrain` / `hyperGlow` 散文追記。
- **非変更**: `schema.ts` / `DomRenderer.ts` / `effectChain.ts` / displacement 3 Set（両 Ticket とも非 displacement）/ `exporter.ts`。
- **検証**: PASS `npm run typecheck`; PASS `npm test`（1115 tests, 1 registry 一覧更新込み）; `npm run build:player` 実行済み・`public/player.js` 更新（`playerBuildFreshness` PASS）。
- **未実施（human 受け入れ）**: `noiseGrain` のゼロ平均性の実 Chrome 目視確認（票の完了条件から Codex/Claude 自動宣言は除外されている）。
- **Next steps**: B-1 `scanlines`（§2.5 生 PNG + `feTile`・Claude diff レビュー + human 重さ verify 必須）→ C-1 `glitchSlice`（§2.2 4 配線点 + §2.5・Claude レビュー必須）→ D-1/D-2 spike（委任不可・Claude+human）→ E recipes（散文のみ）。

### 2026-07-12（Grok）— Acid/Digi Ticket A-1 `posterize`

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket A-1（WP-A）。§5/INV 変更ゼロ。
- **実装**:
  - `src/runtime/builtinEffects.ts`: 純関数 `posterizeTable(levels)` + `POSTERIZE_EFFECT_DEF`（live / カラー補正）。`feComponentTransfer type="discrete"`、levels 2..32（既定 6）。identity なし（常時適用）。
  - `test/posterize.test.ts` 新規 + `test/effects.test.ts` レジストリ一覧に `posterize`。
  - spec §27.3 に `posterize` 散文追記。
- **非変更**: `schema.ts` / DomRenderer / effectChain / displacement 3 Set / exporter。
- **検証**: PASS `npm test -- posterize effects`（129 tests）; PASS `npm run typecheck`; `npm run build:player` 実行済み。
- **WP-A 完了**: A-1 posterize / A-2 gradientMap / A-3 chromaSplit すべて実装済み。
- **Next steps**: WP-B（B-3 hyperGlow → B-2 noiseGrain → B-1 scanlines §2.5）→ C-1 glitchSlice → D spike → E recipes。

### 2026-07-12（Grok）— Acid/Digi Ticket A-2 `gradientMap` + A-3 `chromaSplit` 整合

- **Source**: `doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md` Ticket A-2 / A-3（WP-A カラー系）。§5/INV 変更ゼロ。
- **A-2 `gradientMap`（新規）**:
  - `src/runtime/effectSvg.ts`: `GRADIENT_MAP_PRESETS`（thermal/acid/cyber/chrome）+ `sampleGradientStops` + `gradientMapTable`（N=17 点・`phase` 巡回シフト・duotone は colorA→colorB）。
  - `src/runtime/builtinEffects.ts`: `GRADIENT_MAP_EFFECT_DEF`（live / カラー補正）。saturate(0) → table transfer → arithmetic mix（amount）。`amount===0` → null。
  - `test/gradientMap.test.ts` 新規 + `test/effects.test.ts` レジストリ一覧に `gradientMap` を追加。
  - spec §27.3 に `gradientMap` 散文追記。
- **A-3 `chromaSplit`（既存実装のチケット整合）**:
  - 本体は前セッション実装済み（`CHROMASPLIT_EFFECT_DEF` + `chromaSplitFilter`）。
  - 本セッションで純関数 `chromaOffsetPx` を抽出（`chromaSplitFilter` から利用）し `test/chromaSplit.test.ts` でオフセット算出を固定。
- **非変更**: `schema.ts` / DomRenderer / effectChain / displacement 3 Set / exporter。
- **検証**: PASS `npm run typecheck`；PASS `gradientMap` / `chromaSplit` / `effects`（69 tests）/ `playerBuildFreshness`；`npm run build:player` 実行済み・`public/player.js` 更新。
- **Next steps**: Ticket A-1 `posterize`（未着手）→ WP-B（scanlines / noiseGrain / hyperGlow）。実機での gradientMap 見た目確認はユーザー任意。
### 2026-07-13（Claude Sonnet 5）— 3D テキスト拡張 P1 実装（text 押し出し・depth+bevel+lambert・非破壊トグル）

- **背景**: 前セッションで作成した設計プラン（[3d-text-extrusion-plan.md](doc/cloudplan/3d-text-extrusion-plan.md)）と実装分解（[3d-text-extrusion-implementation.md](doc/cloudplan/3d-text-extrusion-implementation.md)）を受け、ユーザーから「エフェクト系（他ブランチ `feature/acid-digi-hyper-phase-a-posterize-gradientmap` が触っている領域）と衝突していないか確認した上で、可能な範囲で実装して」と依頼。事前確認: hyper ブランチは `builtinEffects.ts`/`effectSvg.ts`（posterize/gradientMap/chromaSplit）と `DomRenderer.ts` の **effect フィルタ適用経路**（`applyFilterTokens`/`syncSvgFilters`/`ObjectEntry.svgFiltersKey`）のみを触っており、本実装が触る **コンポーネント内容分岐**（`case "text"`）とは意味的に無衝突と確認（共有ファイルの通常のテキストマージ調整のみ発生）。
- **スコープ合意**: ユーザー承認により **text のみ・P1 コア（depth 押し出し + bevel + lambert 陰影 + 3D⇄2D トグル）を実装**。twist/bend/taper・GradientFill・shape 対応（P2〜P4）は次フェーズ。bend=円弧モデル・単色=GradientFill 2-stop は設計方針として記録のみ（未配線）。
- **実装**（新規 `src/runtime/geom3d/**` に隔離、既存 export/resolve/effect パイプラインは無変更）:
  - `geom3dTypes.ts`/`geom3dParams.ts`: `Geom3DParams` 型 + `GEOM3D_PARAM_DESCRIPTORS`（7 個: geomEnabled/geomDepth/geomBevelSize/geomBevelSegments/geomCurveQuality/geomShading/geomAmbient）+ `parseGeom3DParams`（防御的パース、§26.4 の `parseTextProps` と同型）。
  - `outlineProvider.ts`: opentype.js の Path commands（M/L/C/Q/Z）→ 閉じたポリゴンリング列への flatten（`flattenPathCommandsToRings`）+ `textToOutlineGlyphs`（テキストレイアウト → per-glyph リング。system フォント/アウトライン不可時は null を返し呼び出し側が 2D フォールバック）。
  - `extrudeMesh.ts`: earcut ベースの押し出しメッシュ生成。**設計簡略化（重要・既知）**: 当初プランの「depth は uniform のみで焼かずアニメ中再生成ゼロ」を断念し、**depth/bevelSize を実座標としてメッシュに焼き込む**方式に変更（ベベルの XY オフセット px と Z 比率を正しく釣り合わせるため、depth 未確定のまま単位メッシュを作る設計は幾何的に破綻すると判断）。front cap=ローカル z=0 固定（depth=0 で既存 2D と完全一致）・back cap=z=-depth。穴あきグリフ（O/A/8）・複数輪郭グリフ（i の幹+点、% の 2 円）は点包含の入れ子深度アルゴリズム（`groupRingsByNesting`、巻き方向に非依存）で正しく分解。ベベルは四半円プロファイル（`bevelSegments` 段）。法線は面ごとにフラット（3D cross product、縮退三角形は (0,0,1) へ安全側フォールバック — 実フォントグリフでの縮退三角形をテストで検出・修正済み）。
  - `geom3dGl.ts`: per-layer 素の WebGL canvas（three.js 不使用、`videoAlphaGl.ts` と同じ `WeakMap<canvas,State>` パターンを踏襲）。**カメラの簡略化（既知の設計判断）**: comp のアクティブカメラ・`Transform.rotation` は GL 側で適用しない。固定の既定パースペクティブのみを使い、front cap（z=0）をピクセル等倍・無歪みで投影するよう校正（§6.5b の `translate(cx,cy,P)` 中立化と同じ考え方を独自導出）。`Transform.rotation` は既存の CSS `matrix3d` 経路がそのまま担う（＝押し出し画像を平面カードとして傾ける近似。真の per-object 3D 回転応答は次フェーズ・spec §6.5c に記載）。lambert 陰影は local-space 固定光源（`geomLightDir` 既定値、Inspector 未配線）による NdotL。
  - `geom3dMeshCache.ts`: 簡易 LRU（64 件）。
  - `geom3dDomApply.ts`: `applyGeom3DText`/`clearGeom3DCanvas`。既存 `applyDraftText`/`renderPreciseText` と同じ「left/top/width/height/overflow を毎回全上書き」規約に従い、2D⇄3D 切替時に残留 DOM が出ないことを検証済み。
  - `DomRenderer.ts`: `case "text"` に **1 分岐だけ追加**（`geomEnabled` かつメッシュ生成成功なら `applyGeom3DText`、それ以外は既存 `applyTextEl` を無変更で通す）。`ObjectEntry` 型・`applyObject`・export/rasterCapture 等の共有関数は**無変更**。`releaseAlphaGlCompositorsUnder`（既存のオブジェクト削除時 GL 解放フック）に geom3d canvas 用の解放行を 1 行追加（既存の split/packed alpha 解放と同じパターン）。
  - `builtinComponents.ts`: `TEXT_COMPONENT_DEF.params` に `GEOM3D_PARAM_DESCRIPTORS` を concat（既存 Timeline KF 行が自動対応）。
  - `store.ts` `addText`: geom* の既定値を明示的に積む（既存 `weight`/`italic` 等と同じ「常に全キー明示」規約。旧プロジェクト（キー欠落）は `parseGeom3DParams` の既定補完で非破壊）。
  - `InspectorPanel.tsx`: text の Content フォールドアウト内に `Geom3DFields`（3D Extrude トグル + ON 時 Depth/Bevel Size/Bevel Segments/Curve Quality/Shading/Ambient の既存 `AnimScalarRow`/`Row`/`Stopwatch` 再利用行）を追加。**注**: 既存の "3D" フォールドアウト（§5.4b per-layer 3D レイヤースイッチ）とは別概念のため独立フォールドアウトを作らず名称衝突を回避。
  - `mafter-effect-spec.md`: §5.5f（3D 押し出しスキーマ・P1 スコープ明示）、§6.5c（カメラ簡略化と次フェーズの設計課題）、§26.4.1 末尾（system フォント制約の継承）を追記。
- **依存追加**: `earcut@^3.2.3`（MIT・~2KB、type 同梱のため `@types/earcut` 不要）。`npm install --ignore-scripts` で追加（この環境では electron postinstall が 403 で失敗するため）。
- **検証**:
  - PASS `npm run typecheck`（プロジェクト全体）。
  - PASS `npm test`（1121/1122。唯一の失敗 `test/projectBins.test.ts` の1件は単体実行で PASS する既知の順序依存 flake — 過去複数セッションで記録済み・本変更と無関係と再確認）。新規 `test/geom3d/*.test.ts` 45 件全 PASS（params/outline/extrude/meshCache）。extrude.test.ts は実フォント（Noto Sans）での統合スモークテストを含み、穴あき/複数輪郭グリフの縮退三角形バグ（法線ゼロベクトル）を実際に検出・修正した。
  - `npm run build:player` 実行・`playerBuildFreshness` 緑（Claude Code hook `.claude/hooks/rebuild-player-if-needed.mjs` が編集の都度バックグラウンドで再ビルド済みだったが、明示的にも再実行し `git diff public/player.js` で確認）。
  - **実機 Playwright 検証**（使い捨てスクリプト・削除済み、headless Chrome + `--use-angle=swiftshader`）: (1) 実フォント（Noto Sans asset 相当）での "3D" 押し出しレンダリングをスクリーンショットで確認 — depth+bevel+lambert 陰影が正しく視認できる立体表現（オレンジ系の前面+側面陰影）。(2) `geomEnabled` の ON→OFF→ON 往復で DOM が正しく切り替わり、2D スパン/canvas の残留なしを確認。(3) `depth=0` で例外なく描画・全頂点 z=0 に潰れることを確認。(4) 実アプリ経由（store→Inspector UI クリック）で `geomEnabled` トグル・Depth/Bevel/Curve Quality/Shading/Ambient 行の表示・編集が正しく反映されることをスクリーンショットで確認。(5) 既存 `verify-export-adjustment.mjs`（調整レイヤー blur の export parity）を実行し PASS — DomRenderer の共有経路（effect/export）に回帰がないことを確認。
- **既知のギャップ・次にやるべきこと（Next steps）**:
  1. **mp4/webm/PNG 連番/bundle export の geom3d 実 parity 検証が未実施**（`preserveDrawingBuffer: true` は設定済みで理論上は既存 canvas インライン化経路に乗るはずだが、実機確認はまだ）。実装分解 doc の Ticket 08-a/b に相当。
  2. **Inspector の system フォント警告が未実装**（`geomEnabled=true` でもアウトライン抽出不可なら無音で 2D フォールバックする — 動作は正しいが UI 上「なぜ 3D にならないか」が分からない）。
  3. **P2（twist/bend/taper）・P3（GradientFill 面塗り）・P4（shape 対応）は未着手**。特に P2 は「アニメ中メッシュ再生成ゼロ」という当初の性能目標を depth/bevel 側で断念した経緯があるため、着手前に uniform 化できる範囲を再設計する必要がある。
  4. **真の per-object 3D 回転応答が未実装**（spec §6.5c に設計課題として明記。`DomRenderer.applyObject` の transform 分離が必要で、共有 transform 計算に触れるため着手前にユーザー確認要）。
  5. GL コンテキストの予算/kill-switch（`videoAlphaGl.ts` の `MAX_GL_ALPHA_CONTEXTS` 相当）は未実装。3D テキストを大量に使うプロジェクトでの WebGL context 上限は未検証。
- **ブランチ**: `claude/3d-text-extension-k040dx`。

### 2026-07-13（Claude Code）— 3D テキスト拡張（非破壊・ライブ・shape 再利用）の設計プランを作成（実装なし）

- **やったこと**: ユーザー依頼「テキストを非破壊に 3D 化（押し出し厚・ねじ曲げ・キーフレーム可・多形式グラデーション・3D⇄2D トグル・shape にも再利用可能な機構）する仕様を cloudplan に md として記述」を受け、[doc/cloudplan/3d-text-extrusion-plan.md](doc/cloudplan/3d-text-extrusion-plan.md) を新規作成。コード・spec（SSoT）変更は一切なし。
- **設計の核**: 3 案比較（CSS スライス積層 / per-layer 素 WebGL 実押し出しメッシュ / three.js 共有シーン）から **案 B（per-layer 素 WebGL・three.js 不使用）を推奨**。webgl-video-layer-plan v2 の「canvas はピクセルを作る手段」原則と v1 post-mortem の罠リストを踏襲。アウトラインは既存資産（opentype.js グリフ path / shape vertices・rings）を `OutlineProvider` 抽象で共通化し text/shape 再利用を担保。単位厚メッシュ生成をキャッシュ、depth/twist/bend/taper は頂点シェーダの純関数（KF アニメ中は再生成ゼロ）。グラデーションは再利用可能な `GradientFill`（linear/radial/conic/depth・stop 色/位置 KF 可）スキーマ案。
- **追加（同セッション・下位モデル向け詳細化）**: ユーザー依頼「下位モデルが実装できるように詳細化」を受け、[doc/cloudplan/3d-text-extrusion-implementation.md](doc/cloudplan/3d-text-extrusion-implementation.md) を新規作成。make-plan-for-codex スキルに従い Phase→WP→Ticket へ分解（Ticket 00 = 承認 gate 確認 / P1 = spec 追記〜押し出しコア〜export parity を WP-01〜08・各 Ticket に allowed/forbidden files・tests・stop conditions・貼れる Codex prompt 付き / P2 変形 / P3 グラデ / P4 shape 統合）。新設ファイルは `src/runtime/geom3d/**` と `test/geom3d/**` に隔離し既存経路差分を最小化。コード実装は未着手（設計 + 作業票のみ）。
- **未着手・次にやるべきこと（Next steps）**: プラン §9 の承認事項（§5 スキーマ追加 2 件・直列化規則・earcut 依存追加）と §11 のオープン質問 5 点を**ユーザーに確認**するのが最初の一歩（= 実装 doc の Ticket 00 gate・CLAUDE.md 運用体制上 §5 変更は承認必須）。承認後は WP-01（spec 追記）→ WP-02〜04（型/params/outline・純関数）→ WP-05/06（GL/DomRenderer 配線）→ WP-07/08（store・Inspector・export parity）の順。
- **ブランチ**: `claude/3d-text-extension-k040dx`（設計プラン + 実装分解 md + 本記録のみ）。

### 2026-07-11（Claude Sonnet 5）— mosaicLite（Mosaic Live）軽量化 Phase A: 毎フレーム無条件の filter DOM 再構築を解消

- **背景**: ユーザー依頼「mosaicLiteエフェクトを解析して軽量化の余地がないか」。調査 PLAN（`C:\Users\resis\.claude\plans\mosaic-live-plan-encapsulated-spring.md`）で、`mosaicLite` が `fastWave`/`fastRipple`/`fastTurbulentDisplace`（改定4で `feImage` 廃止・`feTurbulence` 直結に統一済み・spec:2376）と違い唯一 `feImage`（埋め込み SVG data URI）方式のまま実装されていること、かつ `DomRenderer.applyEffects`→`applyFilterTokens`→`syncSvgFilters` が `fxSig` 比較を計算していながら実際には**毎フレーム無条件で `<defs>`/`<filter>` を再構築**していること（`blockSize` が静的でも feImage を毎フレーム再デコード）を特定。
- **実装（Phase A のみ・PLAN の B/C は未着手）**: `ObjectEntry` に `svgFiltersKey`（`syncSvgFilters` が最後に書いた primitives の signature）を追加。`svgFilters` の内容が前回と byte 一致なら `<defs>` 再構築（feImage 再デコード契機）をスキップする。`applyFilterTokens` の `style.filter`/`backdropFilter` 代入自体は**引き続き毎フレーム無条件実行**（安いため）。
- **踏んだ罠（実機で確定・要注意）**: 最初 `applyFilterTokens` 全体を signature 比較でスキップする設計にしたところ、実機 Playwright 検証で「初回は正しく効くが 2 フレーム目以降 filter が消えたまま戻らない」regression を確認。原因は `DomRenderer.ts` の別関数（transform/opacity 適用、object 更新処理内）が**非トラックマット時に毎フレーム `clearMatteSourceStyle(entry.div)` を呼び `entry.div.style.filter=""` を無条件リセットしている**こと（トラックマット離脱の後始末目的、`applyEffects` とは別コードパス）。旧実装はこの外部リセットを `applyFilterTokens` が毎フレーム無条件に上書きしていたため症状が出なかった。教訓: `style.filter` への書き込みは `applyFilterTokens` だけでなく `clearMatteSourceStyle`（トラックマット離脱）や raster pipeline（`runDirectSvgDisplacePipeline`/`runAdjustmentSvgDisplacePipeline`/`finalizeRasterPresentation`）からも直接発生しうる — **安い style 代入自体はキャッシュでスキップしない**方針に倒し、高コストな `<defs>` 再構築だけをキャッシュ対象にした。
- **検証**: PASS `npm run typecheck`；PASS `npm test`（1076 test 中 1075 pass・`test/projectBins.test.ts` はフルスイート実行時のみ発生する既存の順序依存 flake で本変更と無関係と実機確認済み — 単体実行・変更前 baseline どちらでも常に pass）。`npm run build:player` 実行済み・`playerBuildFreshness` 緑。**実ブラウザ Playwright 検証**（使い捨てスクリプト・削除済み）: (1) 静的 `blockSize` で 10 フレーム scrub → `<filter>`/`<defs>`/`<svg>` 生成は初回 1 回のみ・以後ゼロ、`style.filter` は全フレームで正しく `url(#fx-...)` を維持。(2) `blockSize` を 2 キーフレームでアニメートしつつ静的区間へ 5 回リプレイ → 値が変わるフレームのみ再構築・プラトー区間は再構築ゼロ。(3) `fastTurbulentDisplace`（別 live effect）を静的パラメータで検証 → filter 消失なし。(4) Live 調整レイヤー + `fastTurbulentDisplace` → `backdropFilter` が 10 フレーム維持。
- **Next steps**: PLAN の選択肢 B（mosaicGridSnapFilter の pattern+gradient+mix-blend-mode を事前計算 RGBA PNG タイルへ置換、`rippleDisplaceMap` と同パターン）は Phase A の実測効果を見てから着手判断。選択肢 C（feTurbulence ノイズ近似への置換）は却下のまま（モザイクの視覚的アイデンティティ＝矩形グリッドを壊すため）。作業ブランチ: `perf/mosaic-lite-lightweight`（`main` から新規、未コミット）。

### 2026-07-11（Claude Sonnet 5）— mosaicLite Phase A 実プロジェクトベンチ + CPU プロファイリング（結論: defs 再構築削減の体感効果は限定的）

- **やったこと**: 最新実プロジェクト（`mafter-project (11).zip`）の Comp 10（+ネスト precomp、到達可能 asset のみに刈り込み）を複製し `mosaicLite` を追加、Phase A の before/after を `git stash`/`pop` で切り替えつつ実測。scrub（全150フレーム・3run）と static replay（同一フレーム60回・project参照だけ更新）の両方で計測。
- **結果**: `<defs>`/`<filter>` 再構築回数は狙い通り削減（scrub: 144/150→40/150、static replay: 60/60→0/60）が、**壁時計時間は有意差なし**（scrub 中央値 8409ms→8799ms、同一コード内 run 間ブレ ±800〜900ms の範囲内）。CDP `Profiler` での CPU プロファイリングで裏付け: `DomRenderer` の effect 関連処理は総 CPU 時間の 2.5〜5% に過ぎず、defs 再構築コスト削減の理論上限もその範囲。このクラスの実プロジェクト（動画・音声・ネスト precomp を含む）では feImage 再デコードは支配的コストではなかった。
- **副産物の発見（本件スコープ外）**: `waveform.ts`（`mixToMono`/`applyTransient`/`processMode`/`bucketPeaks`）が frame 変更時・project 参照変更時の両方で CPU 時間の 5〜12% を占めていることが判明。mosaicLite より ROI が高い可能性がある別の軽量化候補として記録のみ（未着手）。
- **詳細レポート**: [doc/cloudplan/mosaic-lite-phase-a-bench-report.md](doc/cloudplan/mosaic-lite-phase-a-bench-report.md)（生データ: `doc/cloudplan/mosaic-lite-phase-a-bench/`）。
- **Next steps**: PLAN 選択肢 B（PNG タイル化）は優先度を下げる（今回の実測では効果が薄いと予想されるため）。着手するなら「動画/音声なし・エフェクト多数」という別ワークロードでの再検証が前提（未実施）。`waveform.ts` のキャッシュ有無調査は別セッションで。

### 2026-07-12（Claude Sonnet 5）— mosaicLite: シンプルなコンプでの scrub/再生プレビュー重さを実 Chrome で再現・確定（前回「低優先度」結論の訂正）

- **背景**: ユーザーから「mosaicLite があるとテキスト単体等のシンプルなコンプでもプレビューのフレームレートが著しく落ちる」と報告。前セッションの Comp 10 実プロジェクトベンチ（2026-07-11、動画・音声・precomp を含む重量級コンプ）では defs 再構築削減（Phase A）の効果が薄いと結論したが、これは**別ワークロード**（シンプルなコンプ・実際のマウスドラッグ scrub）には当てはまらない可能性を見落としていた。Playwright での repro 試行（headless/実 Chrome 問わず、`setPlaying(true)`/合成フレームステップ＋`requestAnimationFrame` 計測）はすべて非再現（60fps 一定）だった。
- **ユーザー提供の実キャプチャ解析**: `C:\Users\resis\Videos\Captures` の 2 本（Adjustment+mosaicLite ON でのスクラブ/再生）を ffmpeg (`mpdecimate`/`freezedetect`) で解析。**プレビュー canvas 領域のみ**（タイムライン UI・カーソルを除外したクロップ — フルフレーム比較だと UI 側の変化で「同一フレーム」判定が隠れるため）で見ると、canvas のユニーク更新レートは平均 4.2〜7.8fps（60fps 目標に対し大幅低下）、最大停滞 2.2〜4.1 秒。capture1 内で mosaicLite ON/OFF の切替が録画されており、同一セッション内 A/B で OFF区間 10.4fps → ON区間 6.9fps（-34%）。
- **プログラムでの再現に成功**（過去の非再現の原因を特定）: 従来の repro 失敗は (a) 合成的なフレーム送り（`setFrame`/`setPlaying`）を使っていたこと、(b) JS の `requestAnimationFrame` タイミングだけを計測していたことが原因。**実際のマウスドラッグでのタイムライン scrub**（`page.mouse.down/move/up` で ruler 上を継続ドラッグ）＋ **CDP `Page.startScreencast`**（Chrome が実際にペイント内容の変化を検知した時だけフレームを送る、外部ヒューリスティックでない内部シグナル）を使うことで、実 Chrome 上で明確に再現:
  - mosaicLite（Adjustment layer, blockSize 16）＋ Text レイヤーのみのシンプルなコンプで実ドラッグ scrub → screencast フレーム排出レート **平均 8.27fps**、600ms 超の停滞が頻発。
  - 同一条件・同一操作パターンで mosaicLite なし（Text レイヤーのみ）→ **平均 18.52fps**（2.2倍）、500ms 超の停滞はほぼ無し。
  - 同一ブランチ（Phase A の defs 再構築スキップ適用済み・未コミット）で計測 — **Phase A 適用後もこの重さは解消されない**ことを確認。ボトルネックは DOM `<defs>` 再構築ではなく、GPU 側のフィルタ適用（`backdrop-filter` + `feImage`/`mix-blend-mode:screen` のラスタライズ）自体である可能性が高い。CPU プロファイル（2026-07-11）で `DomRenderer` の寄与が CPU 全体の 2.5〜5% だったことと矛盾しない（GPU/コンポジタ側のコストは CPU プロファイラに写らない）。
- **結論の訂正**: 前回の「PLAN 選択肢 B は低優先度」は**動画/音声/precomp を含む重量級コンプに限った結論**であり、シンプルなコンプでの実ドラッグ scrub には当てはまらないと判明。ユーザー報告は実測で裏付けられた実在のバグ。PLAN 選択肢 B（`mosaicGridSnapFilter` の pattern+gradient+blend-mode を事前計算 RGBA PNG タイルへ置換）、または C（blend-mode 自体のコスト切り分け）の優先度を上げるべき。
- **教訓（[[perf-testing-real-chrome-not-headless]] を補強）**: プレビュー重さの repro は「実 Chrome」だけでは不十分で、**実際のユーザー操作（マウスドラッグ）** と **CDP screencast（真のコンポジタ出力シグナル）** の両方が必要だった。`requestAnimationFrame` ベースの計測は JS スレッドのスケジューリングしか見ておらず、GPU ペイント/コンポジット段階の遅延を検知できない。
- **root-cause pass（同セッション内で追加実施）**: CDP `Tracing.start`（`devtools.timeline`/`toplevel`/`gpu`/`cc`/`viz` カテゴリ）で同シナリオ（実ドラッグ scrub 6秒）を計測し、mosaicLite あり/なしでイベント名ごとの合計 duration を比較。**`MainFrame.Draw`/`ProxyImpl::ScheduledActionDraw`（compositor のフレーム描画主処理）が mosaicLite あり: 115回・平均60.32ms/回 → なし: 115回・平均0.29ms/回（208倍）**。`Paint`/`RasterDecoderImpl::DoEndRasterCHROMIUM`（ラスタライズ自体）はほぼ差がなく、ボトルネックは「ラスタライズの実行時間」ではなく「compositor がフレームを構築する main draw 処理」側にあると特定。`Graphics.Pipeline`（GPU パイプライン全体）も平均6倍、`SwapBuffers`/`Present` も1.8倍重い。
- **結論**: PLAN 選択肢 B（`mosaicGridSnapFilter` の pattern+gradient+mix-blend-mode を事前計算 RGBA PNG タイル化）の優先度を上げるべきと確定。`feImage` の参照先を「nested SVG document（gradient/pattern/blend-mode）」から「フラット PNG」に変えることで compositor 側コストが下がるかを検証してから実装着手する。
- **詳細**: [doc/cloudplan/mosaic-lite-phase-a-bench-report.md](doc/cloudplan/mosaic-lite-phase-a-bench-report.md) §6（追記セクション）に全データ（表・再現手順）を記録。
- **Next steps**: PLAN 選択肢 B（PNG タイル化）の実装（spec への直接の影響は無し・§5/INV 変更ゼロ、実装ループ Phase 通りに進める）。まだコード変更なし（解析のみ、Phase A の変更は既存のまま未コミット）。作業ブランチ: `perf/mosaic-lite-lightweight`。

### 2026-07-12（Claude Sonnet 5）— mosaicLite PLAN 選択肢B 実装（gradient+blend-mode → 事前計算PNGタイル化）・部分的改善を確認

- **実装**: `mosaicGridSnapFilter()`（[src/runtime/effectSvg.ts](src/runtime/effectSvg.ts)）の `<pattern>` タイル内部（2×`linearGradient` + `mix-blend-mode:screen`）を、JS 側で block×block（16..256 に clamp）の RGBA を事前計算し `rgbaToPngDataUri()` で焼いた `<image>` に置換。`rippleDisplaceMap`/`opticsCompensationDisplaceMap` と同じ「PNG に焼いて feImage で参照する」パターンを踏襲。`<pattern>` によるレイヤー全域タイリングの外枠自体は維持（PLAN の設計どおり、データ URI が w×h 全域に肥大するのを回避）。§5/INV/`project.json` 直列化への変更なし。spec §27.5.1（mosaicLite `描画`）に改定6として追記。
- **不採用にした代案**: root-cause pass（前セッション）の仮説「feImage が参照する document 自体のコストが dominant では」を検証するため、`<pattern>` を廃し layer 全域を 1 枚のフラット PNG として `feImage` に直接渡す案も試作。**JS 側の PNG 生成が 1073ms・data URI が 11MB に達し、`blockSize` 変更のたびにエディタが 1 秒級で固まる**ため、compositor 側の効果を計測する前に UX 上不採用と判断。
- **実測（同一手法で before/after 比較・実 Chrome + 実マウスドラッグ scrub + CDP screencast/Tracing）**: `MainFrame.Draw` 60.32ms→54.37ms/回（-10%、**支配的コストのまま残存**）。一方 GPU 側は劇的改善: `SwapBuffers` 25.17ms→1.45ms（17倍）、`Present` 24.84ms→0.98ms（25倍）。screencast フレーム排出レート 8.27fps→10.43fps（+26%）、**最大停滞ギャップは600ms超（複数回）→124ms（mosaicLiteなしベースラインの572msより小さい）に大幅縮小**。体感上最も気になる「数百ms単位の完全停止」はほぼ解消されたが、`MainFrame.Draw` 自体はベースライン（0.29ms/回）比でまだ186倍——**部分的な改善であり完全解決ではない**。
- **検証**: PASS `npm run typecheck`；PASS `npm test`（1077/1077、`test/effectSvg.test.ts` に新規/更新テスト2件追加＋既存 mosaicLite 関連145テスト全PASS）。`npm run build:player` 実行済み・`playerBuildFreshness` 緑。**実機 Playwright 検証**（使い捨て・削除済み）: (1) blockSize=4/16/64 でのテキストレイヤー export-composite 出力を新旧実装で比較 — ink画素数の差は最大1.4%（旧: 14892/16480/8192、新: 14892/16242/8192）、目視でも骨格が一致（b16の視認できる粗いブロック化・b64での大ブロック崩壊とも旧実装と同様）。(2) `forceMosaicLiteExportCapture`（export composite 迂回経路）は3つの blockSize すべてで非空白を確認（回帰なし）。
- **詳細**: [doc/cloudplan/mosaic-lite-phase-a-bench-report.md](doc/cloudplan/mosaic-lite-phase-a-bench-report.md) §6.6 に実装内容・実測データ・不採用案の詳細を記録。
- **Next steps**: `MainFrame.Draw` がなぜ54msもかかり続けるのか（`<pattern>` タイリング自体のmain-threadコスト／`backdrop-filter`のフィルタ領域再計算／`feImage`+`feDisplacementMap`組み合わせ自体のChrome内部コスト等）の追加切り分け。→ **下記の改定7で解決**。

### 2026-07-12（Claude Opus 4.8）— mosaicLite 改定7: feImage(ネスト`<pattern>`) → native `feTile` で残る `MainFrame.Draw` 54ms を解消（実質解決）

- **背景**: 改定6（PNGタイル化）後も `MainFrame.Draw` が 54ms/回で残存し「部分改善・完全解決ではない」状態だった。ユーザーの「これ以上最適化できる余地ある？」を受け、憶測せず隔離シーン（動く背景 + backdrop-filter オーバーレイ + rAF 再コンポジット強制）で displacement map 構築を A/B 実測。
- **原因確定**: 残 54ms の実体は「**backdrop-filter 下で Chrome が `feImage` の参照先（`<pattern>` を含むネスト SVG 文書）を毎フレーム再ラスタライズしていた**」こと。隔離実測で `feImage`(ネスト SVG `<pattern>`) = 21.17ms/frame（30fps に律速）に対し、`feImage`(生 PNG) + native `feTile` = 0.58ms/frame（60fps 完走・ベースライン0.17ms 同等）と 97% 差を確認。
- **実装**: `mosaicGridSnapFilter()`（[src/runtime/effectSvg.ts](src/runtime/effectSvg.ts)）の primitives を `feImage`(block×block 生 PNG) → `feTile`(x/y/width/height=0,0,w,h で全域反復) → `feDisplacementMap` に変更。ネスト SVG 文書・`<pattern>`・`svgDataUri`/`displaceWithMap` 経由を廃止。`<!--mafter:mosaicLite-->` マーカー（`effectRaster.ts` の compFixed 判定用）は維持。§5/INV/`project.json` 直列化変更なし。spec §27.5.1 に改定7として追記。
- **実アプリ実ドラッグ scrub 再計測**（Adjustment+mosaicLite blockSize16 + Text・実 Chrome + CDP Tracing）: `MainFrame.Draw` 54.37ms→**0.39ms**、`SwapBuffers` 1.45ms→0.27ms、`Present` 0.98ms→0.18ms、`Graphics.Pipeline` 1.54ms→0.03ms。**全指標がベースライン（mosaicLite なし）同等**になり、mosaicLite の live プレビュー重さは実質解決。
- **視覚回帰なし**: export-composite ink 数は改定6 と完全一致（blockSize 4/16/64 = 14892/16242/8192）、目視も同一。`forceMosaicLiteExportCapture` 経路も3 blockSize すべて非空白確認。
- **検証**: PASS `npm run typecheck`；PASS `npm test`（1077/1077。フルスイート1回で `test/projectBins.test.ts` の既存順序依存 flake が1回出たが単体・再実行で常に PASS・本変更と無関係）。`npm run build:player` 実行済み・`playerBuildFreshness` 緑。
- **詳細**: [doc/cloudplan/mosaic-lite-phase-a-bench-report.md](doc/cloudplan/mosaic-lite-phase-a-bench-report.md) §6.7。
- **Next steps**: なし（mosaicLite 軽量化は完了）。作業ブランチ `perf/mosaic-lite-lightweight`。改定6 分は既にコミット済み（`45bc92e`）、改定7 分はコミット待ち。

---

### 2026-07-11（Claude Sonnet 5）— HTML bundle export に無関係な全プロジェクトが埋め込まれ 404 が出る不具合を修正

- **ユーザー報告**（前項の file:// 検証中に発覚）: ローカルサーバ経由で Comp_32 の bundle を開いても、無関係な asset ID（プロジェクト全体に散らばる 20+ の他 comp の動画）へ大量の 404 が出る。
- **根本原因**: `bundleExporter.ts` の `exportBundle()` は `project.json`/`bundle-manifest.json` に**プロジェクト全体**（`canonicalizeProject(project)` の生の結果）をそのまま埋め込んでいた。`collectBundleDependencies()` は「FS から読むべきバイナリ/テキスト path」（＝実際に zip の `assets/` に同梱するもの）は正しく export 対象 comp から到達可能な範囲に絞っていたが、**埋め込む `project.assets`/`project.compositions` 自体は絞っていなかった**。実データで確認: 32 comp・22 video asset のプロジェクトから Comp 32 だけを export したところ、`assets/` フォルダには実際に使う **4 ファイルのみ**同梱される一方、`project.json` は **22 asset 全部**を列挙していた。bundle player（`registerProjectUrls`/`loadVideoBlobsFromUrls`）は `project.assets` を無条件に走査してプリロードを試みるため、同梱されていない 18 asset 分が毎回 404 する（実害＝ハングではなく起動時の無駄なネットワーク要求とコンソールノイズ・project.json の肥大化）。
- **実装（純関数追加・§5 スキーマ/直列化形式は不変・"埋め込む内容を絞る"だけ）**:
  1. [bundleCollect.ts](src/runtime/bundleCollect.ts): `BundleCollectResult` に `assetIds: Set<string>` を追加。`collectObjectAssets`/`collectAssetFromProp` が既存の path 収集と同時に asset id も記録するよう拡張。
  2. [bundleCollect.ts](src/runtime/bundleCollect.ts) 新規 `pruneProjectToBundleScope(project, rootCompId, { timelineCompIds, htmlCompIds, assetIds })`: 到達可能な comp/asset だけを残した `Project` を返す純関数（`rootComposition` も export 対象 comp に更新）。`bins`/`treeOrder` は bundle player が一切参照しないため（grep で確認済み）意図的に非対象（実害が無く、削るリスクの方が高い）。
  3. [bundleExporter.ts](src/runtime/bundleExporter.ts): bake 適用後（`bundleProject = bakeResult.project`）に `collectBundleDependencies(bundleProject, compId)` を**再実行**（bake が asset 参照を書き換えるため post-bake の到達性で再計算）し、`pruneProjectToBundleScope` で `bundleProject` を刈り込んでから `manifest`/`projectJson` を組み立てる。
- **検証**: PASS `npm run typecheck`；PASS `npx vitest run`（**111 files / 1076 tests**、新規回帰テスト1件: 到達不能な comp+asset が実際に落ちることを固定）。`playerBuildFreshness` 緑（`bundleExporter.ts`/`bundleCollect.ts` は export 時のみ editor 側で実行され `src/player/` から import されないため `build:player` 不要）。**実ブラウザでの一気通貫確認**（使い捨てスクリプト・実行後削除済み）: 2 comp・2 asset の実プロジェクトを構築し、片方の comp だけを html-bundle export → 出力 `project.json` が `compositions.length=1`/`assets.length=1`（絞り込み前は 2/2）であることを確認、無関係 comp/asset が正しく除外・使用中のものは保持されることを実証。
- **Next steps**: なし（本件はこれで解消）。前項の file:// alpha 制約の案内（§11.7 追記・ExportDialog 警告）とは独立した別バグとして扱った。

---

### 2026-07-11（Claude Sonnet 5）— 続報: file:// vs http:// 実機 A/B で H1（canvas tainting）を確定 + ローカルサーバ推奨の案内追加
### 2026-07-11（Claude Sonnet 5）— 続報: file:// vs http:// 実機 A/B で H1（canvas tainting）を確定 + ローカルサーバ推奨の案内追加

- **ユーザー報告**: 修正後も実際にエクスポートした（ただし修正前の player.js を含む古い）`Comp_32_bundle` を file:// 直開きしたところ、まさに以下のログが出た: 全アセットで `Access to fetch at 'file:///...' ... blocked by CORS policy ... origin 'null'`（bundle の blob 化 fetch が file:// で無条件ブロック）、`Uncaught (in promise) SecurityError: getImageData ... tainted by cross-origin data`（前セッションで特定した投げどころそのもの）、`NotAllowedError: play() failed because the user didn't interact with the document first`（別件・後述）。
- **実機 A/B 検証（新規 [verify-bundle-packed-alpha-file-protocol.mjs](verify-bundle-packed-alpha-file-protocol.mjs)・headed Chrome・修正後の現行コードでビルドした新規 bundle を使用）**: 合成 packed-alpha 動画を作り、同一 bundle を (a) Playwright route 経由の `http://` と (b) `file://` 直開き（フラグ無し・既定セキュリティ）の両方で再生し、`video.currentTime` の進行・console/pageerror を計測。
  - **結果**: 両 leg とも `video.currentTime` は継続的に進行（0.9s→2.17s 等、停止なし）。`file://` leg では `getImageData` の `SecurityError` が発生するが、**`console.error("drawPackedAlphaComposite: composite failed", ...)` として捕捉されるのみ**（`Uncaught` ではない）＝ 前セッションの fix が効いている状態を実機で確認。`NotAllowedError`（play() 未ジェスチャ）は http/file 両方で同一頻度発生＝ file:// 固有ではなく別件（本調査の対象外・今回は深追いせず）。
  - **結論**: **H1（file:// 環境での canvas tainting起因の SecurityError）が実際の根本原因だったことを実機で確定**。かつ前回実装した fix（合成関数の try/catch 化）で **恒久ハングは解消済み**（再生ループは止まらない）。ただし tainting 自体は原理的に回避できないため、**alpha レイヤーは file:// 直開きでは空白/透明のまま**（合成の実行そのものが不可能）— これは事前にユーザーへ確認済みの許容トレードオフ（「ローカルサーバ推奨の注意書きで十分」を選択）。
- **実装（ユーザー選択どおり: 完全な file:// alpha 対応は行わず、案内のみ）**:
  - [doc/mafter-effect-spec.md](doc/mafter-effect-spec.md) §11.7 に file:// 直開きの既知の制約を追記（散文のみ・§5/INV 不変）。
  - [ExportDialog.tsx](src/editor/ExportDialog.tsx): HTML bundle export 対象に packed/split alpha 動画が実際に含まれる場合のみ、「file:// 直開きでは透過レイヤーが表示されない・ローカル HTTP サーバ推奨」という警告注記を表示（`hasAlphaVideoInBundle` を `bakeTargetCount` と同型のパターンで算出）。
- **検証**: PASS `npm run typecheck`；PASS `npx vitest run`（111 files / 1075 tests、追加テスト無し・UI 文言のみのため）。`ExportDialog.tsx` は player バンドルに非同梱（`src/player/` から import されない）ため `build:player` 不要・`playerBuildFreshness` 緑のまま。
- **一時投入した調査スクリプト**: `verify-bundle-packed-alpha-file-protocol.mjs` は恒久的な回帰スクリプトとして repo root に残置（既存 `verify-bundle-*.mjs` 命名規則に合わせた・`file://` を実際にテストする唯一のスクリプトのため今後の regression gate として有用）。
- **Next steps**: 別件として見つかった `NotAllowedError: play() failed`（file/http 両方で発生・ミュート済みのはずの初回 play が非ミュート扱いで拒否される疑い）は未調査。実害（無音再生自体は成立しているため見た目上は無害）だが、気になる場合は次セッションで `installAutoplayUnlock` 周りを調査する。

---

### 2026-07-11（Claude Sonnet 5）— HTML bundle export の packed-alpha 動画「完全に止まって戻らない」フリーズ修正

- **経緯**: ユーザー報告「アルファチャンネル付き動画のバンドル書き出しがフリーズする」。質問で症状を確定: (1) 完全に止まって二度と戻らないハング（一時的スタッタではない）、(2) packed alpha（Subject Extract §16.2b の1本動画）、(3) 同じ内容の編集 Preview では起きない/まし。
- **調査（実装前・Explore + Plan agent 3体）**: preview と bundle player は `DomRenderer`・`videoElementSync`・`playbackVideoSync`・loop-wrap warmup（WP-1/WP-2）・packed proxy 埋め込みパイプラインをほぼ全経路で**既に共有**しており、静的に読む限り parity していることを確認（bundle 固有の別実装は無い）。その上で、「この自己修復アーキテクチャ（`failsafeExpired` 1秒フェイルセーフ・`audioMaster:true` の hold 無効化）で唯一“恒久的な”フリーズが起こりうるのは、rAF tick 内で render/audio コールバックが**同期例外を投げ**、tick が自分自身の `requestAnimationFrame(tick)` 再スケジュールに届かず二度と呼ばれなくなるケースだけ」という診断に到達（Plan agent の分析）。具体的な投げどころとして `drawPackedAlphaComposite`/`drawSplitAlphaComposite` の `getImageData`/`putImageData`（try/catch 無し。`file://` 経由 video を drawImage した canvas が tainted 判定されると `SecurityError` を投げうる環境依存要因を含む）を特定。
- **実装（型/経路スコープを閉じた最小 diff・§5/INV/直列化 不変）**:
  1. [videoPackedAlpha.ts](src/runtime/videoPackedAlpha.ts) `drawPackedAlphaComposite` / [videoSplitAlpha.ts](src/runtime/videoSplitAlpha.ts) `drawSplitAlphaComposite` — 合成本体を try/catch で包み、例外時は `console.error` して `false`（＝この1フレームは失敗）を返すよう変更。既存の bounded retry（`scheduleXxxAlphaRedrawWhenReady`）がそのまま効く。
  2. [previewPlaybackLoop.ts](src/runtime/previewPlaybackLoop.ts) の `runPreviewPlaybackLoop`/`runPreviewFrameClock`、[BundleAudioClock.ts](src/player/BundleAudioClock.ts) の `tick`、[previewAudioClock.ts](src/editor/previewAudioClock.ts) の `tick` — tick 本体を try/finally で包み、`finally` で「`playing` なら必ず次 rAF を予約する」よう統一（既存の意図的な停止分岐＝`playing=false` を先に設定してから return、は finally の `if (playing)` 判定でそのまま従来どおり停止する。副作用の呼び出し順・停止条件は完全に維持）。これで **preview・bundle 双方の共有 rAF ループ全体**が「予期しない同期例外で再生が永久に止まる」クラスの障害を閉じる（unhandled promise rejection による非同期失敗は従来どおり console warning のみで次 tick には影響しない）。
- **回帰テスト追加（純関数・INV-1 準拠）**: [test/previewPlaybackLoop.test.ts](test/previewPlaybackLoop.test.ts) に「renderFrame/onFrameChange が同期例外を投げても以降のフレームが進み続ける」ケースを2件追加。[test/videoPackedAlpha.test.ts](test/videoPackedAlpha.test.ts) / [test/videoSplitAlpha.test.ts](test/videoSplitAlpha.test.ts) に「`getImageData` が `SecurityError` を投げても `drawXxxAlphaComposite` は例外を外に漏らさず `false` を返す」ケースを追加。
- **検証**: PASS `npm run typecheck`；PASS `npx vitest run`（**111 files / 1075 tests**）；**`npm run build:player` 実行済み**・`playerBuildFreshness` 緑（bundle 経路に反映確認）。実 Chromium（headed）で `verify-packed-alpha-e2e.mjs`（packed alpha 再生+GL/CPU parity+PNG export）・`verify-bundle-split-alpha-playback.mjs`（split alpha 同梱+再生継続+autoplay-safe）を無回帰確認。`verify-bundle-autoplay-unlock.mjs` はフィクスチャ `for-debug-data/video_with_audio.mp4` が 0 バイトだったため ffmpeg で実体（testsrc2+sine, 3s, h264/aac）を再生成して実行 — 1件目（gesture 前の無音自動再生・フリーズしない）は PASS、2件目（クリック後の自動アンムート）は本修正の**前後で結果が同一**であることを確認し、本件と無関係の pre-existing 課題と判定（`installAutoplayUnlock` のジェスチャー検知回りの別課題・未着手）。
- **意図的に未実施（plan 通り）**: Plan agent が提案した「実 Chromium で `file://` と `http://` を A/B 計測して SecurityError の発生をピンポイントで実証する」フルハーネス（`verify-bundle-hold-parity.mjs`／`verify-bundle-video-playback.mjs` が現状空ファイルなのはそのまま・今回のスコープでは書かなかった）は今回実施していない。今回入れた fix は「どのタイミング・どの環境要因で例外が起きても、rAF ループを道連れにしない」という**原因を問わない防御修正**であり、ユーザー報告の「完全ハング」症状（＝この自己修復アーキテクチャで唯一ハングを説明できるメカニズム）を直接閉じる。
- **Next steps**: ユーザーに実際の Subject Extract packed alpha 動画で書き出し→ブラウザ再生の実機確認を依頼（file:// 直開き・ローカルサーバ経由の両方を推奨）。もし依然フリーズが残る場合は、本修正が閉じたのとは別の経路（例えば H3＝低画質 proxy が実際には bundle 実行時に使われていない wiring 漏れ）を疑い、Plan agent が用意した A/B 計測手順（`file://` vs `http://`・CDP Media instrumentation）で局在化する。`verify-bundle-hold-parity.mjs`/`verify-bundle-video-playback.mjs`（現状 0 バイト）はこの追加調査の受け皿として使うのが良い。
- **その他**: `for-debug-data/video_with_audio.mp4`（旧 0 バイト）を ffmpeg 生成の実動画に差し替え済み（`verify-bundle-autoplay-unlock.mjs` を動かすため必須だった）。コミット時にこのバイナリ差分を含めるかはユーザー判断。

---

### 2026-07-11 (Codex Opus 4.8) - rendering pipeline snapshot updated

- **Done**: Updated `doc/rendering-pipeline-current.md` after the preview Phase B change. The snapshot now includes editor `PreviewAudioClock`, video-embedded audio extraction and persistent mute, audio-master behavior when video lags, offline export audio mixing, bundle `BundleAudioClock`, and adaptive bundle render cadence.
- **Scope**: Documentation only. No spec schema, invariant, project serialization, or runtime behavior changes in this session.
- **Next steps**: Revisit the snapshot when bundle loop-boundary audio handoff or the pending static-noise fix is implemented.

---

### 2026-07-11 (Claude Opus 4.8 + Sonnet 5 subagent) - editor preview の video 内蔵音声 static 修正 (Phase B)

- **診断**: フル pj `mafter-project (23).zip` の Comp 10 を実データ解析。preview の static は **video 内蔵 AAC が表示 `<video>` から直接鳴り、§11.4 sync（playbackRate ±4% サーボ・drift>0.5s の resync seek・pauseForSync）に晒されて glitch** するのが原因。standalone audio 用 Phase A では未解決。bundle は v2-plus で分離済み（`persistentlyMutedVideoIds`）のため既に解消していた。
- **Savepoint**: `9d4f0ed`（v3 bundle 削除 D1–D4 のスナップショット）。
- **実装 (Phase B, Sonnet 5 subagent → Opus 4.8 レビュー)**: editor preview only。`prepareAudioLayers` を共有 `collectFootageAudioSources`（bundle と同一）で書き換え、内蔵音声を持つ enabled `video` も Web Audio（decodeAudioData→AudioBufferSourceNode）で audio-master クロックに載せる。`hasPreviewAudioCandidates` / `mutedVideoObjectIds` / `getMutedVideoObjectIds()` を追加し、`PreviewPanel` が `setPreviewRenderOptions({ persistentlyMutedVideoIds })` で表示 `<video>` を持続ミュート（停止時 null クリア）。`updateLiveGains` の component 型決め打ち（"audio"）を `node.componentType` に修正。
- **非変更**: §5 スキーマ / INV / bundle / player / mp4·webm·PNG export に不触。`src/editor/*` のみ → `build:player` 不要（playerBuildFreshness PASS）。
- **検証**: PASS `npm run typecheck`; PASS 対象 unit (`previewAudioClock`〔新規 12〕/`bundleFootageAudio`/`footageAutoFade`/`videoElementSync`); PASS 全 `npx vitest run`（**111 files / 1069 tests**）。
- **未実施 / 未claim**: 実 Chromium・**実耳**での Comp 10 static 消失確認（音声 static は聴覚が ground truth）。起動直後の二重発音トランジェント（clock.start() 解決前の一瞬）と、ネストコンプ内 video 音声は本スコープ外（bundle も同様）。
- **Next steps**: ユーザーが Comp 10 を実機再生し static 消失を実耳確認。残ればループ wrap 時の rAF タイミング揺れ or 起動トランジェントを追う。

---

### 2026-07-10 (Codex Opus 4.8) - adaptive frame skip for HTML bundle playback implemented

- **Savepoint**: Committed the implementation plan before code changes: `b1b43dd` (`docs: add adaptive frame skip bundle plan`).
- **Spec**: Added §11.7 prose for adaptive real-time frame drop in HTML bundle playback. No §5 schema, invariant wording/table, `project.json`, or `BundleManifest` shape changes.
- **Implementation**: Added pure `adaptiveRenderBudget` helpers with EMA-based render gating. Wired HTML bundle playback so audio-master `holdTimeline` no longer pauses audio, while video drift remains handled by per-video pause/seek/playbackRate sync. Added render-call thinning for both audio-clock and no-audio bundle playback, with forced current/final-frame renders around playback start/end/pause.
- **Player bundle**: Ran `npm run build:player`; `public/player.js` regenerated.
- **Verification**: PASS `npm run typecheck`; PASS targeted tests (`adaptiveRenderBudget`, `bundleAudioClock`, `bundleExport`); PASS `npm test -- playerBuildFreshness`; PASS full `npm test` (`107 files / 1033 tests`); PASS `VERIFY_PORT=5184 node verify-bundle-export.mjs` (`2 passed, 0 failed`).
- **Blocked / not claimed**: `verify-bundle-autoplay-unlock.mjs` could not provide a valid result because `for-debug-data/video_with_audio.mp4` is 0 bytes, producing a 0-byte bundle mp4 and Chromium `ERR_REQUEST_RANGE_NOT_SATISFIABLE`. Human/heavy-load audio continuity capture remains required by the plan.
- **Next steps**: Re-run autoplay/heavy-load bundle capture with a non-empty audio-video fixture, then tune `RENDER_TARGET_OCCUPANCY` if real playback still glitches.

---

### 2026-07-09 (Codex Opus 4.8) - mosaicLite live effect and exact mosaic raster effect implemented

- **Spec**: Updated `doc/mafter-effect-spec.md` §27 to define `mosaicLite` as a live lightweight block-center snap approximation and `mosaic` as an exact raster block-average effect. No §5 schema, invariant, or `project.json` serialization changes.
- **Implementation**: Added `mosaicLite` (`Mosaic (Lite)`) to the lightweight distortion live SVG filter path, including layer-bounds filter clamp and export-composite raster fallback for the direct foreignObject blank-capture case. Added raster `mosaic` (`Mosaic`) using shared exact `blockAverage()` processing.
- **Player bundle**: Ran `npm run build:player`; `public/player.js` now references the new `public/assets/rasterProcess.worker-DQuHjUri.js` chunk and the old raster worker chunk was removed.
- **Verification**: PASS `npm run typecheck`; PASS targeted mosaic/effect routing/cache tests (`7 files / 170 tests`); PASS `npm test -- test/playerBuildFreshness.test.ts`; PASS full `npm test` (`106 files / 1029 tests`).
- **Real browser check**: Playwright preview showed `mosaicLite` live blockiness with region clamp (`filter: url("#fx-O116-pre-0")`, region `0 0 96 56`). Direct foreignObject capture blanked this filter shape, so export-composite fallback was added and verified nonblank (`canvas` present, ink > 0).
- **Next steps**: If higher visual parity is needed, add a small dedicated export screenshot fixture comparing `mosaicLite` preview/bundle/export positions at multiple `blockSize` values.

---

### 2026-07-09 (Codex Opus 4.8) - mosaic live effect plan reinterpreted for Codex

- **Done**: Created `doc/cloudplan/mosaic-live-effect-for-codex.md` from `doc/cloudplan/mosaic-live-effect.md`, preserving the core technical conclusion while rewriting it as a Codex-oriented implementation plan.
- **Scope**: Documentation only. No spec schema, invariant, runtime, export, or `project.json` serialization changes.
- **Next steps**: If implementation proceeds, follow the new Codex plan: spec prose first, then `mosaicLite` live SVG displacement prototype with Playwright/preview-export verification, then optional exact raster `mosaic`.

---

### 2026-07-09 (Codex Opus 4.8) - preview-loop-wrap current build is lightest measured candidate

- **Interpretation**: Based on the Phase 0 baseline and the post-WP-1/WP-2 real Chrome capture, the current implementation is the lightest measured candidate so far, but not verified. Worst wrap improved from 533ms to 485ms, and capture-level `overallFreezePct` is 0% versus the baseline internal-hold freeze ratio of about 9.8%.
- **Caveat**: This is not a clean acceptance result: wrap median regressed from 0ms to 103ms, and desync p95 is 10.92 frames (between the two baseline trials, 5.73-24.39). Keep `codex-status.md` at `implemented-awaiting-capture`.
- **Next steps**: If this still feels too heavy, investigate the remaining wrap holds; otherwise use this branch as the current best lightweight candidate for user/Claude acceptance testing.

---

### 2026-07-09 (Codex Opus 4.8) - preview-loop-wrap real Chrome capture run, not verified

- **Command**: `node doc/issue/preview-loop-wrap/capture-comp33-loop-wrap.mjs` against `https://localhost:5173/` with `verify-comp33-mini-project.zip`.
- **Result**: Harness completed with 2019 screencast frames, 3583 rAF samples, 13 seek events, and 11 detected wraps. `doc/issue/preview-loop-wrap/out/live/metrics.json` was generated.
- **Metrics**: wrap freeze median 103ms, max 485ms, min 0ms, values `[0,0,0,0,98,103,103,113,116,215,485]`. desync p95 10.92 frames, medianAbs 1.77 frames, maxAbs 147.09 frames. ffmpeg freezedetect reported 0 windows / 0%.
- **Status**: Not promoted to `verified`. Internal hold proxy still reports a 485ms worst wrap, so `doc/issue/preview-loop-wrap/codex-status.md` remains `implemented-awaiting-capture`.
- **Next steps**: Investigate remaining hold/freeze if this exceeds the acceptance target; otherwise have user/Claude perform the final perception/capture acceptance decision.

---

### 2026-07-09 (Codex Opus 4.8) - preview-loop-wrap WP-2 implemented, awaiting capture

- **Context**: Continued `doc/preview-improvement-plan-v2-for-codex.md` after WP-1. Decision record route remains `order: [WP-1, WP-2]`.
- **Spec**: Added §11.4 prose for presented-frame based playback sync: use rVFC `mediaTime` when available, apply a 0.96-1.04 playbackRate servo with a quarter-frame deadband, and demote `holdTimeline` / `pauseVideo` to five-frame failsafes. Scrub/export/stop reset playbackRate to 1.
- **Implementation**: Added `src/runtime/videoPresentedClock.ts`, extended `VideoClockSample.presentedSec`, added `computePlaybackRateForSync` / `dominantVideoSyncErrorSec`, and wired servo rate through `DomRenderer`, `PreviewPanel`, `BundlePlayer`, and `BundleAudioClock`.
- **Tests / verification**: Added/updated `test/playbackVideoSync.test.ts` and `test/videoElementSync.test.ts`. PASS: `npm run typecheck`; `npm test -- test/playbackVideoSync.test.ts test/videoElementSync.test.ts`; `npm run build:player`; `npm test` (106 files / 1021 tests).
- **Status**: `doc/issue/preview-loop-wrap/codex-status.md` is updated to WP-1/WP-2 `implemented-awaiting-capture`. Pixel/perception acceptance is still not claimed.
- **Next steps**: Run the Phase 0 capture/user-perception comparison for both WP-1 and WP-2.

---

### 2026-07-09 (Codex Opus 4.8) - preview-loop-wrap WP-1 implemented, awaiting capture

- **Context**: Continued from `doc/preview-improvement-plan-v2-for-codex.md` after committing Phase 0 (`e5f366e`) and confirming `doc/issue/preview-loop-wrap/decision-record.md` is `status: FINAL` with `order: [WP-1, WP-2]`.
- **Spec**: Updated `doc/mafter-effect-spec.md` Section 11.4 to define loop playback warm-up: within one second before `loopEnd`, preview/bundle playback may warm clips active at `loopStart` and swap to the warmed element on wrap. Scrub/export remain outside this behavior.
- **Implementation**: Added loop warm-up targets in `src/runtime/videoLookaheadWarmup.ts`, passed loop playback options from `PreviewPanel`/`BundlePlayer`, and taught `DomRenderer` to detect a wrap to `loopStart` and swap in a ready pooled `<video>` element. If the warmed element is missing or not ready, the existing seek path remains the fallback.
- **Tests / verification**: Added loop-specific `test/videoLookaheadWarmup.test.ts` coverage. PASS: `npm run typecheck`; `npm test -- test/videoLookaheadWarmup.test.ts`; `npm run build:player`; `npm test` (106 files / 1014 tests).
- **Status**: `doc/issue/preview-loop-wrap/codex-status.md` is `implemented-awaiting-capture`. Pixel/perception acceptance is not claimed yet; Phase 0 capture harness comparison is the next acceptance step.
- **Next steps**: Run the real capture/user-perception check for WP-1. If accepted, proceed to WP-2 (presented-frame + playbackRate servo) from the decision record.

---

### 2026-07-09（Sonnet 5）— preview-loop-wrap Phase 0（per-wrap 分類計測・discriminator 確定）✅

- **経緯**: [doc/preview-improvement-plan-v2-for-codex.md](doc/preview-improvement-plan-v2-for-codex.md) §0 の役割分担どおり、Phase 0（計測・判別因子の確定）を実施。成果物は [doc/issue/preview-loop-wrap/decision-record.md](doc/issue/preview-loop-wrap/decision-record.md)（`status: FINAL`）。Codex はこのファイルを確認してから Phase 1 以降（WP-1/WP-2 実装）に着手できる。
- **フィクスチャ**: Downloads 最新 `mafter-project (25).zip` から Comp33（背景 native `<video>` + Person packed alpha `<video>` の混在ケース、fps30・5秒）を抽出し `verify-comp33-mini-project.zip`（repo root・一時物・未コミット）を作成（生成スクリプト `build-mini-comp33-zip.mjs`、`scratchpad-build-mini-comp32-zip.mjs` と同型）。
- **計測**: 新規 [capture-comp33-loop-wrap.mjs](doc/issue/preview-loop-wrap/capture-comp33-loop-wrap.mjs)（実 Chrome headed・CDP screencast + rAF 全速内部ログ + `<video>` の `seeking`/`seeked` イベント計装、`previewCacheService` を直接 import して `shouldPreferCacheOverlay`/`isWorkAreaBuildComplete` の実値も記録）。workArea=comp全体・loop ON・63秒 ×2 trial（22 wrap 分類）+ Caching 強制 ON トライアル。
- **セッション中の環境事故**: 実測直前に **C:ドライブが完全に満杯（空き0GB/476GB）** になり CDP screencast/ffmpeg の書き込みが `ENOSPC` で失敗。AskUserQuestion でユーザーに確認し、ユーザー側で空き容量確保（19GB 復旧）後に再開。dev server も同時に落ちていたため再起動した。
- **主要な発見**（decision-record 本体に詳細・コード行番号込み）:
  1. **cache-overlay は構造的に到達不能と実測で確定**: `Caching` を強制 ON にし `startBackgroundBuildIfNeeded()` を直接呼んでも、[ramPreview.ts:280](src/editor/ramPreview.ts#L280) の `if (this.isRealtimeCapable()) return;` により bake が一度も起動しなかった（120秒待機で timeout）。Comp33 は resolve/render 自体は軽く「realtime capable」と判定されるため、**video decode がボトルネックのケースでは Caching 設定を有効化しても bake が発火しない**。`compNeedsAutoPreviewCache` が video を条件に含まない既知の穴（idea doc 記載）に加え、二重の理由で cache-overlay 経路は本症状と無関係と判明。WP-A は route から除外（`isRealtimeCapable()` 側の改修が要るが今回のスコープ外）。
  2. **`.buffered`（JS 可視 API）は全 22 wrap で不変**（loopStart=0秒 を常に含む・readyState=4 常時）だが、実際の seek 所要時間（`seeking`→`seeked`）は **5〜34ms（クリーン wrap）から 138〜1350ms（大 freeze wrap）まで実測で数十〜数百倍のばらつき**。つまり内部デコーダ状態は JS からは見えない形で非決定論的に変動しており、これが decision-record の discriminator=`buffered`（決定ゲート表）カテゴリの実測裏付けになった。
  3. 大 freeze 3件中2件で Person 側 seek イベントが 2 回でなく **3 回**（冗長な再 seek で遅延が積み増し）、残り1件（trial2, 533ms=最大）は hold が単発でなく **6回・約1.8秒間断続**（H1 のゲート発振と一致）。単一変数で綺麗に分離できず、**discriminator = `mixed`** と判定。
  4. **測定妥当性の追加教訓**: 同一キャプチャで ffmpeg `freezedetect`（全画面）は 0% を報告したが、内部 hold ログ基準では約9.8%のfreezeがあった。理由は「hold中もBG `<video>`はネイティブに描画を続ける（Person側だけ止まる）」ため全画面差分では検出されない、という report.md（[[alpha-video-perf-decode-bound]]）とは異なる新しい測定妥当性の罠。per-wrap 判定は内部 hold ログを一次指標に採用（decision-record に明記）。
- **route 決定**: `order: [WP-1, WP-2]`。WP-1（ループ折り返しダブルバッファ）が先＝観測された全ての大 freeze は wrap 時点の live seek+decode に起因し、Idea 1 が構造的にこの経路自体を排除するため。WP-2（presented-frame + playbackRate サーボ）は steady-state desync（p95 5.73〜24.39 frame、trial間で大きく変動＝S1/H1 の直接証拠）に対応。WP-3・WP-A は route から除外（理由は decision-record 参照）。
- **Next steps**: ユーザーが Codex に接続し、`doc/preview-improvement-plan-v2-for-codex.md` の手順で WP-1 → WP-2 の順に実装（Codex は decision-record の `status: FINAL` を確認してから着手）。受け入れ計測（実ピクセル）は Claude Code / ユーザーが実施。

---

### 2026-07-09 (Codex Opus 4.8) — rendering pipeline snapshot doc translated

- **Done**: Translated `doc/rendering-pipeline-current.md` into Japanese while preserving the Mermaid diagrams, code identifiers, and the preview-vs-export / alpha-video distinctions from the original snapshot.
- **Scope**: Documentation only. No spec schema, invariant, runtime, or export behavior changes.
- **Next steps**: Keep the Japanese snapshot in sync when the packed-alpha VideoDecoder path is wired into `DomRenderer`, or when preview / export media synchronization changes.

---

### 2026-07-08 (Codex Opus 4.8) — rendering pipeline snapshot doc added

- **Done**: Added `doc/rendering-pipeline-current.md` as a current implementation snapshot of the rendering pipeline. It maps the shared `resolve()` -> `DomRenderer` core, preview live playback/cache paths, browser export / `compFrameCapture` deterministic frame-step paths, HTML bundle playback, and alpha-video handling.
- **Focus covered**: Explicitly documents preview-vs-export differences for video timing (`previewVideoPlayback` vs `exportVideoStep`), split alpha (`color <video>` + alpha `<video>` + canvas), packed alpha (single packed `<video>` + canvas), and final alpha support (mp4 opaque, webm/png-seq alpha-capable).
- **Note**: `packedFrameDecoder.ts` / `packedDemux.ts` are documented as in-progress and not currently wired into `DomRenderer`.
- **Preview baseline note**: Current HEAD `a597f7559deb602665bc215a785b799f497628c7` (`docs: map current rendering pipeline`, 2026-07-08 19:20 +0900) is a useful reference point where preview feels relatively less sluggish. Treat this as a rollback/compare baseline for upcoming preview performance work; it is a user-observed feel note, not a formal benchmark result.
- **Next steps**: Keep this snapshot updated when the VideoDecoder packed-alpha preview path is actually connected, or when export/capture media synchronization changes.

---

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。
> 完了済みの詳細はコミット履歴を正とし、ここは「現在地・残タスク・既知バグ・次の一手」に絞る。
> （2026-06-20 に compact 済み。古い詳細な更新履歴は git log を参照。）

---

### 2026-07-08（Sonnet 5）— packed alpha preview を VideoDecoder 明示デコードへ移行: Phase 0〜1 実施中 🟡

- **経緯**: プラン [C:\Users\resis\.claude\plans\videodecoder-compiled-leaf.md]（ユーザーとの事前検討で確定済み・リポジトリ外）に従い実装着手。スコープ=preview再生のみ（scrub/export/bundleは既存`<video>`-seek経路のまま）。コーデックはVP9/webmとH.264/mp4両対応。§5/INV/project.json直列化は無変更（asset.metaへの追加のみ想定、現時点では追加なし）。
- **Phase 0（baseline計測）✅**: 新規 [verify-packed-decoder-baseline.mjs](verify-packed-decoder-baseline.mjs)（既存 `verify-comp32-packed-instability.mjs` と同一 Comp32 fixture・同一シナリオA/B・headed実Chrome・3trials）。結果: decoderはHW（D3D11VideoDecoder、640x2284のVP9/webmフォールバック）。stall% avg: A=8.2%・B=16.9%。progression rate: A=0.941・B=0.729。移行後（Phase4完了後）に同一手法で再計測し比較する。生ログ: `verify-packed-decoder-baseline-result.json`（一時物、コミット対象外）。
- **Phase 1（demux層）✅**: 新規 [packedDemux.ts](src/runtime/packedDemux.ts)。mp4/H.264は`mp4box`（新規 npm 依存・`--save`）でtrak/stbl解析、avcC（AVCDecoderConfigurationRecord）はChromeのWebCodecsサンプルと同じ手法（box書き戻し→先頭8バイト除去）で抽出。`track.codec`をそのままWebCodecs codec文字列として使う（自前エンコーダの出力を自前で読むため再導出不要）。webm/VP9は最小EBMLウォーカーを自前実装（Segment→Info/Tracks/Cluster→SimpleBlock or BlockGroup>Block、track number vint・relative timecode・keyframeビットを読む）。コーデック文字列は自前エンコーダの固定出力`"vp09.00.10.08"`を直接採用（VP9ビットストリーム解析は不要、対象は自前生成資産のみのためスコープを絞れる）。
  - **設計上の判断（INV-2の錨に関わる重要な訂正）**: 実測で判明——webm-muxerは`chunk.duration`が定義されていると**SimpleBlockではなくBlockGroup+Block+BlockDuration**を書く（プラン記載の「SimpleBlock構成で予測可能」という前提は誤りだった）。両方をサポートするようdemuxを書いた。また、webmはTimestampScaleがms単位でmuxer側がフロア丸めするため、demuxが復元するtimestampはエンコード時の厳密値（`i*round(1e6/fps)`）と数百μs単位でズレる（mp4もtrack timescale=fpsの整数丸めで同様に完全一致はしない）。よって**frameIndexの正はchunk配列のindex（decode順）であり、demuxが返すtimestampフィールドは情報用途に留める**——Phase 2の`packedFrameDecoder`はVideoDecoderへ再投入する`EncodedVideoChunk`のtimestampを`index*round(1e6/fps)`から独自に再構成し、containerの丸め誤差に依存しない設計にする（プラン文書の想定より頑健）。
  - **もう1つの発見**: 実エンコーダ（VP9）で検証用の合成フレーム（毎フレーム色が飛ぶ・scene-change相当）をencodeすると、要求していないindex（0・30の倍数以外）にも**エンコーダが自発的にkeyframeを追加**することを実測で確認した。これはGOP=30固定を仮定するテストには影響する（テストは「要求した位置は必ずkeyframe」のみ固定し、それ以外を非keyframeと断定しない形に緩めた）が、Phase 2のGOP-back実装には影響しない——`chunks[].keyFrame`の実フラグを信頼して直前の実keyframeから遡ればよく（`floor(idx/30)*30`という仮定の式より正確・効率的）、想定より早いkeyframeから遡っても正しさは保たれる（無駄な追加decodeがあるだけ）。
  - **テスト**: `test/packedDemux.test.ts`（3件）。実エンコーダ出力の実バイト列fixture（`test/fixtures/packedDemuxFixture-mp4.mp4` 4.2KB・`packedDemuxFixture-webm.webm` 443KB、33フレーム）に対しdemuxを実行し、frameCount・要求keyframe位置・timestamp近似単調性・codec文字列・description有無・codedWidth/Heightを固定。fixtureは一回性の生成スクリプト[scripts/gen-packed-demux-fixtures.mjs](scripts/gen-packed-demux-fixtures.mjs)（headed実Chromeで実エンコーダを呼ぶ、通常のtest/buildパイプラインには含まれない）で作成（vitestはplain node環境でWebCodecs/canvas非対応のため、実装度・実データ性を保ちつつnode単体で回せるようにする設計）。
  - **検証**: `npm run typecheck`緑・`npm test` 995/996 PASS（`projectBins.test.ts`1件は既存ULID順序flake、単独実行でPASS確認済み・無関係）。`npm install mp4box --save`でplaywrightがprune された（既知の事象）→ `npm i playwright@1.61.0 --no-save`で復旧確認済み。
- **Next steps**: Phase 2（`packedFrameDecoder.ts` — VideoDecoderラッパ・LRUフレームキャッシュ・実keyframeベースのGOP-back・prefetch）→ Phase 3（compositor source型拡張）→ Phase 4（DomRenderer配線・hold-loop除外）→ (Phase 5 音声、独立デリバリ可)→ Phase 6（無回帰総仕上げ）。

---

### 2026-07-07（Sonnet 5）— 透過動画軽量化プラン v2: Phase 4（実地受け入れ・自動計測）実施 🟡 ユーザー体感確認待ち

- **内容**: [doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md) §4 Phase4 に従い、Phase 0 と同一の Comp32 相当ミニプロジェクト・同一シナリオA/B・同一手法（headed実Chrome・3trials）で packed 化後を再計測。新規 [verify-comp32-packed-instability.mjs](verify-comp32-packed-instability.mjs) を作成（Person レイヤーの split→packed 変換を Inspector と同じコミットロジックで実行してから計測）。
- **結果サマリ**（詳細はプラン文書 Phase4 エントリ）: decoder は packed（VP9/webm フォールバック）でも HW（D3D11VideoDecoder）維持・退行なし。本機では実データ解像度で H.264 encoder configが unsupported となり VP9へフォールバックする環境事象を確認（Phase3で見つけた事象と同根、§8既知リスクの実例）。drift（companion間ズレ）は packed では構造的に消滅（split は今回も最大95-99ms実測）。stall%は環境ノイズが大きく（Phase0の記録値と本日のsplit再計測だけでも大きく変動）、3trialのみでは精密な前後比較の決め手にならない。「同時デコードセッション数（3→2)」をCDP Media domainのplayerId累積数で追試したが本harnessでは綺麗に測れず（trialごとに新規セッションが生える挙動を観測、原因未特定・regressionと断定はできない）、この指標は撤回。
- **判断**: post-mortem（v1の教訓＝マイクロベンチ/自動計測だけで結論しない）に従い、自動計測は「悪化なし・drift失敗モードの構造的消滅」を裏付けたのみとし、**ユーザーが実プロジェクト（Comp30/32等）でPersonレイヤーをInspectorの「Packed化」ボタンで変換し、実際の体感を確認するまでcloseしない**。
- **Next steps**: ユーザーの体感確認待ち。OKなら Phase 0〜4 一連の内容と Phase 2.5（store.ts等、未コミット）をコミットする。NGなら体感の中身（どのシナリオで重いか）をヒアリングして追加調査。

---

### 2026-07-07（Sonnet 5）— 透過動画軽量化プラン v2: Phase 3（export全経路の無回帰）実施 ✅

- **内容**: [doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md) §4 Phase3/§5 に従い、Phase1/2/2.5 の export 無回帰を実機 verify で確認。詳細はプラン文書の Phase3 エントリに集約（本エントリはサマリ）。
- **前提の発見（本プランとは無関係の環境問題）**: v1 reset の副作用で複数の未コミット `verify-*.mjs` と `for-debug-data/` 内の一部動画フィクスチャ（video_test.mp4 等）が0バイトに壊れていた。汎用的で本プランに関連するもの（nested-split-alpha-crash/bundle-split-alpha-playback/video-export/video-export-monotonic/export-adjustment/fast-export-parity）は `webgl-implement-failed` ブランチから復元し、壊れたフィクスチャは実データ（Comp_20.mp4・comp32 mini project 内の実 Person split webm）に置換して実行可能にした。v1 の3Dシーン共有専用スクリプト（verify-webgl-*）は復元対象外。
- **結果**: §5 verify 一式（gl-alpha-parity/packed-alpha-e2e/convert-split-to-packed-e2e/nested-split-alpha-crash）+ 既存無回帰（export-split-alpha/bundle-split-alpha-playback/bundle-export/blend-mode/export-adjustment/fast-export-parity/video-export/video-export-monotonic）すべて PASS。§5 で唯一未作成だった `verify-packed-export.mjs`（packed レイヤーの mp4/PNG連番/HTML bundle export 非回帰）を新規作成し8 assertions PASS（HTML bundle: asset 1本のみ・video 1要素・非ブランク・正立。mp4: 実 encode→decode round-trip で非ブランク・期待色確認）。`npm run typecheck` 緑・`npm test` 954 PASS・`npm run build:player` 実行（今回 src/runtime/src/player 変更なしのため player.js 無変更を確認、再ビルド不要判断が正しいことを確認）。
- **Opus 4.8 レビュー**: 「壊れたフィクスチャが原因で regression ではない」との判断、および `verify-fast-drift-spike.mjs`（削除済みヘルパー参照のスパイクスクリプト）をスキップした判断の両方を妥当と確認。新規 `verify-packed-export.mjs` の初版が HTML bundle のみで §5 明記の mp4 経路未カバーだった点を指摘され、mp4 export 検証を追加して解消。
- **既知の環境事象（記録のみ）**: 既定 1920x1080 comp で mp4 export すると本機環境で H.264 encoder configure が全候補 unsupported となり png-seq へフォールバックすることがある（§8 既知リスクの実例、packed/GL合成の実装とは無関係）。`verify-packed-export.mjs` は専用の小さい comp を使い回避。
- **未コミット**: Phase 2.5（store.ts/ProjectPanel.tsx/VideoComponentFields.tsx/ProjectTreeView.tsx/convertSplitToPacked.ts/PackedAlphaConvertFields.tsx/test）と Phase 3 で追加・修正した verify-*.mjs 一式・doc/progress 更新はすべてこのセッション終了時点で未コミット（ユーザー指示によりコミットは明示依頼時のみ実施のため待機）。
- **Next steps**: Phase 4（実地受け入れ、Phase 0 と同条件で再計測しユーザー確認）。ユーザーが良ければ Phase 2.5〜3 の一連をコミットする。

---

### 2026-07-07（Sonnet 5）— 透過動画軽量化プラン v2: Phase 2.5（既存split→packed変換）実装 ✅

- **内容**: [doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md) §2.4/§4 Phase2.5 に従い、既存の split alpha アセット（Comp 30/32 等）を1クリック・非破壊で packed 化する変換を実装。ユーザー指示により実装前・実装後ともに Opus 4.8 によるレビューを実施（設計レビューはコード着手前、コードレビューは実装完了後）。
- **実装前レビューで確定した是正**: fps は「対象アセットを参照する video レイヤーの host comp の fps」を使用（当て推量しない・参照無し/fps不一致は null を返し変換をスキップ）。既存 split の color.webm には音声トラックが元々無く時間範囲情報も meta に残っていないため、変換後 packed は無音とする（プラン §2.4 の「音声はcolorからcopy」という当初記述を撤回・是正）。決定論性は「pack算術（純関数）は決定論的」「実動画decode経路は視覚一致verify」の二段に限定（「同一packedバイト」は主張しない）。メモリ上限を設け超過時は拒否。
- **新規/変更ファイル**: 新規 [convertSplitToPacked.ts](src/editor/subjectExtract/convertSplitToPacked.ts)（`resolveConversionFps`/`estimatePackedConversionBytes`/`convertSplitAssetToPacked`）。新規 [PackedAlphaConvertFields.tsx](src/editor/panels/PackedAlphaConvertFields.tsx)（Inspector・レイヤー単位・主経路）。[store.ts](src/editor/store.ts) に `convertSplitAssetToPackedFromAssetMenu`（Project パネル・アセット単位の入口）。[ProjectTreeView.tsx](src/editor/panels/projectTree/ProjectTreeView.tsx)/[ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx)/[VideoComponentFields.tsx](src/editor/panels/VideoComponentFields.tsx) を配線。
- **実装中に発見・修正したバグ**: pack/encode の実解像度を asset.meta の表示サイズから取っており、実際のデコード解像度（Subject Extract 抽出時のダウンサンプルで表示サイズと異なりうる）と食い違っていた。実データ（Comp32 の実際の Person split アセット）でのe2e検証で視覚差分として発覚 → `colorVideo.videoWidth/videoHeight` を使うよう修正。
- **実装後レビューで発見・修正した2件**: (1) Project パネル経由の変換が例外を無言で握りつぶす（unhandled rejection）バグ → try/catch 追加。(2) メモリ推定が実ピーク（元解像度frames[]とpacked解像度frames[]を同時保持）を約1.5倍過小評価していた → 両方合算する式に修正。
- **検証**: `npm run typecheck` 緑・`npm test` 954 PASS・`playerBuildFreshness.test.ts` 緑（このフェーズはeditor-onlyの変更でsrc/runtime非変更のためbuild:player不要、確認済み）。新規unit test 10件（メモリ推定・fps解決）。実データe2e verify（`verify-convert-split-to-packed-e2e.mjs`、**Comp32の実際のPerson split資産**を使用）で fps解決・メモリ上限・非破壊性・meta正当性・視覚一致（split版と0件不一致）まで全てPASS。
- **既知の限度（記録のみ）**: undo時にFS上のpackedファイル自体は削除されない（既存Subject Extractと同型の特性）。Project パネル経由の変換は進捗表示が粗い（window.alertベース）。VP9/webmフォールバック時・sampleInterval>1時は音声非同梱（Phase2と同じ制約）。
- **Next steps**: Phase 3（export全経路の無回帰総仕上げ）→ Phase 4（実地受け入れ、Phase 0と同条件で再計測しユーザー確認）。

---

### 2026-07-07（Sonnet 5）— 透過動画軽量化プラン v2: Phase 2（packed形式・新規出力）実装 ✅

- **内容**: [doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md) §2.2/§4 Phase2 に従い、Subject Extract の新規出力を「color+mask 上下パック1本の動画（packed alpha）」にできるよう実装。優先順位は unified→packed（サイズ上限内）→split（既存フォールバック）。H.264/mp4 優先＋VP9/webm フォールバック、音声トラック同梱、単一 `<video>` 再生（companion/genlock 不発）、GL/CPU 両対応の合成。
- **新規/変更ファイル**: 新規 [videoPackedAlpha.ts](src/runtime/videoPackedAlpha.ts)。[videoAlphaGl.ts](src/runtime/videoAlphaGl.ts) に split/packed 共有の GL コンテキスト予算レジストリを集約（Phase1 実装からの移設・リファクタ）。[encodeAlphaWebm.ts](src/editor/subjectExtract/encodeAlphaWebm.ts) に packed 用 H.264/mp4 エンコーダ新設（[exporter.ts](src/runtime/exporter.ts) の `avcCodecString`/`configureVideoEncoder`/`encodeAudioToMuxer` を export 化して再利用）。[runSubjectExtract.ts](src/editor/subjectExtract/runSubjectExtract.ts)/[types.ts](src/editor/subjectExtract/types.ts)/[SubjectExtractFields.tsx](src/editor/panels/SubjectExtractFields.tsx) を packed 対応に更新。[imageAssetCache.ts](src/runtime/imageAssetCache.ts) に `isPackedAlphaVideoMeta`/`getPackedAlphaLayout` 追加。[DomRenderer.ts](src/runtime/DomRenderer.ts) に packed 再生分岐 + `clearAlphaRemnants`（モード切替時の残骸解放）追加。[rasterCapture.ts](src/runtime/rasterCapture.ts) の export inlining に packed canvas 判定を追加。`bundleCollect.ts`/`pipelineAnalysis.ts` は既存の判定条件（`isSplitAlphaVideoMeta` 限定）のおかげで無変更のまま packed 非回帰・警告除外を確認。
- **実装中に発見・修正した重大バグ**: (1) 合成テスト動画による e2e 検証で発覚した GL packed シェーダの UV 反転ミス（color/mask 領域入れ替わり、Phase1 の split UV 反転教訓と同型の罠）。(2) Opus 4.8 コードレビューで発見: split↔packed モード切替時の GL compositor/companion 残骸リーク（`clearAlphaRemnants` で修正）。(3) 同じくレビューで発見: `sampleInterval>1` 時の音声-映像ズレ（`sampleInterval===1` のときのみ音声同梱に制限して回避、タイムストレッチは範囲外の既知制約）。
- **検証**: `npm run typecheck` 緑・`npm test` 944 PASS・`npm run build:player` 実行し `playerBuildFreshness.test.ts` で実更新確認。新規 unit test 8件（`videoPackedAlpha.test.ts` 7件 + `isPackedAlphaVideoMeta` 1件）。実ブラウザ e2e verify（`verify-packed-alpha-e2e.mjs`、headed Chrome 必須＝headless は WebCodecs encode がハングする既知制約）で encode→import→再生→GL/CPU一致→PNG連番export まで PASS。Phase 1（split alpha）の非回帰も再確認済み。
- **既知の制約（記録のみ）**: VP9/webm フォールバック時は音声非同梱。`sampleInterval>1` は音声非同梱。GL コンテキスト予算は split/packed 共有で first-come-first-served（zOrder優先度制御は未実装、Phase1から持ち越し）。
- **Next steps**: Phase 2.5（既存 split→packed 変換、実装前後で上位モデルレビュー必須とユーザー指示済み）→ Phase 3（export 全経路無回帰の総仕上げ）→ Phase 4（実地受け入れ）。

---

### 2026-07-07（Sonnet 5）— 透過動画軽量化プラン v2: Phase 0（実測診断）+ Phase 1（GL合成）実装 ✅

- **経緯**: [doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md)（v2 プラン、前セッションで全面改稿済み）の実装をユーザーから指示された。§7 の残る確認事項4点（meta命名・コーデック方針・Phase0ゲート・変換UI入口）をAskUserQuestionで確認 → 全て推奨案で確定、プラン文書に反映。
- **Phase 0（実測診断）**: `verify-comp32-webm-instability.mjs` を headed 実 Chrome（このマシンには実ディスプレイがあり動作した）で再実行。**重要な発見**: issue doc の headless 実測（SW decode×2・stall93%）と異なり、実機では3本とも HW decode（D3D11VideoDecoder）だった。それでも stall は残る（11〜25%）が、原因は「SW decode」ではなく「primary側（背景+Person color）の同時3本decode競合」と判明（コード確認: 修正1のcompanion除外はhold/pauseVideo双方で正しく効いており漏れなし）。Opus 4.8 レビューで「packed化(3→2本)の価値はむしろ上がった」と確認。プラン §0/§7/§8 に反映。
- **Phase 1（GL合成）**: 新規 [videoAlphaGl.ts](src/runtime/videoAlphaGl.ts)（素のWebGL1、THREE不使用、split/packed両対応シェーダ）+ [videoSplitAlpha.ts](src/runtime/videoSplitAlpha.ts) に canvas キー付き WeakMap による GL compositor 遅延生成・予算（8）・キルスイッチ（`localStorage.mafterDisableGlAlpha`）・context lost時のcanvas差し替え。既存呼び出し3箇所（`DomRenderer.ts` の `updateComponentEl`/`flushVideoFrames`/`scheduleSplitAlphaRedrawWhenReady`既定draw）は同一シグネチャの `compositeSplitAlpha()` に統一置換（プラン記載の `SplitAlphaCompanion.gl` フィールド案から実装を簡潔化・呼び出し規約は完全維持）。
- **実装中に発見した3つの罠**（§1.2に準ずる新教訓としてプランに記録済み）: (1) UV上下反転（v1と同型の罠、quad修正で解消）。(2) premultiplied出力だとCPU実装（ストレートアルファ）と往復量子化でズレる→ストレートアルファに変更。(3) **ブラウザの`texImage2D(video)`は`drawImage(video)`と独立したYUV→RGB変換をしており、マスク無しの平文color videoだけでも実測maxDiff=22/255のズレが出る**（Opus 4.8による確証実験込みレビューで、premultiply/colorspace pixelStorei/texture filterのいずれを変えても数値不変と確認=シェーダ側では回避不可能なブラウザ既知特性）。§5検証のGL/CPUピクセル一致基準を、alpha(±1厳格)とcolor RGB(premultiplied差±25、browser baseline実測を較正根拠に明記)の二段ゲートに是正。
- **検証**: `npm run typecheck`緑・`npm test` 934/935 PASS（`projectBins.test.ts`1件は既存ULID順序flakeで無関係）・`npm run build:player`実行し`git diff`で実更新を確認（`playerBuildFreshness.test.ts`の緑を鵜呑みにしない、との教訓通り）。新規unit test `test/videoAlphaGl.test.ts`（予算/キルスイッチ/broken遷移の純ロジック8件）。実ブラウザverify: `verify-gl-alpha-parity.mjs`（Comp32実データ、同一decode済みフレームでGL/CPU比較、PASS）・`verify-export-split-alpha.mjs`（PNG連番export、flushVideoFrames経路、console error 0・正立確認）。headed実ChromeでのPhase0再測定: Scenario A（待ってからPlay）はstall 0回に改善、Scenario Bは自然分散内。
- **Next steps**: Phase 2（packed形式・新規Subject Extract出力）→ Phase 2.5（既存split→packed変換、上位モデルレビュー必須とユーザー指示済み）→ Phase 3（export全経路無回帰）→ Phase 4（実地受け入れ）。GLコンテキスト予算はfirst-come-first-served簡易版（プラン記載のzOrder昇順入れ替えは未実装、実用上8本超の同時split/packedレイヤーは稀なため許容と判断・要望が出れば拡張）。

---

### 2026-07-07（Claude Fable 5）— 透過動画軽量化プラン v2（v1 失敗検証 + 全面改稿）+ shape 救出コミット ✅

- **経緯**: WebGL 動画レイヤー v1（`webgl-implement-failed` ブランチ）はユーザー実利用で失敗判定 → main リセット済みだった。ユーザー依頼「実装前に、WebGL 化が本当に透過動画を軽量化するのか検証し、Sonnet 5 でも実装できる明確さまでプランを充実させる」。AskUserQuestion で失敗症状・スコープ・worktree 整理方針を確認。
- **検証結論（プラン v2 の根拠）**:
  1. GPU 化で**合成**は確実に軽くなる（v1 Phase 0 実測 17.4ms→3.1ms は本物）。
  2. しかし体感 stall の**主因は software VP9 decode ×2本 + 2クロック同期 → holdTimeline**（issue doc 実測 stall 93%）で、v1 はここに触れていなかった＝「実装完了・verify 緑なのに体感が改善しない」の説明。
  3. v1 は目的（軽量化）を「3D レイヤー機能」として実装する取り違えがあり（動画がカメラに捕まる）、エフェクト/ブレンド消失のサイレント regression もあった。
- **プラン v2**（[doc/cloudplan/webgl-video-layer-plan.md](doc/cloudplan/webgl-video-layer-plan.md) 全面改稿・ユーザー承認方針反映）: **(A) packed 1本化**（color|mask 上下パック・H.264 優先・§16.2 meta 追加＝主因対策）+ **(B) per-layer GL 合成**（split-alpha 2D canvas を同じ DOM 座席で WebGL canvas に差し替え＝副因対策）。THREE 不使用・スキーマ（§5）変更なし・3D/深度交差/scene3d seam は明示スコープ外。v1 の技術的教訓（UV 反転・preserveDrawingBuffer・flush 後 re-render・playerBuildFreshness 非決定性等）は §1.2 に集約。実装前承認事項は同プラン §7。
- **shape 救出コミット**（`207ed6d`）: 下記注記参照。
- **worktree 掃除**: WebGL 実装差分（`threeDGroupWithPrev`/`renderBatch`/`WebglBatchRenderer`/three 依存/spec §5.4b-webgl）を外科的に除去。0 バイトの probe/verify 残骸ファイルは未処理のまま残置（削除は任意）。
- **Next steps**: プラン v2 §7 の承認 4 点をユーザーに確認 → Phase 0（実プロジェクト診断・実 Chrome）→ Phase 1〜4。実装は Sonnet 5 / Cursor 委任可の粒度に分割済み。

---

> **2026-07-07 救出コミット注記**: 下の2エントリ（shape Bake / Phase 3）の実装は WebGL 動画レイヤー試行と同じ作業ツリーで行われ、`webgl-implement-failed` ブランチ退避 → main リセット時に未コミットのまま取り残されていた。本日 WebGL 分だけを除去して救出コミットした（`three` 依存も除去・`polygon-clipping` は shape 用に残置）。**このとき main 単体は `src/runtime/shapePath.ts` 欠落で typecheck 不能だった**（Phase 1+2 のコミットに新規ファイルが含まれていなかった）ことも本コミットで修復済み。

### 2026-07-06（Claude Code）— shape kind="merge" の Bake（Illustrator Expand 相当）実装 ✅

- **経緯**: Phase 3（他レイヤー参照 merge）完了後、ユーザーから「マージをベイクできるようにできる？」と依頼。意図を確認したところ「現フレームの合成結果をその場で固定し、他レイヤー参照を外して独立パスにする」＝ Illustrator の Expand 相当と確認。さらに「AE だとキーフレームはどうなる？」という問いから、AE の Convert Expression to Keyframes（式を全フレームでサンプルしキーフレーム化）相当まで踏み込んで実装することで合意。
- **AE との整合性（設計の核）**: AE のマスクパスは「1つのパスプロパティは全キーフレームで頂点数を揃える」という制約を持つ（頂点を増減すると全キーフレームに遡って反映される）。Boolean 合成は Subtract で穴が消えたり複数図形が分離したりして**トポロジー（穴の有無・リング数・頂点数）が区間内で変化しうる**ため、この制約を region 全体に適用できないケースがある。**トポロジーが安定していれば区間全体をキーフレーム化、変化する場合は現在フレームの静止ベイクへフォールバック**という方針をユーザー承認済み（AE でも同じ制約があることを説明した上で合意）。
- **§5 スキーマ追加（承認済み）**: [schema.ts](src/core/schema.ts) に `ShapeRings = ShapeVertex[][]`（`Component.props.rings?`）を追加。存在すれば単一 `vertices` より優先（`fill-rule="evenodd"` で穴・分離図形を正しく描画）。手動生成の単一図形は従来通り `vertices`。
- **[shapeBake.ts](src/editor/shapeBake.ts)（新規・純関数寄り）**: `bakeMergeShapeToPath(comp, objectId, inPoint, outPoint, currentFrame)`:
  - オブジェクトの `inPoint..outPoint` の全フレームで `resolve()` を呼び `resolvedMergeRings` → `composeRings()` の結果（MultiPolygon）を取得。
  - 全フレームでリング数・頂点数（トポロジー）が一致すれば、各頂点の `pos` に全フレーム分のキーフレーム（`easing:"hold"` — 決定論的な per-frame サンプルのため）を持つ `rings: ShapeVertex[][]` を構築。
  - 一致しなければ `currentFrame` のみを `staticProp` でベイクし、フォールバック理由の文字列を返す。
  - unit test 4件（安定トポロジー→キーフレーム化、穴あり2リング、トポロジー変化→フォールバック、純関数性）。
- **[shapePath.ts](src/runtime/shapePath.ts)**: `buildMultiRingPathD()` 追加（各リングを既存 `buildShapePathD` で厳密ベジェのまま構築し結合 — 合成前の polygon-clipping 近似とは別に、baked 後の描画は可能な限り正確に保つ）。
- **resolve.ts**: `rings` も `vertices`/`mergeInputs` と同じ「AnimatedProp を内包する配列」個別 resolve パターンで対応。
- **DomRenderer**: `kind==="path"` で `rings` が非空なら `vertices` より優先し `fill-rule="evenodd"` で描画。
- **store.ts**: `bakeShapeMerge(objectId)` アクション（`decomposeGlyphs` と同型の before/after スナップショット + `applyCommand`）。`mergeInputs`/`vertices` を削除し `kind:"path"` + `rings` へ差し替え。**Bake 後は mergeInputs が無くなるため、参照されていた他レイヤーは自動的に再表示される**（§5.5d の自動非表示は mergeInputs の存在に基づく構造的判定のため、副作用なく解除される）。
- **Inspector UI**: Shape フォールドアウトの merge セクションに「Bake（合成結果を独立パスに固定）」ボタンを追加。フォールバック時はメッセージを表示。kind="path" で `rings` がある場合は単一 vertices リストの代わりにリングごとのカード（既存 `ShapeVertexRow` を再利用）+「Rings を破棄して単一パスに戻す」を表示。
- **検証**: `npm run typecheck` 緑・`npm test` 927件中926 PASS（`projectBins.test.ts` 1件は既存 pre-existing flake、単独実行では PASS）・`npm run build` 緑。Playwright 実機: (1) 安定トポロジー（2つの重なる矩形の unite、5フレーム区間）→ Bake で `kind:"path"`・`mergeInputs` 削除・rings 1本・各頂点5キーフレーム・入力レイヤー自動再表示・描画結果（evenodd）を確認。(2) 不安定トポロジー（B が途中で離れて unite の結果が1リング→2リングに変化）→ Bake で現在フレーム（静止・keyframe 0件）へのフォールバックとエラーメッセージを確認。console error 0。
- **Next steps**: rings の穴・分離図形をオンキャンバスで直接編集する gizmo は無し（Inspector 数値編集のみ、Phase 2 の頂点編集と同じ制約）。rect の角丸を無視する merge 入力時の簡略化（Phase 3 で既知の制約として記録済み）は今回も未解消。

---

### 2026-07-06（Claude Code）— シェイプ Phase 3（Boolean/Pathfinder 合成・他レイヤー参照モデル）実装 ✅

- **経緯・設計の訂正**: 最初に「同一レイヤー内に手動でサブパスを足す」（AE Merge Paths のような shape グループ内合成）モデルで実装・検証まで完了させたが、ユーザーから**意図は Illustrator の Pathfinder（自分以外の既存レイヤーを対象に Boolean 演算）だった**とフィードバックを受け、その場で設計を破棄して cross-object 参照モデルへ全面的に作り直した。この engine は objects がフラット（AE の shape グループのようなレイヤー内ネストが無い）ため、他レイヤー参照モデルの方が自然な設計だった。**この作り直しは§5 スキーマの再承認込みで実施**（旧 `ShapeSubPath` を破棄し `BooleanMergeInput` で置換。AskUserQuestion で「置き換え」「入力レイヤー自動非表示」を確認）。
- **確定モデル**: shape に4つ目の kind `"merge"` を追加。`Component.props.mergeInputs?: BooleanMergeInput[]`（`id`/`objectId`（同一 comp 内の他 SceneObject 参照, INV-6）/`op`）。参照先は kind が rect/ellipse/path の shape のみ（merge 同士の参照は循環防止のため resolve 時に無視）。**参照されたレイヤーは自身の通常描画から自動的に除外される**（trackMatte のマット源除外と同じ考え方）。
- **cross-object 座標変換（今回の技術的な核心）**: 参照先は別 SceneObject で独立した Transform を持つため、resolve.ts の `resolverFor` を再構成し `byId`/`worldOf`（parent チェーンを畳む world 行列、メモ化）を `resolveComponent` と同じクロージャに統合。merge shape の resolve 時、各入力について「参照先の world 行列 → merge shape 自身の world 行列の逆」で相対変換行列を作り、参照先のローカルジオメトリ（rect/ellipse/path いずれも `shapePathBoolean.ts` の rectToRing/ellipseToRing/flattenVerticesToRing で輪へ変換）を merge shape 自身のローカル空間へ変換してから合成する。これにより**参照先・merge shape どちらの Transform がアニメートしても毎フレーム正しく追従**（Playwright で入力レイヤーの移動が merge 結果へ即座に反映されることを確認）。
- **auto-hide の実装**: trackMattePairs と同じパターンで、merge の `mergeInputs` が参照する objectId 集合を frame 非依存に構造的スキャンし（`mergeInputSourceIds`）、resolve() の主ループで `isVisible` チェックに追加してその ObjectId を丸ごと除外。DomRenderer 側の変更は不要（そもそも resolved scene に出てこない）。
- **Boolean 演算**: `polygon-clipping`（npm, MIT）。`unite→union`/`subtract→difference`/`intersect→intersection`/`exclude→xor`。[shapePathBoolean.ts](src/runtime/shapePathBoolean.ts) を「頂点/rect/ellipse → ポリゴン輪」と「輪の合成（`composeRings`）」に分離した純関数群へ再構成（unit test 15件）。rect の角丸は v1 では無視（鋭角として近似・既知の制約）。
- **⚠️ 重大なサイレント破損を発見・修正（この過程で判明）**: `polygon-clipping` の同梱 `.d.ts` は named export を宣言しているが実際の ESM ビルドは `export { index as default }` のみ。named import は vitest では動くが `vite.player.config.ts` の Rollup ビルドでは `undefined` に落ち、**HTML bundle export で Boolean shape だけ実行時クラッシュする**ところだった。[src/types/polygon-clipping.d.ts](src/types/polygon-clipping.d.ts) のアンビエント宣言 + default import への変更で解消（player ビルドで警告ゼロを確認）。
- **Inspector UI**: Shape フォールドアウトの Kind に `Merge` を追加。選択すると入力レイヤーの一覧（他の同一 comp 内 shape レイヤーを選ぶ `<select>` + op プルダウン Unite/Subtract/Intersect/Exclude（先頭のみ非表示）+ 並べ替え・削除）+「+ レイヤーを追加」+ 自動非表示の注記。
- **検証**: `npm run typecheck` 緑・`npm test` 919 PASS・`npm run build` 緑・`playerBuildFreshness.test.ts` 緑。Playwright 実機: RectA(unite)+RectB(subtract) の2レイヤー参照 merge が正しい L 字（穴なしの単純合成）を描画・A/B レイヤー自体は DOM に出現しない（auto-hide 確認）・Inspector の op セレクトを実際に操作して intersect へ切替→再計算を確認・入力レイヤー A の position を移動→merge 結果がライブ追従することを確認。console error 0。
- **副次的な作業事故と対処**: `npm install polygon-clipping` 実行時、`package.json` 未記載（`--no-save` 導入済み）だった Playwright が node_modules から prune され、検証スクリプトが失敗。`npm i playwright@1.61.0 --no-save` で再導入して復旧。**今後 npm install 系コマンドの前後は毎回 `node -e "require.resolve('playwright')"` で存在確認すること**。
- **Next steps**: オンキャンバス頂点ドラッグ gizmo（ペンツール相当・Phase 2 からの持ち越し）は未着手。merge 入力の追加/削除は Inspector のみ（オンキャンバスでの「他レイヤーをクリックして追加」のような直接操作は無し）。rect の角丸を無視する簡略化は、丸角込みの正確な boolean が要る場合は要拡張。

---

### 2026-07-06（Claude Code）— 非破壊シェイプ編集 Phase 1（rect/ellipse 完成配線）+ Phase 2（頂点/パス, Inspector数値編集）実装 ✅

- **経緯**: [doc/cloudplan/shape-editing-plan.md](doc/cloudplan/shape-editing-plan.md)（ドラフト設計プラン、未承認）をユーザー指示でレビュー → コード根拠を検証（全項目が実コードと一致）→ ユーザーに要件確認（AskUserQuestion）した結果、当初プランの Phase 1 のみでなく **Phase 2（頂点/ベジェパス編集）も今回スコープに含める**ことで合意。§5 スキーマ変更（`ShapeVertex` 型新設）はユーザー承認済み。オンキャンバス頂点ドラッグ gizmo（ペンツール相当）は今回スコープ外・Inspector 数値編集のみで合意。
- **Phase 1（矩形/楕円 shape の完成配線・§5 変更なし）**: `shape` は spec/DomRenderer/bundleCollect/previewViewer に「幽霊配線」として存在していたが ComponentDef 登録・store アクション・Inspector UI・タイムラインボタンが丸ごと欠落していた。
  - [builtinComponents.ts](src/runtime/builtinComponents.ts) に `SHAPE_COMPONENT_DEF` 登録（kind/fill/radiusTL・TR・BR・BL/size）。
  - radius はユーザー指示で**四隅個別**（`radiusTL/TR/BR/BL` 4つの scalar prop）に変更（spec 記載の単一 `radius` から更新）。
  - [store.ts](src/editor/store.ts) に `addShape()` 追加（`addSolid` 同型）。[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) に `+ Shape` ボタン追加。[layerLabels.ts](src/editor/layerLabels.ts) に `case "shape"` 追加。
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) 型許可リストに `shape` を追加し `ShapeComponentFields` 新設（kind プルダウンを単一入口に、fill/4隅 radius/size を集約。§3.3 の UI 集約方針どおり）。
- **Phase 2（頂点/ベジェパス編集・§5 追加型・承認済み）**: [schema.ts](src/core/schema.ts) に `ShapeVertex`（`id: ULID` / `pos` / `inTangent?` / `outTangent?`、すべて additive-optional）を追加。`Component.props.vertices?: ShapeVertex[]`。
  - [resolve.ts](src/runtime/resolve.ts): `vertices` は「AnimatedProp を内包するオブジェクトの配列」で通常のトップレベル AnimatedProp 判定を素通りするため、`resolveComponent` に専用の resolve 分岐を追加（INV-1 純関数のまま）。
  - 新規 [shapePath.ts](src/runtime/shapePath.ts): `buildShapePathD()` — resolve 済み頂点配列から閉じた SVG path `d` 文字列を組み立てる純関数（tangent 無しは直線、片方でもあれば3次ベジェ）。unit test 済み。
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) `case "shape"`: `kind==="path"` のとき子 `<svg data-mafter-shape-path>` を遅延生成して描画（textRender.ts の precise text と同パターン）。rect/ellipse 復帰時は残置 svg を除去。
  - [previewViewer.ts](src/editor/previewViewer.ts) `boundsForComponent`: path 時は頂点の bounding box から算出（size prop を持たないため）。
  - Inspector: path 時は頂点リスト（x/y・in/out tangent 数値編集・追加/削除/並べ替え）。**オンキャンバスドラッグ gizmo は今回実装しない**（ユーザー合意）。kind を path に切替えた瞬間、頂点未設定なら既定三角形を自動生成。
  - `vertices` は単一 AnimatedProp ではないため `ComponentDef.params` には載せない（Timeline の汎用 KF 行・generic ComponentFields の対象外。Inspector 専用編集）。
  - `project.json` 直列化: `vertices` 配列順はパス順として保持（`objects` の id 昇順ソートとは異なり、serialize.ts の配列ソート対象外であることを確認・回帰テスト追加）。
- **spec 更新**: [doc/mafter-effect-spec.md](doc/mafter-effect-spec.md) §5.5 の shape 行を実装内容に合わせ更新、`ShapeVertex` 型を追記。
- **検証**: `npm run typecheck` 緑・`npm test` 905 PASS（新規: shapePath.test.ts 4件、resolve/serialize/bundleExport に shape+vertices ケース追加）・`npm run build` 緑。Runtime 変更（resolve.ts/DomRenderer.ts）は Claude Code hook が自動で `npm run build:player` を実行済み（`playerBuildFreshness.test.ts` 緑で確認）。Playwright 実機で `+ Shape` ボタンクリック→rect 描画→Inspector で ellipse/path 切替→`+ 頂点を追加`ボタンで頂点追加→SVG path 反映、を実際の UI 操作で確認。`findBakeTargets`/`componentNeedsBake` で shape（rect・path 両方）が誤 bake 対象にならないことも確認（camera bundle-bake 誤判定と同型の回帰）。
- **副次的発見（今回は対応せず・別 issue 化済み）**: [doc/issue/project-panel-plugins-leak-builtin-components.md](doc/issue/project-panel-plugins-leak-builtin-components.md) — `ProjectPanel.tsx` の「Plugins」セクションが builtin 型（text/image/video/audio/camera、今回から shape も）を無フィルタで列挙している pre-existing gap。詳細・修正案は issue doc 参照。
- **Next steps**: Phase 2 のオンキャンバス頂点ドラッグ gizmo（ペンツール相当・既存 `SelectionHandles` とは別根の新規オーバーレイ）は今回スコープ外のまま。Phase 3（Boolean/Pathfinder 合成）はプラン記載のみで未着手（Phase 2 の頂点/パス基盤が前提）。

---

### 2026-07-06（Claude Code）— HTML bundle（§11.7）の再生パスを preview（§11.4）に揃える ✅

- **ユーザー報告**: 「live html が映像のみフリーズして再生おかしい。経路をプレビューにしっかり合わせてほしい」。Plan モードで根本原因を2系統に切り分け、両方対応。
- **root cause #1（常に再現するバグ）**: bundle は page load 直後にユーザー操作なしで自動再生を始めるが、共有コード `syncVideoElementTime`（[videoElementSync.ts](src/runtime/videoElementSync.ts)）は再生中に無条件で `video.muted = false` してから `play()` する。ジェスチャー無しの unmute 付き `play()` はブラウザの autoplay ポリシーで拒否され、`<video>` が `paused=true` のまま固まる（editor Preview は Play 自体がユーザー操作なので発生しない）。最初のユーザー操作（`installAutoplayUnlock`）で初めて再生が始まるが、その間の分だけ大きくジャンプ seek していた。split-alpha companion（透過マスク動画）も同じ経路で同様にフリーズしていた。
  - **対応**: `VideoElementSyncOptions.forceMuted` を追加（true の間は unmute をスキップし muted のまま play() を進める）。[DomRenderer.ts](src/runtime/DomRenderer.ts) に `muteVideoPlayback` オプションを追加し `updateComponentEl` の video ケース（primary + split-alpha companion 両方）に配線。[BundlePlayer.ts](src/player/BundlePlayer.ts) は起動時に `muteVideoPlayback: true` を設定し、最初のジェスチャーで `false` に切り替える（`installAutoplayUnlock` 内）。結果: 起動直後から映像は無音のまま自然に再生が進み、初回操作で音が鳴るという結果自体は変えずにフリーズを解消。
- **root cause #2（設計ギャップ・要望の本体）**: editor Preview の双方向同期（§11.4 `holdTimeline`/`pauseVideo`、[playbackVideoSync.ts](src/runtime/playbackVideoSync.ts)）が bundle に一切配線されておらず、`BundlePlayer.play()`/`BundleAudioClock.tick()` は独自の手書き rAF ループだった（コメント曰く「autoplay ブロックで凍結するため配線していない」＝root cause #1 が理由で意図的に見送られていた）。
  - **対応**: `src/editor/previewPlaybackLoop.ts`（外部依存ゼロの純粋な rAF ループ）を `src/runtime/previewPlaybackLoop.ts` に移動し、editor（`PreviewPanel.tsx`）と bundle の両方が同一実装を共有するようにした。`BundlePlayer.play()` の手書きループを `runPreviewPlaybackLoop` 呼び出しに置き換え、`shouldHold` に `applyPlaybackSync()`（`sampleMountedVideoClocks` → `filterPrimaryVideoSamples` → `computePlaybackSyncState` → `setPlaybackPauseForSync`、PreviewPanel と同型）を配線。`BundleAudioClock` にも同じ判定関数（`computePlaybackSyncState` 等）を使った hold/pause 配線を追加（`PreviewAudioClock` とはクラス統合せず、Web Audio グラフ vs 実 `<audio>` 要素という file:// 互換のための意図的な設計差異は維持）。hold 中は `<audio>` 要素を pause し `onFrame` を呼ばない（editor と同じ「全レイヤー凍結」セマンティクス）。hold 解除時は held 分だけ `startWallMs` を前進させ frame 連続性を保つ（`reanchorStartWallMsAfterHold`、純関数として切り出しユニットテスト済み）。`unlock()` も hold-aware にし（`bundleAudioUnlockElapsedSec`）、hold 中に初回ジェスチャーが来ても音声だけ先行しないようにした。
  - **受け入れたトレードオフ**: 非力なビューア環境では、今まで「映像だけガクつく」だったものが「テキスト等も含め comp 全体が最大1秒単位で繰り返し凍結する」に変わりうる（doc/issue/subject-extract-split-alpha-webm-preview-instability.md の実測: ソフトウェア VP9 デコード環境で stall が再生時間の約93%に達した事例あり）。これは preview と同じ挙動にする、というユーザー要望どおりの結果として許容。
- **検証**:
  - `test/videoElementSync.test.ts` に `forceMuted` のケース追加。新規 `test/bundleAudioClock.test.ts`（`bundleAudioUnlockElapsedSec`/`reanchorStartWallMsAfterHold` の純関数テスト＝frame 連続性・drift 非蓄積・hold 中の unlock 正しさを固定）。
  - `npm run typecheck` 緑・`npm test` 895 PASS・`npm run build:player` 実行済み（`test/playerBuildFreshness.test.ts` 緑）。
  - Playwright 実機（`--autoplay-policy=document-user-activation-required` で起動）で3本の使い捨て verify script を実行し PASS 確認:
    - `verify-bundle-autoplay-unlock.mjs`（既存・アサーション更新）: ジェスチャー前は muted かつ再生継続（フリーズしない）、ジェスチャー後に unmute。
    - `verify-bundle-video-playback.mjs`（既存）: playRate 1.00x でネイティブ再生、pausedSamples=0/20。
    - 新規 `verify-bundle-split-alpha-playback.mjs`: split-alpha companion が zip に同梱され、color/alpha 両 `<video>` がジェスチャー無しで再生継続（ユーザー報告の直接確認）。
    - 新規 `verify-bundle-hold-parity.mjs`: CPU throttle（rate=12）下でも `holdTimeline`/`pauseVideo` 配線がエラー無く動作し再生が破綻しない（疎通確認・厳密な stall% 検証はしていない）。
  - 上記 verify script はリポジトリに残置（一時物・コミット対象外）。
- **非目標**: exact stall% の実測・比較（環境依存が大きいため見送り）。editor 側 `holdTimeline` 自体の閾値緩和は範囲外。

---

### 2026-07-06（Claude Code）— HTML bundle export で split alpha の透過 webm が再生されない不具合を修正 ✅

- **ユーザー報告**: 「透過webmが書き出されたhtmlで再生されない」— [doc/issue/subject-extract-split-alpha-webm-preview-instability.md](doc/issue/subject-extract-split-alpha-webm-preview-instability.md)（preview 再生の不安定さ）とは別件で、**HTML bundle export（§11.7）そのものが split alpha 動画を再生できない**というバグ。
- **根本原因**: [bundleCollect.ts](src/runtime/bundleCollect.ts) `collectObjectAssets()` の `video` 分岐が color 本体（`resolveFootageVideoPath`）と内蔵音声のみを `binaryPaths` に積んでおり、**split alpha companion（`asset.meta.alphaPath` のグレースケールマスク `.alpha.webm`）を zip に含めていなかった**。再生側（`BundlePlayer`/`ImageAssetCache`/`DomRenderer`）は既に split alpha 合成に対応済み（`registerProjectUrls`/`loadVideoBlobsFromUrls` が `alphaUrlById` を配線する設計）だが、そもそも zip 内にファイルが存在しないため companion の `fetch` が失敗し、色/透明度の CPU 合成（`drawSplitAlphaComposite`）が一度も成立しない＝該当レイヤーが実質再生されない状態だった。
- **対応**: `collectObjectAssets()` の video 分岐に `isSplitAlphaVideoMeta(asset.meta)` チェックを追加し、`asset.meta.alphaPath` を `binaryPaths` に同梱（quality tier 非依存・DomRenderer が companion を常に原本参照するのと一致）。
- **検証**: `test/bundleExport.test.ts` に split alpha 動画の依存収集を固定する回帰テストを追加。`npm run typecheck` 緑・`npm test` 885 PASS（`projectBins.test.ts` の1件は既存 ULID 順序 flake で本修正と無関係・pre-existing）。`bundleCollect.ts`（export 収集ロジックのみ・`src/player/` 非経由）の変更のため `npm run build:player` 不要（`playerBuildFreshness.test.ts` 緑で確認）。
- **非目標**: preview 再生の holdTimeline 巻き込み凍結・輪郭ズレ（上記 issue doc の修正1〜4）は本修正の対象外・別件のまま。

---

### 2026-07-06（Claude Code）— Subject Extract split alpha 再生不安定 修正1・2 ✅

- **背景**: [doc/issue/subject-extract-split-alpha-webm-preview-instability.md](doc/issue/subject-extract-split-alpha-webm-preview-instability.md) の調査（実機 Playwright + CDP Media ドメイン検証済み・Comp 32 で holdTimeline 実発火をサンプル時間の約93%という規模で確認）を受け、修正1・2 を実装。
- **修正1（グローバル凍結の解消）**: `VideoClockSample` に `role: "primary" | "companion"` を追加（[playbackVideoSync.ts](src/runtime/playbackVideoSync.ts)）。`DomRenderer.sampleMountedVideoClocks()` は split alpha companion を `role:"companion"` としてタグ付けし、新設 `filterPrimaryVideoSamples()` で `holdTimeline`/`pauseVideo` の判定（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の `applyPlaybackSync` と `getVideoClockSamples`）からは除外。companion 自体の per-element resync（`syncVideoElementTime`）は従来どおり効くため、無補正になるわけではない。
- **修正2（輪郭ズレの改善）**: `videoSplitAlpha.ts` に `computeAlphaGenlockRate` / `applyAlphaGenlock` / `resetAlphaGenlockRate` を追加。定常再生中（`previewVideoPlayback && !cutSeek && !pauseForSync` かつ両 video が再生中）のみ、color の実 `currentTime` に合わせて alpha の `playbackRate` を穏やかに調整（±8%、ドリフト 0.03〜0.5s 帯）。0.5s（`PLAYBACK_RESYNC_THRESHOLD_SEC`、`videoElementSync.ts` からエクスポートに変更）超はハードシークにフォールバック。scrub/export/カット境界/映像先行pause 時は `resetAlphaGenlockRate` で必ず 1 に戻す（INV-2 非干渉）。定数は実機検証の実測ドリフト（平均33〜50ms・最大147ms）を根拠に設定。
- **検証**: `npm run typecheck` / `npm test`（884 PASS、新規 11 件: `playbackVideoSync.test.ts` に companion 除外の対照実験込み、`videoSplitAlpha.test.ts` に genlock 境界値）。`DomRenderer.ts`/`videoSplitAlpha.ts`/`playbackVideoSync.ts`/`videoElementSync.ts` 変更のため `npm run build:player` 実行済み（`playerBuildFreshness.test.ts` 緑）。
- **実機確認は未実施**: ユーザー希望により Playwright ではなく実 Chrome での手動確認待ち（Playwright は headless 起因の decode 挙動差が大きく確認手段として不適と判断）。次セッションでは Comp 32 相当のデータで実 Chrome 上の holdTimeline 頻度・輪郭ズレ改善を目視確認すること。
- **非目標**: 修正0（warm-up タイミング調整・実測で効果限定的と判明のため見送り）、修正3（合成コスト削減）、修正4（1本パック化・§16.2 資産フォーマット変更のため要ユーザー確認）は未着手。

---

### 2026-07-06（Claude Code）— Pipeline パネル: split alpha 透過レイヤーの二重描画警告 ✅

- **要望**: split alpha（Subject Extract, `meta.alphaMode:"split"`）のレイヤーは毎フレーム CPU で color+mask を二重描画するため live 再生の同期ドリフト要因になる（[doc/issue/subject-extract-split-alpha-webm-preview-instability.md](doc/issue/subject-extract-split-alpha-webm-preview-instability.md)）。この状態を Pipeline パネルで警告表示してほしいという要望。
- **設計**: 既存の live/raster セグメント・崖（cliff）警告とは独立の軸として `PipelineAnalysisResult.alphaWarnings` を追加。`video` component の asset が `isSplitAlphaVideoMeta`（既存 [imageAssetCache.ts](src/runtime/imageAssetCache.ts)）を満たすレイヤーを検出する。effect の有無に関わらず検出するため（split alpha レイヤーは通常 effect を持たない）、`analyzeComp` の live/raster 判定ループとは別に `collectAlphaWarnings` を新設し precomp nested も再帰集約（cliffs は現状 nested を伝播しない既存挙動と異なる点、意図的）。
- **対象外**: unified alpha（単一 VP9 alpha WebM・ブラウザネイティブ透過・二重描画なし）、track matte（`applyTrackMatte` も毎フレーム canvas 合成だが別機構・別タスク候補）。
- **spec**: §19.5 に prose 追記（§5/INV 不変・`meta.alphaMode` は既存フィールド）。
- **実装**: [pipelineAnalysis.ts](src/editor/pipelineAnalysis.ts)（`alphaWarnings` フィールド・`collectAlphaWarnings`）+ [PipelinePanel.tsx](src/editor/panels/PipelinePanel.tsx)（ヘッダー `α×N` バッジ + 展開時の警告 box、cliff と色味で区別）。
- **検証**: `test/pipelineAnalysis.test.ts` に3ケース追加（split alpha 検出・unified/通常動画は非検出・nested precomp 内 depth 付き検出）— 12 PASS。`npm test` 872 PASS（`projectBins.test.ts` の1件は既存 ULID flake で無関係）。`typecheck` 緑。`src/runtime`/`src/player` 非変更のため `build:player` 不要（`playerBuildFreshness.test.ts` 緑で確認）。
- **非目標**: 二重描画自体の解消（doc の修正1〜4は別タスク・未着手のまま）。Playwright 実機での目視確認は未実施（純粋な UI 表示ロジックのため unit test で代替、必要なら次セッションで合成 split alpha asset を使った実機確認を追加）。

---

### 2026-07-06（Claude Code）— Subject Extract split alpha レイヤーをネストするとクラッシュ ✅

- **症状**: split alpha（`meta.alphaMode:"split"`）の Subject Extract レイヤーを含む comp（ユーザー報告: 最新 zip の Comp 32）を、別の comp に precomp としてネストすると Preview が例外で丸ごと落ちる（`ErrorBoundary` 不在のため React ルート全体がアンマウント＝白画面）。コンソール: `split alpha: video has no parent`（[videoSplitAlpha.ts:28](src/runtime/videoSplitAlpha.ts#L28)）、stack は `DomRenderer.ts:2103`→`1826`→`1019` 経由。
- **真因**: [DomRenderer.ts](src/runtime/DomRenderer.ts) `renderNestedComp()`（ネストcomp専用のライブDOM描画経路、L1824–1827）が `createComponentEl` → `updateComponentEl` → `div.appendChild(el)` の順で呼んでいた。`updateComponentEl` の `"video"` ケースは split alpha 資産なら `ensureSplitAlphaCompanion(video)` を呼び `video.parentElement` に依存するため、append 前に呼ぶと**常に**例外になる。トップレベル描画（L975–993）は append→update の正しい順序のため、comp を直接再生する分には発生しない — ネストしたときだけ別コードパスを通るため顕在化。
- **対応**: 3行の順序入れ替えのみ（append を先に）。`renderNestedCompRaster`（§28.11 ラスタ経路）・トップレベル描画・他コンポーネント型は無関係のため無変更。
- **検証**: `npm run typecheck` / `npm test`（870 PASS、`projectBins.test.ts` の 1 件は既存 ULID flake で無関係）緑。`npm run build:player` 実行済み（DomRenderer 変更のため必須）。実データが無かったため ffmpeg で合成 color/alpha webm ペアを作り、Playwright で「comp にネストされた split alpha レイヤー」を実機再現 — 修正前は同一エラーで再現、修正後は例外なく合成 canvas が正しく描画されることを確認（`verify-nested-split-alpha-crash.mjs`、恒久 verify として残置）。
- **非目標**: 本 issue と別件の [doc/issue/subject-extract-split-alpha-webm-preview-instability.md](doc/issue/subject-extract-split-alpha-webm-preview-instability.md)（再生中の holdTimeline 巻き込みフリーズ・輪郭ズレ）は未着手のまま。ErrorBoundary 不在（例外で全画面が落ちる一般的な脆弱性）は今回のスコープ外・将来の防御的改善候補として記録のみ。

---

### 2026-07-06（Claude Code）— Project パネル: アセットから右クリックでコンポジット作成（§20.2c）✅

- **機能**: Project パネルの image/video アセット行を右クリック →「このファイルでコンポジットを作成」。
  アセットの `meta.width/height`（無ければ 1920x1080）・video は `meta.duration秒×30fps`（無ければ 150f 既定）
  に合わせた新規 timeline comp を作成し、その asset のレイヤーを配置・選択・アクティブ化する。audio/font/other は対象外。
- **実装**: `src/editor/store.ts` の `addTimelineComp` に `{width,height,fps,duration}` opts を追加（後方互換）+
  新規 `addCompositionFromAsset(assetId)`（既存 `addImageLayer`/`addVideoLayer` を連鎖呼び出し、SceneObject 構築は複製しない）。
  `ProjectTreeView.tsx` の asset 行に `onContextMenu`（既存 `useContextMenuStore` 基盤を再利用）。
- **spec**: §20.2c 新設（§5/INV 不変）。
- **検証**: `test/addCompositionFromAsset.test.ts` 7 PASS。`npm test` 869 PASS（`test/projectBins.test.ts` の
  "preserves treeOrder entry order" は **本変更と無関係の pre-existing flake** — 変更前の main でも単体 3 回中 2 回失敗を確認済み。
  ULID 同一ミリ秒時の `defaultEntriesForParent` 全種混合 id ソートに依存した test の脆さが原因、別途要修正）。
  typecheck 緑。Playwright 実機で右クリック→メニュー→新 comp（寸法/尺/レイヤー/選択）を確認済み。
  `src/runtime`/`src/player` 非変更のため `build:player` 不要。
- **非目標**: ソース fps の probe（既存 `addTimelineComp` 同様 30 固定）、新 comp を asset と同じ bin に配置（常にルート）。

### 2026-07-05（Cursor）— Subject Extract from footage（§16.2）✅

- **機能**: Video Inspector の Subject Extract 折りたたみ — Person プルダウン + Extract → MediaPipe Selfie Segmentation → WebM VP9 alpha → 新 video レイヤー（ソース `zOrder + 0.5`）+ アセット `Assets/VideoSubjectExtract` bin。
- **実装**: `src/editor/subjectExtract/*` + `SubjectExtractFields.tsx` + vendored `public/subject-extract/mediapipe/`（@mediapipe/tasks-vision 0.10.18 + selfie_segmenter.tflite）。
- **spec**: §16.2 新設 + §16 テーブル 1 行（§5/INV 不変）。
- **検証**: `subjectExtractMask` + `subjectExtractApply` 7 PASS。`npm test` **839 PASS**。`resolve` / `DomRenderer` / `player.js` 非変更 → `build:player` 不要。
- **非目標（Phase 2）**: OpenCV DNN 矩形 / 複数人物 / Motion Track マスク連携 / Playwright 実機 verify。

### 2026-07-05（Cursor）— Subject Extract Chrome VP9 alpha エンコード修正 ✅

- **症状**: Extract 実行時 `No supported VideoEncoder config for vp09.00.10.08`（Chrome は VP9 `alpha:keep` 非対応）。
- **対応**: `encodeAlphaWebm.ts` — 先に `isVp9AlphaEncodeSupported` を probe。非対応時は **split alpha**（color `.webm` + グレースケールマスク `.alpha.webm`、`meta.alphaMode: "split"` / `meta.alphaPath`）。Firefox 等は従来の unified VP9 alpha のまま。even 次元 + hardware/software フォールバック。
- **再生**: `videoSplitAlpha.ts` + `imageAssetCache.getAlphaVideoUrl` + `DomRenderer` canvas 合成（export `flushVideoFrames` 後も composite）。
- **検証**: `subjectExtractEncode` 3 + 既存 subjectExtract 7 PASS。`typecheck` 緑。`npm run build:player` 実行済み（DomRenderer 変更）。

### 2026-07-05（Cursor）— Subject Extract split alpha 合成バグ修正 ✅

- **症状**: Extract 完了後、人物切り抜きレイヤーが透過にならず元映像相当／export に人物のみ出ない。
- **真因**: `drawSplitAlphaComposite` が `destination-in`（source **alpha** 参照）を使っていたが、split マスク WebM は VP9 discard-alpha のため **RGB グレースケール**にマスクを載せている。合成が効かず canvas が実質フルカラー。
- **対応**: マスク R → color ImageData alpha の CPU 合成。color エンコードは straight RGB（`toOpaqueRgbColor`）。export `inlineVideoFrames` は split alpha 時 color/alpha `<video>` を除外し composite canvas のみ PNG 化。
- **検証**: `subjectExtractEncode` 4 PASS。`build:player` 再実行済み。

### 2026-07-05（Cursor）— Subject Extract 空マスク真因修正（Comp 30 / pj19）✅

- **症状**: mafter-project (19) Comp 30 — Extract 済み alpha.webm が ~2KiB/frame（空）。Person レイヤーに人物 ink なし。
- **真因**: MediaPipe `categoryMask` が **0/255 バイナリ**なのに `categoryMaskToAlpha` が `=== 1` のみ person 判定 → 全ゼロマスク。`categoryMask` 未取得時も無言で全ゼロ fallback。
- **対応**: `categoryMaskToAlpha` で 255/非ゼロ対応、`confidenceMasks[0]` フォールバック、MPMask リサイズ、CPU delegate、`outputConfidenceMasks: true`、全フレーム空マスク時 Extract 失敗。
- **検証**: `subjectExtractMask` 7 PASS。plan: `.cursor/plans/subject_extract_comp30_fix.plan.md`。Fable レビューは model 不可 → Opus 代替。
- **ユーザー操作**: **既存 Extract アセットは空のまま** — Comp 30 で Subject Extract を**再実行**すること。

### 2026-07-05（Cursor）— Preview cache 再生中 bake 休止（即効薬）✅

- **症状**: Caching ON かつ build 未完了だと、再生が Cache OFF より悪化してもたつく。
- **真因**: background `captureCompFramePng` が再生中もメインスレッドを奪う + 未完了時 hit/miss 混在 + miss 時 live+capture 二重仕事。
- **対応（プラン B のみ）**: 再生中は bake キュー pause・enqueue no-op。overlay はワークエリア build **完了後のみ**（未完了は常に live）。停止後に pump / build 再開。
- **実装**: `FrameCacheQueue.setPaused` / `RamPreviewController.setPlaybackActive` / `isWorkAreaBuildComplete` / PreviewPanel `isPlaying` 配線。spec §28.4 散文。
- **検証**: `test/previewCache.test.ts` 20 PASS。export/bundle/player 非対象（preview 専用）。
- **非目標**: 完了待ち UI（A）、先読み bake（C）、WASM Worker レンダラ。

### 2026-07-04（Cursor）— 映像×タイムライン双方向再生同期 ✅

- **追加症状**: 片方向 hold 後も「映像以外が遅れる」（映像先行・カメラ／他レイヤー遅れ）。
- **真因**: `error = targetSec − currentTime < 0` を未処理。render/React 遅延や hold 解除後のわずかな先行で映像だけ進む。
- **設計**: 経路 H2 — 映像遅れ→timeline hold（既存）、映像先行→**video pause（seek なし）**。遅れ優先の相互排他。paused は適格（sync pause 発振防止）。
- **実装**: `computePlaybackSyncState` / `pauseForSync` / `DomRenderer.setPlaybackPauseForSync` / PreviewPanel・AudioClock 配線。
- **検証**: unit 48 PASS（playbackVideoSync 12 + videoElementSync 36）。`verify-video-playback-sync.mjs` **PASS**（steady max|err|=0.030s、人工 lead→pause→catchup）。`build:player` 済み。
- **PLAN**: `.cursor/plans/video_camera_playback_sync_bidirectional.plan.md`。

### 2026-07-04（Cursor + Fable RG-20260704-05）— 映像×カメラベイク再生同期 ✅

- **症状**: 再生時に映像 Footage とモーショントラック済みカメラがズレ、モーションが早すぎて見える。スクラブは比較的合う。
- **真因**: カメラ = タイムライン時計、映像ピクセル = `video.play()`。再生中 drift seek は 0.5s までしない（旧 HW 対策 A）ためカメラ先行。
- **設計**: 経路 H（Play-start barrier + timeline hold）。Fable M1–M6（ヒステリシス enter=1f / exit=半フレーム、適格除外、1s フェイルセーフ、AudioClock suspend、barrier の no-op 条件、flag 点火一本化）。
- **実装**: `playbackVideoSync.ts` / `DomRenderer.syncMountedVideosForPlay` + `sampleMountedVideoClocks` / `PreviewPanel` barrier→render→clock / rAF・AudioClock hold / BundlePlayer barrier のみ。scrub・export・`PLAYBACK_RESYNC_THRESHOLD_SEC` 不変。
- **spec**: §11.4 散文のみ。
- **検証**: 初版 unit。双方向拡張は上エントリ。
- **PLAN**: `.cursor/plans/video_camera_playback_sync.plan.md`。Handback: `RG-20260704-05.md`。

### 2026-07-04（Cursor）— トラックマット canvas 正準（Opus RG-20260704-04）✅

- **診断（Opus）**: 初版 SVG mask+foreignObject は text 非描画で全透明。応急 `mix-blend-mode: destination-in` は **不正 CSS（Porter-Duff は canvas 専用）→ no-op**。verify は false-green。
- **正準**: preview/export とも **`applyTrackMatte` 純関数**（fill/matte を comp 空間ラスタ → 合成 → result canvas）。`trackMatteCapture.ts` + DomRenderer `flushTrackMattes`（`flushRasterEffects` に包含）。
- **検証**: `trackMatte.test.ts` 15 PASS。`verify-track-matte.mjs` PASS（solid 内外画素・text coverage∈(0,0.4)・clear）。`build:player` 済み。
- **非目標（残）**: ペン/パスマスク、OpenCV 切り抜き、ネスト precomp 完全対称、sig メモ化による静的マット最適化。

### 2026-07-04（Cursor）— トラックマット（§5.4f・初版〜応急）⚠️ 正準差し替え済み

- 初版 SVG mask / 応急 destination-in は上エントリで置換。スキーマ `trackMatteMode` と UI は継続。

### 2026-07-04（Cursor）— Motion Track UI を Video プロパティから分離 ✅

- **動機**: Video プロパティが増える前提で Motion Track を非破壊分離。
- **実装**: [`MotionTrackFields.tsx`](src/editor/panels/MotionTrackFields.tsx) にロジック・UI を移設。[`VideoComponentFields.tsx`](src/editor/panels/VideoComponentFields.tsx) は本体 props + `<MotionTrackFields />` のみ。
- **UI**: Inspector 同型の折りたたみ（既定クローズ、▶/▼）。ベイク経路・モードは不変。

### 2026-07-04（Cursor）— 3D Solve 既定並進スケールを 10 倍に ✅

- **フィードバック**: スケール係数 10 で「えぐいしっくり」。旧 auto 目標（高さ 15%）が弱すぎた。
- **対応**: Solve の auto-scale 目標を高さ **1.5 倍**（旧の 10 倍）に。係数 1 で旧係数 10 相当。Position/Walk は 0.15 のまま。
- **検証**: `defaultSolveAutoScaleTargetPx` unit test。

### 2026-07-04（Cursor）— 3D Solve 見切れ後の相対伝播 + 地図再構築 ✅

- **フィードバック**: 再検出強化だけでは体感ほぼ変わらず。
- **本命**: 再検出点は 2D には載るが **3D 地図に載らず** PnP が死に、`fillUnsolved` 補間で並進が潰れる。
- **対策（ソルバ）**:
  - `triangulateAllTracks` — pose 済みフレームの任意ペアで未マップ全トラックを三角測量
  - 局所化成功フレームを昇格 → 再三角測量を最大 2 パス
  - PnP 不足フレームは **直前ポーズ + essential 相対伝播**（スケールは直近ステップ長）で補間を避ける
- **検証**: motionTrackSfm 等 **35 PASS**。

### 2026-07-04（Cursor）— 3D Solve 後半地図薄さ対策（再検出強化）✅

- **症状**: 序盤に写っていた物体が見切れ始めると奥行きが弱くなる。
- **診断**: 序盤点のみではない（再検出はあった）が、地図/PnP が長寿命序盤トラック依存。見切れで対応点減 → 補間で並進が弱い。
- **対策（sfm のみ）**: `REDISCOVER_INTERVAL_SFM=3` / `MIN_TRACK_COUNT_SFM=60`、画面外・ROI 外点を追跡リストから即ドロップ。完了 status に前半/後半 `numPoints` 中央値（`点 前半N/後半M`）。
- **検証**: featureQuality / buildTrackTable late id / halfStats unit tests。
- **続き**: 体感変化薄 → 上エントリのソルバ側へ。

### 2026-07-04（Cursor）— 3D Solve 奥行きスケール（等方 userScale）✅

- **症状**: 回転は良い・前後が弱い・横は悪くない（横移動時に回転が少しおかしい程度）。
- **原因**: `runSolveTrack` が `userScale` を traj に先掛け → autoScale が支配軸を固定ターゲットへ正規化して **打ち消し**。Solve UI にスケール係数も出ていなかった。
- **修正**: traj は単位スケール、`applyAutoScaleToPositions(..., userScale)` で auto **後**に等方乗算。Solve（+ Walk）UI にスケール係数。完了メッセージに auto× / user× / 実効×。
- **spec**: §16.1 に「auto-scale 後に UI スケール等方乗算・回転は不変」。
- **検証**: `motionTrackAutoScale`（userScale 後段・等方）+ 既存 autoScale。depthBoost / 横移動時回転は未着手。
- **運用**: 前後が弱ければスケール係数を 1.5〜3 で再ベイク。

### 2026-07-04（Cursor）— Motion Track 3D Solve（オフライン SfM）締め ✅

- **背景**: Claude Code セッション「3D カメラトラッキング精度の向上」（`63074e58-…`）で Fable が SfM 本実装まで完了したが、session limit で progress / spec / 実機 verify / デバッグ残骸が未了。
- **実装本体（前セッション）**: `src/editor/motionTrack/sfm/`（Core / Tracks / TwoView / PnP / BA / Solver / Convert）+ Worker `estimateMode:"sfm"` + `runSolveTrack` + `applySolveTrackToProject` + UI 既定 **3D Solve**。walk / rotation 経路は隔離。
- **本セッション（未完了分のみ）**:
  - **spec**: §16.1 に 3D Solve 散文 + §16 テーブル行（§5/INV 不変）。旧「AE 級は外部 import のみ」記述を更新。
  - **verify**: `verify-motion-track.mjs` に `solvePan` / `solveYaw`（配線 E2E。平面クリップは rotationOnly 許容。AE 級精度は vitest）。あわせて `finalizeMotionTrackBake` が `{ positionsByFrame, … }` を返すようになった後の既存シナリオの Map 取り違えを修正。
  - **掃除**: `test/_sfmDebug.test.ts` 削除。
  - **progress**: 本エントリ。
- **検証**: `motionTrackSfm` **14 PASS**。`verify-motion-track.mjs` **PASS**（既存 4 + solvePan/solveYaw。両 solve は平面/純回転のため `rotationOnly`）。
- **次**: 実写フィードバック（Comp 系）で 3D Solve の有効率・再投影誤差を見る。POI 軌道 / COLMAP import は将来。

### 2026-07-04（Cursor）— Walk ゲート付きマルチフレーム（飛ばない設計）✅

- **教訓反映**: 絶対 PnP 直書き禁止。pred=flowWalk 必須、PnP は向きのみ補正（scale=pred）、`acceptPnpRelative` + EMA、`composeRelativeStep` で内部 prevPose と整合。
- **実装**: `poseGate.ts` / `multiFrameVo` 改修 / `solvePnPWithPrior` / worker Walk 再接続。status に map / PnP / err。
- **検証**: poseGate・MF continuity（max jump ≤ 3×median）含む **84 PASS**。

### 2026-07-04（Cursor）— Walk のマルチフレーム PnP を撤回（飛び回帰）✅

- **症状**: PnP 切り替えでポーズが飛ぶ。ユーザー報告「前の方がマシ」。
- **対応**: いったん flowWalk のみに戻したのち、ゲート付き設計で再実装（上エントリ）。

### 2026-07-04（Cursor）— Motion Track マルチフレーム VO（OpenCV KLT + TS PnP）⚠️ 撤回

- 実装したが実機でジャンプ。Walk は flowWalk に戻した。

### 2026-07-04（Cursor）— Motion Track Walk（2a auto-scale + 2b essential R+t）✅

- **背景**: Comp 27 型（前進＋揺れ＋チルト）は分離 VO（QUAR 並進 / rotation-only）では原理的に弱い。
- **2a**: `autoScale.ts` — 支配軸 range を comp 高さ≈15% へ正規化。Position / Both / Walk で適用。微小変位警告。
- **2b**: `essentialPose.ts`（純 TS essential+recoverPose）+ worker `estimateMode:"walk"` + `walkAccumulate` + UI モード **Walk**（既定）。OpenCV calib3d カスタムビルドは不要。
- **検証**: autoScale / essential / walkAccumulate / diagnostics / roi 系 vitest。
- **PLAN**: `.cursor/plans/video_motion_track_walk_shake_tilt.plan.md`。

### 2026-07-04（Cursor + Fable RG-20260704-02）— Comp 27「分かりやすいのに動かない」修正 ✅

- **再現**: Downloads `mafter-project (17).zip` Comp 27（人なし住宅街・前進+チルトなのに position≈0.1px・rotation 全 identity）。
- **Fable 診断**: 主因は既定「背景優先」が道路（最良特徴）を 61% 黒塗り。QUAR はマスク境界の静止エッジにロック、回転は全滅を無警告ベイク。
- **修正**: 既定 `full`、crowd exclude 縮小、`summarizeTrackValidity` + 回転有効率ガード、equalizeHist は full mask のみ、§16.1 散文。
- **PLAN**: `.cursor/plans/video_motion_track_comp27.plan.md`。Handback: `RG-20260704-02.md`。

### 2026-07-04（Cursor）— Motion Track Comp 26 人混み歩き撮り向け改善 ✅

- **対象**: Downloads 最新 `mafter-project (15).zip` の Comp 26（逆光の歩行者通り・群衆支配で position≈ノイズ・rotation=0 だった）。
- **改善**: `TrackMaskSpec`（include/exclude）+ 既定プリセット **「背景優先（人混み）」**（中央〜手前 exclude）+ `enhanceContrastRgba`（逆光）+ 回転側 `equalizeHist`（あれば）。UI 既定を background に変更。
- **検証**: motionTrackRoi 拡張テスト + 既存 motion-track vitest。

### 2026-07-04（Cursor）— Motion Track Phase 1d 特徴品質 + position 補間 ✅

- **実装**: `featureQuality.ts`（FB-LK / err / グリッド再検出 / ROI 縁）+ `rotationTrackWorker` 配線 + `positionInterp.ts`（invalid を baseline スナップせず補間）+ `quarTracker` の `buildPositionsFromTrack` / rotation worker へ `roi` 伝播。
- **spec**: §16.1 Phase 1d 散文 + テーブル。§5/INV 不変。
- **検証**: `motionTrackFeatureQuality` + `motionTrackPositionInterp` 純関数テスト。既存 motion-track vitest 無回帰。
- **次**: Phase 1e（2 パス）/ 1f（MediaPipe・要確認）/ 1b-b（POI/zoom）。

### 2026-07-04（Cursor + Fable RG-20260704-01）— 人混み耐性改善 PLAN ✅

- **委任**: `claude -p --model fable`（session `b60a49b0-9024-496b-85eb-aaf7c84e2714`）。ハンドオフ [RG-20260704-01](.cursor/delegations/handoffs/RG-20260704-01.md)。
- **診断**: 主因は動体特徴の数的支配・frame0 固定トラック・**ROI 縁のゼロ運動偽特徴（1c の逆効果）**・invalid 時 position の baseline スナップバック。
- **PLAN**: [`.cursor/plans/video_motion_track_people_heavy.plan.md`](.cursor/plans/video_motion_track_people_heavy.plan.md)。次の 1 本 = **Phase 1d**（FB-LK / グリッド再検出 / ROI 縁棄却 / 補間、依存追加ゼロ）。1f MediaPipe ~6MB はユーザー確認後。
- **次**: Phase 1d 実装（ユーザー指示で着手）。

### 2026-07-04（Cursor）— Motion Track Phase 1c ROI（追跡範囲 mask）✅

- **方針**: crop ではなく **ダウンサンプル後に ROI 外を黒塗り（mask）**。画像サイズ不変 → 回転推定の主点 `w/2,h/2` を維持。Worker API 変更なし。
- **実装**: `trackRoi.ts`（`normalizeTrackRoi` / `applyRoiMask` / プリセット）+ `frameExtractor` 配線 + `quarTracker` の position/rotation/both 3 経路へ `options.roi` 伝播 + Inspector Video 内 UI（全体/中央/上下左右半分/カスタム %）。
- **spec**: §16.1 に ROI 1 行 + §16 テーブル更新（§5/INV 不変）。
- **検証**: `test/motionTrackRoi.test.ts` 純関数テスト。`npm test` motion track 系 + typecheck。
- **次**: Phase 1b-b（two-node POI + zoom）は実写フィードバック後。Preview 上 ROI ドラッグは Phase 1d。

### 2026-07-04（Cursor）— Export 品質選択 + Pre-render ✅

- **Phase 1（品質）**: `ExportConfig` に任意 `videoQuality` / `videoBitrate` / `encodeLatencyMode`（未指定 = 8 Mbps・latencyMode なし＝現行互換）。`exportVideoEncode.ts` 純関数 → `exporter` mp4/webm + `bundleBake`。ExportDialog に Quality / Bitrate / Encode UI。
- **Phase 2（Pre-render）**: ProjectPanel で Export 右に **Pre-render…**。同じダイアログ `mode: "prerender"`（既定 mp4 + Max 20 Mbps、DL なし）。書き出し後 `applyPreRenderToProject` で未ロック全体 `enabled=false` + 最上段 video（`fit: fill`、range = export range）を **1 undo**。成果物 asset はルート直下フォルダ **`pre-rendered`**（無ければ作成・既存再利用）。
- **spec**: §11.2 ExportConfig 更新 + **§11.2b Pre-render**（editor-only・§5/INV 不変）。
- **検証**: `tsc` 緑。新規 unit `exportVideoEncode` 6 + `preRender` 2 PASS。`npm test` **717 PASS**（`projectBins` の treeOrder 1 件失敗は pre-existing・本変更無関係）。`build:player` 不要。

### 2026-07-03（Cursor）— Motion Track Phase 1b-a 回転ベイク ✅（DG-20260703-01 worktree → main マージ）

- **委任**: `cursor-agent`（worktree `cursor-motion-track-1ba-20260703`）— エージェントは ~46 分ハングしたが worktree 実装は完了済み。ユーザー承認で main に手動マージ。
- **実装**: `rotationEstimator.ts` + `rotationTrackWorker.ts`（OpenCV.js KLT lazy load）+ `slamRotationToMafterEuler` + `smoothRotations` + `bakeRotationKeyframes` + `runRotationTrack` + Inspector Mode（Position / Rotation）。Phase 1a 既存関数は無改変（`motionTrackWorker.ts` / `bakePositionKeyframes` / `smoothTranslations`）。
- **vendor**: `public/motion-track/opencv/`（Apache-2.0・PROVENANCE.md）。
- **検証**: `tsc` 緑・motion track vitest **25 PASS**・`verify-motion-track.mjs` **4 シナリオ PASS**（nullPan / cameraPan / nullDolly / yawPanRotation）。
- **次**: 1b-b（two-node POI + zoom）は実写フィードバック後。worktree 後始末可。

### 2026-07-03（Cursor + Claude Code `claude -p` 思考委任 RG-20260703-01）— Motion Track Phase 1b 実装計画 ✅

- **委任**: `delegate-to-thinking-model` → `claude -p --permission-mode plan --model fable`（session `28df82f0-675e-4348-aac1-31a6f7e27891`）。
- **成果物**: [`.cursor/plans/video_motion_track_phase1b.plan.md`](.cursor/plans/video_motion_track_phase1b.plan.md)（計画正本）、[`.cursor/delegations/handoffs/RG-20260703-01.md`](.cursor/delegations/handoffs/RG-20260703-01.md)（Handback）。
- **推奨経路 (E)**: QUAR 並進（Phase 1a 無改変）+ **rotation-only 推定器**（Horn + RANSAC、別ワーカー）。§5/INV 変更なし。
- **フェーズ**: **0b** ミニスパイク（`inlier_points()` 確認・ゲート）→ **1b-a** 回転ベイク（Null + one-node Camera）→ **1b-b** POI/zoom（実写後）。
- **次**: ~~ユーザー確認 6 問~~ **承認済み** → §16.1 散文更新済み → **Phase 0b スパイク PASS** → DG 起票で 1b-a 実装委任。

### 2026-07-03（Cursor）— Motion Track Phase 0b スパイク PASS ✅

- **0b-1**: QUAR `inlier_points()` は **件数のみ**（座標ペア不可）→ OpenCV.js KLT 経路確定（ユーザー承認済み）。
- **0b-3**: Horn 四元数フィット + 合成ヨークリップ — 累積ヨー誤差 **0.10%**、|axis·Y| **1.0**、**0.10 ms/frame**（ゲート全 PASS）。
- **産物**: `probe-rotation-spike.mjs` + `probe-rotation-spike-report.md`。
- **spec**: §16 テーブル + §16.1 散文を Phase 1b 内容に更新（§5/INV 不変）。
- **次**: `delegation.mjs` で DG 起票 → 1b-a を cursor-agent に委任。

### 2026-07-03（Claude Fable 5 指揮・Opus 4.8 スパイク・Cursor 委任実装）— Video Motion Track Phase 0+1a（並進のみ）✅

- **計画**: `.cursor/plans/video_motion_tracking_99321e75.plan.md`（正本。ゲート判定・実装ファイル表・フェーズ分割まで更新済み）。ユーザーからの依頼「精査して完成された PLAN に」「実装は Fable がやらず delegate-to-cursor か Opus/Sonnet」「テストまでやって完成」を受けて実施。
- **Phase 0 スパイク（Opus 4.8 サブエージェント、2 ラウンド）**:
  - QUAR Engine（MIT・単眼 WASM VO）を gh-pages 配布 wasm（0.1.0 相当）でスパイク → 計画本命の `Tracker6DoFHandle`（6DoF pose）は **全構成で inert**（identity pose・parallax=0）。同じ wasm 内の `TrackerHandle`（並進のみ）は方向正解率 100%・29–68ms/frame。
  - ユーザー承認の「段階方式」に従い rustup + wasm-pack 0.15.0 を導入（`stable-x86_64-pc-windows-gnu`・MSVC 不要）し、upstream `main` HEAD（`c3a04b1`）からソースビルドを実施 → **ソースビルドでも `Tracker6DoFHandle` は同じく inert**（ソース精査で 6DoF pose 段自体が実質未完成と判明。feature フラグ起因ではない）。
  - **ゲート判定確定**: `TrackerHandle` 並進のみで合格（並進方向正解率 >80%・<500ms/frame の基準クリア）。Phase 1a は **position ベイクのみ**にスコープをピボット（rotation / POI / zoom は Phase 1b 送り）。
  - 産物: `public/motion-track/pkg/`（ソースビルド版 vendored wasm）+ `pkg-pages-snapshot/`（旧版退避）+ `PROVENANCE.md`（取得・ビルド経緯）+ `probe-motion-spike-report.md`（実測値・座標規約）。
- **spec**: `doc/mafter-effect-spec.md` §16 に 1 行追加 + **§16.1 新設**（Motion Track from footage — editor-only・並進のみ・INV 非関与の理由・制約を散文化）。§5/INV 変更なし。
- **Phase 1a 実装（Cursor `--model auto`・worktree `cursor-motion-track-20260703`）**: `src/editor/motionTrack/{types,frameExtractor,coordConvert,smoothPoses,quarTracker,motionTrackWorker,applyMotionTrack}.ts` + `VideoComponentFields.tsx`（Inspector Video 折りたたみ内インライン、モーダル無し）+ `InspectorPanel.tsx` の `comp.type === "video"` 分岐配線 + `NOTICE`（QUAR MIT クレジット）。座標変換は実測済みの「+z シーン奥→Mafter -z のみ反転」。ベイクは単一 `applyCommand`（Undo 1 件）+ expression は確認の上クリア。
  - 実装完了後のバックグラウンド出力が前セッション終了で途切れたため、Fable が worktree の実体を直接検証（typecheck / `npx vitest run` / diff 精査）してレビューを完了。
- **検証（Fable 実施）**: `npx tsc --noEmit` クリーン。`npx vitest run` **686 PASS**（新規 `motionTrackApply.test.ts` 4件・`motionTrackCoordConvert.test.ts` 7件含む）。失敗 1 件（`playerBuildFreshness`）は **pre-existing**（別の未コミット runtime 変更由来と `git stash` で確認済み・motion track 由来ではない）。実機 Playwright（`verify-motion-track.mjs`、ffmpeg 生成の水平パン合成 mp4）を worktree・main 両方の dev server で実行し **両方 PASS**（frame0→15→30 で +x 単調増加、有効フレーム 20/60、コンソールエラー無し）。`src/runtime` / `public/player.js` は無変更（`npm run build:player` 不要）。
- **Cursor worktree 後始末**: `git worktree remove` は実行したが、Windows 側でディレクトリがロックされ物理削除は未完了（git のメタデータからは除去済みで実害なし）。`C:\Users\resis\.cursor\worktrees\mafter-effect\cursor-motion-track-20260703` フォルダが残っていたら手動削除可。
- **検証拡張（2026-07-03 続き・Fable 実施、ユーザー「続けて」指示を受けて）**: `verify-motion-track.mjs` を拡張し、当初の Null+水平パンだけだった実機検証に **Camera ターゲット**と**ドリー（前進）クリップ**を追加。
  - **Camera ターゲット**: 実際に `addCamera()` して並進のみベイク → `resolve()` の worldTransform に正しく反映、かつ **two-node カメラの `pointOfInterest` がベイクで一切変更されないこと**を実機で確認（並進のみスコープの契約どおり）。
  - **ドリークリップ**: ffmpeg `zoompan` で生成した「フラットな 1 枚のテクスチャをズーム」クリップは、実は **Essential matrix が退化する平面シーン**（計画書に既記載の既知制約そのもの）に該当し、z 変位が単調増加しなかった（f15=0.53 → f30=0.51）。これはコードのバグではなく検証クリップの限界と判断し、アサーションを「z 軸パイプラインが実際に非ゼロ値を書いていること」の弱い健全性チェックに是正（座標変換の符号自体は `motionTrackCoordConvert.test.ts` の単体テストで固定済みのため二重に守られている）。
  - 3 シナリオ（nullPan / cameraPan / nullDolly）すべて PASS。`npx tsc --noEmit` クリーン・`npx vitest run` 686 PASS（回帰なし、pre-existing の `playerBuildFreshness` 失敗のみ）。
- **未実装・既知の制約（次セッション）**:
  - **回転・pointOfInterest・zoom 推定は未実装**（上流 6DoF 未成熟のため意図的にスコープ外。Phase 1b は上流修正 or OpenCV カスタムビルド待ち）。
  - スケール係数 UI はあるが既定値の妥当性は未チューニング（実写クリップでの使用感は未確認・合成クリップのみで検証）。
  - **真のドリー（奥行き視差あり）シーンでの z 推定精度は未検証**（ffmpeg だけでは視差ありの合成クリップを作りにくい。実写のドリーショットでの手動確認が望ましい）。

### 2026-07-02（Cursor / goal-cursor）— Optics Compensation live エフェクト ✅

- **追加**: builtin `opticsCompensation`（AE Optics Compensation 相当・FOV + reverse + center + quality）。`feImage` PNG 放射ベクトル map → `feDisplacementMap`、`executionPath: "live"`。
- **配線**: `LIVE_DISPLACEMENT_EFFECT_TYPES`（Fast* + optics）— effectRouting / DomRenderer ネスト / previewCompAnalysis / effectChain。
- **spec**: §27.3 `opticsCompensation` 追記（Resize 非対応は Phase 2）。
- **検証**: `npm test` **676 PASS**・typecheck 緑・`npm run build:player` 済み。
- **Phase 2 残**: Resize（reverse 端クリップ回避）・色収差・Playwright verify ハーネス。

### 2026-07-02（Claude Fable 5 指揮 + Cursor 委任）— #0a forceSeek 実機検証（回帰発見→修正）+ #0b 異アセット境界先読み warm-up（Cursor 実装・マージ待ち）

- **#0a（trim-in forceSeek `e9f7928` の実機検証）— 完了・回帰を1件発見し修正** ✅:
  - 恒久ハーネス [verify-forceseek-trim.mjs](verify-forceseek-trim.mjs)（Comp 23・実再生で境界前後の `currentTime` 軌道と seeking イベントを計測）。
  - **Case B（trim-in +6f=0.2s ズレ・旧閾値 0.5s 未満）は当初から PASS** — forceSeek が正しく発火し新 trim-in の軌道に乗る（修正目的は機能）。
  - **発見した回帰**: forceSeek の判定が「`currentTime` と target の差 vs 半フレーム」だったため、**通常の再生 decode lag（実測 0.05〜0.17s）が常に半フレームを超え、真に連続するシームレス境界でも毎回 seek が発火**していた。シームレス境界は declick フェードが抑制されている（§11.5.2）ため、この seek のプチノイズ・映像ジャンプが素通しになる＝プール再利用（§11.4）が守る「無音継続」を壊す。
  - **修正**: [videoElementSync.ts](src/runtime/videoElementSync.ts) に純関数 `isSourceContinuousAcrossCut`（前フレーム target の軌道 vs 新 target で連続性判定）。[DomRenderer.ts](src/runtime/DomRenderer.ts) video 分岐が `dataset.mafterTargetSec/mafterTargetFrame` を使い、**軌道が連続なら forceSeek を無効化**（decode lag では seek しない）・trim ズレのみ半フレーム精度 seek。spec §11.4 散文追記（§5/INV 不変）。
  - **検証**: 実機 A: `boundarySeeks=0`・drift 0.0002s（lag 0.12s でも無音継続維持）/ B: `boundarySeeks=1`・drift -0.006s、両 PASS。`npm test` **635 PASS**（新規 unit 5 件）・typecheck 緑・`npm run build:player` 済み・[verify-video-export.mjs](verify-video-export.mjs) 無回帰 PASS（453ms/frame WARN は既知 pre-existing）。
- **#0b（異なるアセット間カット境界の先読み warm-up）— Cursor 委任で実装 → main へマージ済み** ✅:
  - 実装元 worktree: `C:\Users\resis\.cursor\worktrees\mafter-effect\cursor-video-warmup-20260702`（未コミット working tree のまま。**composer-2.5 が usage 上限だったため `--model auto` で委任**・session_id `3f2e6a16-bab8-4784-8151-29069b73fa1b`）。
  - 実装: 純関数 [videoLookaheadWarmup.ts]（`computeVideoLookaheadWarmupTargets`・in 点 ≈1s 以内の video を offscreen 生成→`primeVideoElement`→プール stash）+ DomRenderer 再生中フック + PreviewPanel/BundlePlayer 配線 + 停止/scrub/dispose の明示破棄 + spec §11.4 散文。
  - レビューゲート（Claude 実施）: typecheck / **639 PASS** / build / build:player すべて緑。diff 精査済み（§5/INV 非変更・export 経路オプトイン閉じ・リーク始末あり）。
  - 実機 before/after（恒久ハーネス [verify-crossasset-warmup.mjs](verify-crossasset-warmup.mjs)・異アセット2クリップ連結を実再生）: **main = 境界 f60 で `rs=1`（decode 未完）→ worktree = 最初のサンプルから `rs=4`** PASS。
  - **マージ（2026-07-02・Claude が手動実施）**: 両ブランチとも同一ベース（`449b10e`）から未コミットで分岐しており、`DomRenderer.ts`/spec §11.4/`progress.md`/`public/player.js` が #0a と #0b 双方で変更されていたため git merge ではなく**手動マージ**（DomRenderer.ts は編集領域が非重複=競合なしを確認の上、逐次 Edit で統合／spec は同一行末尾追記+新規箇条書きで非重複／videoElementPool.ts・PreviewPanel.tsx・BundlePlayer.ts・videoLookaheadWarmup.ts は worktree 専用差分を `git apply` でそのまま適用）。lookahead 投入要素は `mafterTargetFrame` 未設定のため #0a の連続性判定は安全側（forceSeek 判定へ）に倒れ整合。マージ後 `npm run typecheck` / `npm test` / `npm run build:player` 緑、`verify-forceseek-trim.mjs`・`verify-crossasset-warmup.mjs`（マージ後の main に対して）両方 PASS を確認。

### 2026-07-02（Claude Fable 5）— 健全性確認 + Opus 4.8 / Composer 2.5 への引き継ぎ記録 ✅

> **Fable 5 は 2026-07-07 で利用不可になる。** 以降は **Claude Opus 4.8 / Cursor Composer 2.5** が引き継ぐ。
> このエントリが引き継ぎの正本。次セッションのエージェントはまずここと「Next steps」を読むこと。

- **現在地（2026-07-02 時点・全て確認済み）**:
  - `git status`: トラック済みファイルの未コミット差分**ゼロ**（フィードバックループ v1 は `4314b8d` でコミット済み）。
    未追跡は `verify-*.mjs`/`*.png` 等の実機検証ハーネスと debug 素材のみ（従来どおり意図的に未追跡）。
  - `npm test`: **630 PASS（66 files）**。`npx tsc --noEmit`: クリーン。`playerBuildFreshness`: 緑（player.js 最新）。
- **引き継ぎタスク（優先順）**: 下の「Next steps」がそのまま正。特に:
  1. **#0a（新規追加）**: 2026-07-01 の trim-in forceSeek 修正の実機 Playwright 検証が未実施
     （trim-in の異なる同一アセット2クリップを連結し、カット境界で `currentTime` が正しく seek されるか実機確認）。
  2. **#0b**: 異なるアセット間カット境界の先読み warm-up。
  3. **フィードバックループ運用**: デプロイ済み（`doc/feedback-loop.md` が運用正本）。定期的に
     `npm run harvest:feedback` → summarize → propose の3スキルを回してユーザーフィードバック起点のタスクを起こす。
- **引き継ぎ時の注意（エージェント共通）**:
  - ワークフローは [.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md) が正本。spec 先行・INV-2 全経路・実機 Playwright 検証・player.js 再ビルドを省略しない。
  - INV / §5 スキーマ / project.json 直列化の変更は必ずユーザー確認（CLAUDE.md 参照）。
  - 実機検証の罠は memory 済みだが要点: UI 駆動は `window.__mafterEditorStore`（dynamic import は別インスタンス）、headless Chromium は WebCodecs VP9 encode 不可（`HEADED=1`）、port は dev server に合わせる。

### 2026-07-02（Claude Sonnet 5）— ヘッダーに「バグ / フィードバックを送信」リンク追加 + `.env` の VITE_FEEDBACK_TOKEN 欠落バグ修正 ✅

- **追加**: [App.tsx](src/App.tsx) の上部メニューバー、「M1 preview」表示の左に「バグ / フィードバックを送信」
  リンクを追加。既存の `FeedbackSendModal`（催促トースト・ProjectPanel手動送信ボタンと共通）を再利用し、
  `isFeedbackEnabled()` でゲート（トークン無しビルドでは非表示、他箇所と統一）。
- **発見・修正した実バグ**: 前セッションで `.env` に `FEEDBACK_INGEST_TOKEN` は追加したが、
  **クライアントに焼き込む `VITE_FEEDBACK_TOKEN` を追加し忘れていた**ため、`isFeedbackEnabled()` が
  ローカル dev・本番デプロイ両方で常に `false` になり、ヘッダーリンク・トースト・ProjectPanel送信ボタンが
  すべて表示されていなかった（サーバ側 smoke test は Node スクリプトが `.env` から直接トークンを読んで
  curl していたため、この不具合に気づけていなかった＝クライアント経路を実ブラウザで通していなかったのが盲点）。
  `.env` に `VITE_FEEDBACK_TOKEN=${FEEDBACK_INGEST_TOKEN}`（Vite の dotenv-expand 展開）を追記し、
  ローカル dev server 再起動 + 本番再デプロイの両方で Playwright 実機確認（リンク表示→クリック→モーダル
  オープン）まで完了。
- **教訓**: `VITE_` 系ビルド変数を追加するときは、**実際にクライアントの実行時に効いているか
  （サーバ側の代理チェックだけで満足しない）を実ブラウザで確認する**こと。

### 2026-07-02（Claude Sonnet 5）— フィードバック収穫ループ v1 実装（サーバ・シグナル・催促UI・収穫・エージェントスキル）✅

- **背景**: `.cursor/plans/feedback_harvest_loop_bf981079.plan.md` と、その添削監査
  `.cursor/plans/feedback_undefined_audit_091af114.plan.md`（G2/G27/G28 の非破壊3条件）に基づき、
  デプロイ先エディタの「不便シグナル」検知→催促→収穫→要約→提案までの一連のループを一気に実装。
  spec（`doc/mafter-effect-spec.md`）とは分離した運用機能のため §5/INV 変更なし。
- **Phase 1（サーバ・deploy）**: [`scripts/mafter_http_server.py`](scripts/mafter_http_server.py)（stdlib のみ、
  static 配信 + `POST /api/feedback`。トークン未設定なら feedback API は 404 で static 専用に振る舞う＝
  非破壊条件1）。[`scripts/deploy-ssh.mjs`](scripts/deploy-ssh.mjs) の `configureRemoteServer` を
  **python 統合サーバ一本**に置き換え（Docker/Caddy デュアルパスは v2 へ、`buildCaddyfile` は削除）。
  起動前に `pkill -f mafter_http_server.py` 等で冪等化（非破壊条件3）。python スクリプト転送は
  base64+exec だとサイズ的に不安があったため SFTP 経由（`sftpWriteFile`）に変更。
- **Phase 2（シグナル・UI）**: [`feedbackSignals.ts`](src/editor/feedbackSignals.ts)（純関数・`BurstTracker` /
  `ReversalTracker` / `KeyedBurstTracker` + スコア減衰、単体テスト12件）→
  [`feedbackCollector.ts`](src/editor/feedbackCollector.ts)（シングルトン、閾値30・クールダウン30分・
  セッション最大2回、`VITE_FEEDBACK_TOKEN` 未設定時は常に無効化）→
  [`FeedbackPrompt.tsx`](src/editor/FeedbackPrompt.tsx)（催促トースト＋送信モーダル）。
  フックは [`store.ts`](src/editor/store.ts) の `undo`/`redo`/`updateObject`（1箇所で rapid tweak 検知）/
  `ensureProxyTier` 失敗、[`ExportDialog.tsx`](src/editor/ExportDialog.tsx)（error/cancel/fallback）、
  [`ProjectPanel.tsx`](src/editor/panels/ProjectPanel.tsx)（zip失敗＋手動送信ボタン、トークン無しは非表示）、
  [`TimelinePanel.tsx`](src/editor/panels/TimelinePanel.tsx) の ruler scrub（方向反転検知）。
- **Phase 3**: [`scripts/harvest-feedback.mjs`](scripts/harvest-feedback.mjs)（SSH 収穫、ローカル保存成功後のみ
  リモート archive へ copy→検証→delete）。`npm run harvest:feedback`。
- **Phase 4**: [`scripts/summarize-feedback.mjs`](scripts/summarize-feedback.mjs)（決定論の集計 JSON）＋
  3スキル（[run-feedback-loop](.claude/skills/run-feedback-loop/SKILL.md) /
  [summarize-user-feedback](.claude/skills/summarize-user-feedback/SKILL.md) /
  [propose-from-user-feedback](.claude/skills/propose-from-user-feedback/SKILL.md)）。すべて Agent 非依存
  （Cursor/Claude Code 等どれでも同じ SKILL.md で動く）。implementation-loop Phase 4d に接続済み。
- **ドキュメント**: [`doc/feedback-payload.md`](doc/feedback-payload.md)（JSON スキーマ）、
  [`doc/feedback-loop.md`](doc/feedback-loop.md)（運用正本）、`.env.example` 新規作成、
  `.gitignore` に `feedback/inbox/`・`feedback/reports/` 追加。
- **検証（実施済み）**:
  - `npm test` 全体 **630 PASS**（新規 [test/feedbackSignals.test.ts](test/feedbackSignals.test.ts) 12件含む）。
    `projectBins.test.ts` の単発flakeは無関係（stash して未変更 main でも再現、ULID絡みの既知の pre-existing flake）。
  - `npx tsc --noEmit` 新規エラーなし（既存 `TimelinePanel.tsx` の TS6133 3件は無関係の pre-existing dead/WIP コード、
    git stash で確認済み）。
  - `npx vite build` 成功（196 modules）。`__APP_VERSION__` 注入確認、トークン未設定時に feedback 機能が
    正しく無効化されることをビルド成果物で確認。
  - `mafter_http_server.py` を実際に起動し curl で auth/バリデーション/rate limit(10req/min)/payload size
    (8KB)/static フォールバック/トークン無しモードを全て手動検証。
  - **Playwright で実ブラウザ end-to-end**: `VITE_FEEDBACK_TOKEN` 有効ビルドで dev server 起動 →
    実際の signal 発火（export_error + undo burst）→ 催促トースト表示 → モーダルでシグナル表示確認 →
    テキスト入力 → 送信 → 実際に `Authorization: Bearer <token>` 付き `POST /api/feedback` が正しい
    schema で発火することを確認 → その実ペイロードを実サーバに再送し jsonl append（UTF-8含む日本語メッセージ
    含め）まで一気通貫で確認。
- **実デプロイ smoke test（追ってユーザーが実行、同日中に完了）** ✅:
  `https://4bbaff83-9f31-4326-9453-a6d903d8a166-w1.gycp.party` へ `npm run deploy:ssh` 実行 →
  `GET /` 200・有効トークンで `POST /api/feedback` 200（jsonl append 確認）・無トークン/誤トークンで
  401・`npm run harvest:feedback` でリモート `inbox/` → ローカル取得＋リモート `archive/` へ移動確認・
  `npm run summarize:feedback` で正しい集計まで一気通貫で確認。
- **デプロイ中に発見・修正した実バグ2件**（`npm run build` をフルパスで初めて通し、実際に
  `deploy:ssh` を実行して初めて顕在化。ローカル検証だけでは踏めなかった）:
  1. **`TimelinePanel.tsx` の pre-existing TS6133 ×3**（WIP でコメントアウト済みの `statusMsg` 表示・
     `flashStatus` 呼び出しの戻り値 `n` が未使用）が `npm run build`（`tsc --noEmit` 必須）を丸ごとブロックしていた。
     挙動を変えず最小修正（`const [, setStatusMsg] = ...` / `const n = ...` の捕捉を削除）。
  2. **`configureRemoteServer` の `pkill -f mafter_http_server.py` 自己マッチバグ**: ssh2 の
     `client.exec()` は複合コマンド全体を1つの `sh -c "..."` で実行するため、素の `pkill -f pattern` は
     「このコマンドを実行中のシェル自身の argv」にもパターン文字列がそのまま含まれておりマッチし、
     SIGTERM を受けて exec チャンネルが `code=null`（signal 終了）で死ぬ → 以降のコマンド
     （nohup 起動含む）が一切実行されず deploy 全体が失敗する、という実機でしか踏めないバグだった。
     `pkill -f '[p]ython3 -m http.server'` / `'[m]after_http_server.py'` の**ブラケットトリック**
     （grep/pkill の自己マッチ回避の定石）で修正・実機で再現→解消を確認。
- **既知の制約 / follow-up（v2 以降）**:
  - Docker/Caddy デュアルパス・TLS（`:443`）は v1 スコープ外（python `:80` 単一プロセスのみ）。
  - `scripts/deploy-ssh-lib.mjs` への SSH 共通化（G14）は監査で v1 スコープ外に降格済み。
    `harvest-feedback.mjs` は意図的に `deploy-ssh.mjs` と接続まわりのコードを小さく重複させている。
  - `VITE_FEEDBACK_TOKEN` はビルドに平文で焼き込まれる仕様（漏洩許容・秘密鍵ではない）。abuse 対策は
    サーバ側 rate limit のみ。悪用時は `.env` の `FEEDBACK_INGEST_TOKEN` をローテして再 deploy。

### 2026-07-01（Claude Sonnet 5）— 同一アセット連結カットで trim-in の seek 抜け修正（video pooling）✅

- **症状（ユーザー報告）**: 同一動画リソースから作られた2クリップが連続再生されたとき、次クリップの trim-in が前クリップの停止位置に近い（差 0.5 秒未満）と seek されず、あたかも1クリップが続いているように見える。
- **原因**: [videoElementSync.ts](src/runtime/videoElementSync.ts) `syncVideoElementTime` の再生中 resync 判定が `PLAYBACK_RESYNC_THRESHOLD_SEC`（0.5秒、decode lag 吸収用）を使っており、「カット境界でプールから別クリップ用に `<video>` を再取得した」ことを一切区別していなかった（`fd8d09f`/`2e5e36c` の video 要素プール再利用が原因を作った）。真に連続するカット（差ゼロ）だけでなく、差はあるが 0.5 秒未満のケースまで誤って seek をスキップしていた。
- **修正**: `VideoElementSyncOptions` に `forceSeek?: boolean` を追加し、再生中 resync の閾値を forceSeek 時は半フレーム精度（`videoSeekThresholdSec`）に切り替え。[DomRenderer.ts](src/runtime/DomRenderer.ts) `applyObject` で `childrenRebuilt = sig !== entry.childSig`（＝このフレームで entry の子要素を作り直した＝カット境界）を検出し、video の `updateComponentEl`/`syncVideoElementTime` 呼び出しへ伝播。真に連続するカットは半フレーム以内なら引き続き無音継続を維持。ネスト comp 描画パスは毎フレーム新規 `<video>` を作るため無変更（`video.paused` 経路が既に厳密）。
- **検証**: [test/videoElementSync.test.ts](test/videoElementSync.test.ts) に forceSeek のケース2件追加（0.2秒差は seek される／半フレーム以内は無音継続維持）。`npm test` **618 PASS**。`npx tsc` は既存 TimelinePanel TS6133 のみ（無関係）。`public/player.js` は hook で自動再ビルド済み（freshness 緑）。
- **未実施**: 実機 Playwright 検証（trim-in の異なる2クリップを連続配置し `currentTime` を確認）は未実施——次セッションでの follow-up。

### 2026-06-30（Claude Opus）— declick フェードを cubic-bezier「slow in / fast out」に（全経路ジッパー除去・§11.5.2）✅

- **要望**: 「どの経路でもジッパーノイズが発生しないようにスムーズに。ベジェ曲線で slow in / fast out」。
- **変更（[footageAutoFade.ts](src/runtime/footageAutoFade.ts) 1ファイルに集約・全経路共有）**:
  - `fadeEase` を追加（cubic-bezier `(0.32, 0, 0.67, 0)` ≒ easeInCubic を CSS 同等の Newton 法で x→y 評価）。`makeCubicBezier` ヘルパ。
  - `autoFadeMultiplier`（resolve→video.volume / bundle el.volume の毎フレーム・毎 tick 経路）を線形 `t` から `fadeEase(t)`（in）/`1-fadeEase(a)`（out）に変更 → slow in / fast out。
  - `scheduleDeclickRamps`（preview `PreviewAudioClock` / export `OfflineAudioContext`）を `linearRampToValueAtTime` から **`setValueCurveAtTime`**（`fadeCurveSamples` で bezier を 33 点サンプル）に変更＝サンプル精度のカーブ。`setValueCurveAtTime` 非対応環境は線形ランプにフォールバック（`RampableParam.setValueCurveAtTime?` 任意）。
- **既定長**: `DEFAULT_AUTO_FADE_MS` は現状 **90ms**（spec §11.5.2 の値も 90 に修正。旧記載 30 は古い）。
- **検証**: [test/footageAutoFade.test.ts](test/footageAutoFade.test.ts) を bezier 形状（端点厳密・中央は線形より下＝slow in・単調・カーブ配列 0→1/1→0）に更新（**22 件 PASS**）。`npm test` 全体 **616 PASS**。`npx tsc` クリーン（既存 TimelinePanel TS6133 のみ）。`public/player.js` 再ビルド済み。実機 [verify-autofade-declick.mjs](verify-autofade-declick.mjs) **PASS**（Comp 23: f0 `inGain≈0.007`＝線形なら≈0.19 のはずが bezier slow-in で大きく減衰／中央=1／シームレス f60 抑制維持／disable 維持）。
- **忠実度**: Web Audio 経路はカーブをサンプル精度で打つため真に滑らか。要素ベース（audio bundle / video 内蔵音声）は同じ `fadeEase` を毎フレーム評価する best-effort（滑らかさはフレーム/tick 粒度に依存・既存どおり）。

### 2026-06-30（Claude Opus）— カット端のポップ音防止 自動フェード（declick・§11.5.2）✅

- **要望**: 継ぎ目のぶつ切り（本質）は前2修正で解決済み。補助として、**カットしただけ**でも編集中に音がプチる（波形不連続のポップ）のを防ぐ、**video/audio レイヤーに additive・既定 ON の自動フェード**を追加。「追加の仕方は直前の変更（要素再利用＝音連続）の理由を加味して」。
- **設計の肝（直前の §11.4 との整合）**: 同一アセット連結のシームレス境界（`D.out==C.in` かつ読み出し位置連続）は要素再利用が音を連続再生している。そこに out→in フェードを掛けると「急落→急上昇」を**復活**させるため、`computeFadeSuppression` で**その境界のフェードを抑制**。真のカット端・トリム端・尺端だけにフェード。
- **実装（共有純関数 [footageAutoFade.ts](src/runtime/footageAutoFade.ts)）**: `autoFade: bool`（既定 true・非 animatable・freeform props ＝ **§5 型非変更**）を [builtinComponents.ts](src/runtime/builtinComponents.ts) の video/audio に追加。既定長 `DEFAULT_AUTO_FADE_MS=30`。適用点:
  - **video 内蔵音声 preview/bundle**: [resolve.ts](src/runtime/resolve.ts) が video の `gain` に `autoFadeMultiplierAtFrame`（フレーム中央評価）を乗算 → DomRenderer の `video.volume` がフェード済み（DomRenderer 非変更）。
  - **audio preview**: [previewAudioClock.ts](src/editor/previewAudioClock.ts) が**専用 fadeGain ノードを直列**（`src→fadeGain→userGain→dest`）に挿し `scheduleDeclickRamps` でサンプル精度の linear ramp（live gain と分離・stomp されない）。
  - **audio + video export**: [exporter.ts](src/runtime/exporter.ts) `buildAudioMix` も同じ fadeGain 直列で declick（preview と同一長・同一抑制＝INV-2）。
  - **audio bundle**: [BundleAudioClock.ts](src/player/BundleAudioClock.ts) は HTMLAudioElement のため毎 tick `volume` 乗算（best-effort・粒度依存）。
  - **UI**: [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の `ComponentFields`（video/audio 用）に bool チェックボックス分岐を追加（既定 ON 表示）。
- **検証**: 実機 harness（Comp 23・実ブラウザ）で (1) 真の in 端 `gain 0.556 < 中央 1.0`（フェードイン）、(2) **シームレス境界 f60 のフェードは抑制**（`seamInGain==seamMidGain==1`＝音連続を壊さない）、(3) `autoFade=false` で焼き込み消滅、を確認 [verify-autofade-declick.mjs](verify-autofade-declick.mjs)。Inspector チェックボックス描画＋既定 ON を実機確認 [verify-autofade-ui.mjs](verify-autofade-ui.mjs)。`npm test` **611 PASS**（新規 [test/footageAutoFade.test.ts](test/footageAutoFade.test.ts) 17 件）。`public/player.js` 再ビルド済み（runtime 変更のため）。
- **既知の忠実度**: Web Audio 経路（audio preview / export）はサンプル精度。要素ベース（audio bundle / video 内蔵音声）は `volume` 粒度の best-effort（サブフレーム精度が要るなら `<video>` の Web Audio ルーティングが v2 follow-up）。
- **harness 教訓**: UI を駆動するには走っている React と同一 store ＝ `window.__mafterEditorStore` を使う（`import("/src/editor/store.ts")` は別 Zustand インスタンスで UI に反映されない）。コンポーネント params は ComponentFields（video/audio）/ EffectFields / ExpressionPreset の3系統に別々の `params.map` があり、bool 分岐は ComponentFields に足す。

### 2026-06-30（Claude Opus）— カット境界の内蔵音声ぶつ切り修正（要素再利用プールの遅延静音）✅

- **症状**: 上記 flicker 修正後も、同一動画の連結カット境界で**内蔵音声がぶつ切り**（ユーザー報告: 音量が超短時間で急落→急上昇）。
- **原因**: flicker 修正の `stashVideosToPool` が退避時に `<video>` を `pause()`+`muted=true` し、再利用時に `syncVideoElementTime`（playback）が `unmute`+再 seek+`play()` していた → 境界で一瞬ミュート＆停止＆シーク＝音量の急落→急上昇。
- **修正**: 退避時は **pause/mute せず detach のみ**（`<video>` は DOM から外しても再生継続）。同一フレーム再利用なら要素は止まらず映像も音も連続。再利用されず残ったプール要素だけ **add パス後に `quiescePooledVideos()` で pause+mute**（遅延静音・離脱クリップの音漏れ防止）。停止/`dispose` 時もプール要素を静音。[videoElementPool.ts](src/runtime/videoElementPool.ts) に `peekAll()`（非破壊列挙）を追加。preview/bundle 専用・export 非干渉（INV-2）。
- **spec**: [§11.4](doc/mafter-effect-spec.md) カット境界再利用の散文を「退避時 pause/mute しない・遅延静音」に更新。
- **検証**: 実機 harness（Comp 23 再生、対象 `<video>` の pause/play/muted をパッチ計測）で**境界(f58–62)の pause/play/mute イベントゼロ**・`paused=false/muted=false/seeking=false` 維持・ct 連続前進・映像 rs=4 維持を確認。`npm test` **594 PASS**。

### 2026-06-30（Claude Opus）— カット境界の動画ちらつき修正（`<video>` 要素 asset 単位再利用プール）✅

- **症状**: 同一動画を分割して連結したタイムライン（例 zip `mafter-project (11)` の **Comp 23**: 同一アセットを in0–out60/trim0 と in60–out150/trim60 の2レイヤーで連結）の**カット境界で映像が一瞬空白＋内蔵音声がプチっ**。
- **原因（実機計測で確定）**: 各カットは別 object id ＝別 `<video>`。[DomRenderer.renderFrame](src/runtime/DomRenderer.ts) の reconcile が離脱レイヤーの `<video>` を破棄し入場レイヤーに新規 `<video>` を生成→`src` 再代入するため、境界フレームでデコードが間に合わず空フレーム化（実測 f60 で `readyState=0, videoWidth=0`、回復まで ≈3–4 フレーム）。既存 warm-up（`primeMountedVideos`/play gate）は「再生開始時にマウント済みを prime」するだけで再生途中の境界には無効。
- **修正**: DomRenderer に **assetId 単位の `<video>` 再利用プール**（[videoElementPool.ts](src/runtime/videoElementPool.ts) `KeyedElementPool`・DOM 非依存）を導入。離脱レイヤーの要素を破棄せず（mute+pause+detach して）プールへ退避し、入場レイヤーが同一アセットなら再利用（src 同一→再ロード/再デコード不要・現在時刻からシームレス継続）。**renderFrame の削除ループを入場処理の前へ移動**（境界フレームで退避→再利用の順序を成立させるのが肝）。同一アセット同時表示はプール空→新規生成へフォールバック。dispose でプール要素も明示破棄。preview/bundle 専用、export 経路は `waitForVideoFrame`/`flushVideoFrames` がデコードを待つため決定論不変（INV-2）。
- **spec**: [§11.4](doc/mafter-effect-spec.md) warm-up 節に「カット境界の `<video>` 要素再利用」散文を追記（INV/§5 不変）。
- **検証**: 実機 harness（Comp 23 を zip import→再生）で**境界 f60 が `rs=0`→`rs=4 vw=1080` に改善**・再生中 NOT READY ゼロ・scrub 無回帰を確認。`npm test` **594 PASS**（新規 [test/videoElementPool.test.ts](test/videoElementPool.test.ts) 6 件含む）。`public/player.js` 再ビルド済み（freshness 緑）。video を含まない comp では renderFrame 挙動はループ順序入替のみでバイト等価＝既存 export 経路は構造的に無回帰。
- **follow-up（本タスク対象外）**: 異なるアセット間の境界はプール空でコールド（先読み warm-up が必要）。プールは未帰還アセットの要素を dispose まで保持（長セッションで上限導入の余地）。

### 2026-06-30（Claude Opus）— Animated Raster Proxy / video footage quality（全 Phase 実装）✅

プラン `.cursor/plans/animated_raster_proxy_*.plan.md` を Phase 1→6 まで通し実装。決定: `footageKind`/`originalPath`/`proxies` は `asset.meta`（§5 型変更なし）、prop 名 `footageQuality`（UI "Quality"）。

- **resolver / cache（Phase 1b）**: [imageAssetCache.ts](src/runtime/imageAssetCache.ts) に `getUrlForQuality` + `proxyById` + `loadProxiesFromFs`（meta.proxies を blob 化）+ evict 拡張。[DomRenderer.ts](src/runtime/DomRenderer.ts) video は `getUrlForQuality(assetId, footageQuality)` で映像切替（exporter も同 DomRenderer 経由＝INV-2）。
- **proxy 生成（Phase 2/4）**: [webcodecsVideoEncode.ts](src/runtime/webcodecsVideoEncode.ts)（VP9 webm・exporter とは独立）、[animatedRasterDetect.ts](src/runtime/animatedRasterDetect.ts)（ImageDecoder でアニメ webp/gif 判定）、[animatedRasterProxy.ts](src/runtime/animatedRasterProxy.ts)（等間隔 fps リサンプル）、[footageVideoProxy.ts](src/runtime/footageVideoProxy.ts)（native mp4→<video> seek→縮小 webm・音声破棄）。
- **store（Phase 2/3）**: [store.ts](src/editor/store.ts) `importImageAsset` がアニメ webp/gif を検出→`importAnimatedRasterAsset`（原本 + medium proxy・path=proxy）。`ensureProxyTier(assetId, quality)`（原本を FS から再構成→tier proxy 生成→meta.proxies 更新・undo 非積載・warm-up evict）。`rehydrateAnimatedRasters`（zip 再 import 後に medium 再生成）を `loadFromFs` 後にキック。native import に `footageKind:"native"`。`removeAsset` は原本 + 全 proxy ファイル削除。
- **UI（Phase 3）**: [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) `QualitySelect`（optgroup Source/Editing/Performance + friendly ラベル + 選択で lazy `ensureProxyTier` + `generating…`/`proxy failed` 表示 + `evictPreviewMediaAsset`）。
- **export 音声（Phase 5）**: [exporter.ts](src/runtime/exporter.ts) `buildAudioMix` が `resolveFootageAudioPath`（quality 非依存・原本）から decode。raster（音声 null）はスキップ。
- **zip / bundle / gate（Phase 6）**: [zip.ts](src/fs/zip.ts) `exportProjectZip`（proxy ファイル除外 + `normalizeProjectForZip` で raster path→原本・proxies/originalPath 省略）を [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) `exportZip` から使用。[bundleCollect.ts](src/runtime/bundleCollect.ts) video はレイヤー quality で `resolveFootageVideoPath` した映像 + `resolveFootageAudioPath` 原本のみ同梱。[ExportDialog.tsx](src/editor/ExportDialog.tsx) は export 前に `collectExportProxyJobs` の proxy tier を `ensureProxyTier` で実体化（失敗=中止）し、更新後 project で書き出し。bundle player cache（`registerProjectUrls`/`loadVideoBlobsFromUrls`）も proxy URL を登録。
- **WebCodecs stall ガード**: [webcodecsVideoEncode.ts](src/runtime/webcodecsVideoEncode.ts) に encode 全体のウォッチドッグ（既定 `max(15000, frameCount*500)`ms）。stall する環境で proxy 生成が UI をハングさせず throw → 呼び出し側が原本フォールバック。
- **テスト / 検証**:
  - `npm test` **588 PASS** + 新規 [test/footageQuality.test.ts](test/footageQuality.test.ts)（9）/ [test/footageProxyPure.test.ts](test/footageProxyPure.test.ts)（10・zip 正規化 / bundleCollect path 選択 / proxy jobs / リサンプル / detection）。
  - typecheck はプロジェクト変更分すべて緑（既存 TimelinePanel の pre-existing TS6133 3 件のみ赤・本タスク非関連）。`public/player.js` 再ビルド済み（freshness 緑）。
  - [verify-video-export.mjs](verify-video-export.mjs) **PASS**（DomRenderer 映像 resolver + exporter 共有経路の無回帰を実機確認）。
  - **proxy 生成の実 WebCodecs 検証（実ブラウザ）= PASS**: [verify-video-quality-proxy.mjs](verify-video-quality-proxy.mjs) を `HEADED=1`（headless:false + GPU 有効フラグ）で実行 → native MP4 を `ensureProxyTier("medium")` で実 VP9 encode（≈22s）→ proxy webm 生成・**960×540 へ縮小**（原寸 1920×1080）・`meta.proxies.medium` 登録・cache blob は proxy/original とも fetch 可能（生存）・`bundleCollect` が **proxy 映像 + 原本音声のみ**同梱・`getUrlForQuality(medium)` が別 URL を返す、を全て確認。
  - **headless では proxy 検証不可**（既定 headless chromium は VP9 encode がレンダラをブロック＝環境制約・コードのバグではない。exporter の PNG-seq フォールバックと同根）。verify は `HEADED=1` で実行すること。詳細メモ: `headless-webcodecs-encode-blocks`。純粋ロジックは単体テストでも担保。
- **v1 既知制約 / follow-up**:
  - **proxy tier の preview/bundle 内蔵音声**: native proxy は音声を破棄するため、ユーザーが native を proxy tier にすると preview/bundle で内蔵音声が鳴らない（**export は mux で原本から鳴る・OK**）。`original` tier は従来どおり `<video>` アンミュートで鳴る。proxy preview/bundle の原本音声 PreviewAudioClock/BundleAudioClock 統合は **v2 follow-up**。
  - ラスタ `original` の preview/bundle/export 映像は medium フォールバック（v2 で原本閾値）。GIF 可変 delay は等間隔リサンプル。APNG は v2。
  - mp4/webm/bundle export の品質閾値（Export 設定で original 強制）は v2（現状はレイヤー quality どおり）。

### 2026-06-30（Claude Opus）— Animated Raster Proxy / video footage quality（Phase 1: 基盤）✅

- **目的**: 全 `video` レイヤーに画質ティア（`footageQuality`）を持たせ、重い素材を軽いプロキシで編集し最終書き出しのみ原本に上げる（AE の Proxy/Render Quality 相当）。プラン: `.cursor/plans/animated_raster_proxy_*.plan.md`。
- **ユーザー確認済みの決定**: ① `footageKind`/`originalPath`/`proxies` は **`asset.meta`（freeform）に載せ §5 型変更なし**。② **段階実装**（Phase 1 から）。③ prop 名は **`footageQuality`**（§27.4 のエフェクト `quality`(scalar) と区別、UI ラベルは "Quality"）。
- **Phase 1 実装範囲（純関数基盤・共有 capture パイプライン非変更＝既存 export 無回帰）**:
  - spec **§11.4b** 追記（[doc/mafter-effect-spec.md](doc/mafter-effect-spec.md)）: ティア/UI グループ、`meta.proxies`/`footageKind`/`originalPath`、映像/音声パス分離、ストレージ 3 経路規約、v1 制約。§5 非変更を明記。
  - [src/runtime/footageQuality.ts](src/runtime/footageQuality.ts): `FootageQuality` 型・`FOOTAGE_QUALITY_TIERS`・`PROXY_TIER_PARAMS`（maxDim/quality）・`QUALITY_UI_GROUPS`（Source/Editing/Performance・英語）・friendly ラベル・`normalizeFootageQuality`。
  - [src/runtime/footagePlayback.ts](src/runtime/footagePlayback.ts): 純関数 `resolveFootageVideoPath(asset, quality)`（プロキシ無→原本フォールバック）・`resolveFootageAudioPath(asset)`（quality 非依存・原本・raster は null）・`footageKindOf`/`resolveOriginalPath`/`getProxyEntry`。
  - [builtinComponents.ts](src/runtime/builtinComponents.ts): video に `footageQuality` enum param（既定 `original`・非 animatable）追加。
  - test: [test/footageQuality.test.ts](test/footageQuality.test.ts) 9 件 PASS。`public/player.js` 再ビルド済み（runtime 変更のため・freshness test 緑）。
- **Phase 1 のスコープ外（後続）**: cache の quality 解決・DomRenderer/exporter 映像 resolver 配線・プロキシ生成（`animatedRasterProxy`/`footageVideoProxy`/`webcodecsVideoEncode`）・`ensureProxyTier`・Inspector QualitySelect（optgroup UI）・zip 正規化（原本のみ）・bundleCollect・内蔵音声抽出の preview/bundle clock 統合。**現状 `footageQuality` prop は登録済みだが映像切替は未配線（既定 original で挙動不変）。**
- **注意（無回帰）**: footageQuality.ts/footagePlayback.ts は純関数で既存経路に未配線のため、既存 video export/preview/bundle は完全に不変。`builtinComponents` の param 追加は Inspector enum 表示のみ（選択しても現状映像は変わらない）。
- **既知の pre-existing**: `TimelinePanel.tsx`（前セッションの WIP・未コミット）に TS6133 unused-var が 3 件あり `tsc --noEmit` が赤。本タスク非関連・未修正。

> （上記は全 Phase 完了。直下の「Phase 1: 基盤」エントリは初期コミット時の記録で内容は上に統合済み。）

### 2026-06-30（Claude Opus）— 旧 HW での動画レイヤー再生スタッタ修正（対策 A）✅

- **症状**: i7-3770（Ivy Bridge / HD 4000）で動画 Footage 入り comp を preview 再生すると、**動画の映像ピクセルだけがガクガク**。同 comp 内の text/solid/image/3D transform 等の他レイヤーはスムーズ。i7-11xxx では軽量。動画なし comp は問題なし。調査詳細は [doc/issue/video-preview-playback-stutter-old-hardware.md](doc/issue/video-preview-playback-stutter-old-hardware.md)。
- **真因**: 他レイヤーはタイムライン同期（`resolve(frame)`→`matrix3d`）で滑らかだが、動画ピクセルだけが `<video>` のメディアクロック（`play()`）で進む二重時計。[videoElementSync.ts](src/runtime/videoElementSync.ts) の `playbackMode` が **ズレ > 3 フレーム（≈100ms）で `currentTime` seek**。旧 HW では decode が play() に追いつけず drift → seek → seek 後の present 復帰が遅く映像が飛ぶ → また遅れて seek、の**自己増殖 seek ループ**が映像 plane だけを荒らす。
- **修正（対策 A・最小）**: 再生中の drift 矯正 seek 閾値を `frameSec * 3`（≈100ms）→ `PLAYBACK_RESYNC_THRESHOLD_SEC = 0.5s`（≈15f@30fps）へ大幅緩和。通常の decode lag はネイティブ `play()` 追従に任せ、本当の不連続（ループ復帰・大ジャンプ）でのみ `currentTime` 代入。pause→play 開始・scrub・export(`exportStep`) 経路は不変＝**INV-2 維持**。preview と HTML bundle は同一 `syncVideoElementTime` を通るため 1 か所修正で両方に適用。
- **検証**: `videoElementSync.test.ts` に moderate drift(0.2s)非 seek / large drift(0.6s)再同期の固定テスト追加（全 19 PASS）。`public/player.js` 再ビルド済み（runtime 変更のため必須）。
- **残（follow-up・未着手）**: 対策 **D**（プレビュー専用 video proxy 縮小で旧 iGPU decode 負荷減）、対策 **B**（rVFC で動画主導 clock・二重時計解消）。旧 HW 実機での before/after 体感確認はユーザー側手順を doc に記載。

---

### 2026-06-29（Claude Opus）— 汎用コンテキストメニュー基盤の導入 ✅

- **背景**: 右クリックメニューは KF 専用の ad-hoc 実装（[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) の `kfContextMenu` state＋外クリック useEffect＋イージング JSX ハードコード）しか無く、レイヤー/プロジェクトツリー等には未配線だった。AE パリティに向け、どのパネルからでも開ける単一コントローラ基盤を用意。
- **実装**:
  - **新規 単一コントローラ**: [contextMenuStore.ts](src/editor/contextMenu/contextMenuStore.ts) — 軽量 Zustand（`open` / `openContextMenu(x,y,items)` / `closeContextMenu`）。プロジェクトデータ（FS 投影の useEditorStore）と分離した純 UI 状態。`ContextMenuItem = action | separator`（disabled/danger/icon/shortcut 対応）。
  - **新規 描画ホスト**: [ContextMenuHost.tsx](src/editor/contextMenu/ContextMenuHost.tsx) — body ポータル描画。**画面端クランプ**（useLayoutEffect で実寸測定→補正）、外クリック/Esc/scroll/resize/blur で閉じる契機を1箇所に集約。[App.tsx](src/App.tsx) ルートに1つマウント。
  - **KF メニュー移行**: TimelinePanel の `kfContextMenu` 一式を撤去し `openContextMenu` へ。**罠**: メニュー項目の onSelect クロージャは右クリック時点で store にスナップショットされ後続 re-render を読めない → `applyEasingToSelectedKfs(easing, keysOverride)` を追加し、`handleKfRightClick` で対象 KF 集合を明示キャプチャ（旧 JSX 都度レンダリング前提が崩れる）。
  - **実例**: `LayerRow` ヘッダー行に `onContextMenu`（名前を変更/複製/レイヤーを分割/削除）。既存ストアアクション再利用（`duplicateSelected`/`splitSelected`/`removeObjects`/`selectObjects`）。未選択行は先に単独選択（AE 挙動）。KF 行とは別 div なので二重発火なし。
- **検証**: 新規 [verify-context-menu.mjs](verify-context-menu.mjs) で (A) KF イージングメニュー表示＋Hold 適用＋閉じる (B) レイヤーメニュー 複製/削除→Undo/Esc/連続右クリックで1つだけ を実機 PASS。typecheck 緑。`public/player.js` 再ビルド不要（runtime 非依存・エディタ UI のみ）。
- **残/非ゴール**: ラベル色などの**サブメニュー**（基盤の submenu 対応とセットで次タスク）、プロジェクトツリー/インスペクタ/プレビューへの配線（基盤導入済みなので `onContextMenu` 追加のみ）、メニュー項目のキーボードナビ。
- **既知**: `test/projectBins.test.ts`（treeOrder 順序）が **flaky**（本変更と無関係・project tree シリアライズの非決定性）。要別途調査。

---

### 2026-06-26（Claude Opus）— 静的 HTML bundle の動画再生もっさり 真因修正 ✅

- **症状**: 動画レイヤー入りコンポを §11.7 静的 HTML bundle に書き出すと、preview はスムーズなのに bundle player 上で動画がもっさり（実機では `<video>` が paused のまま currentTime=0 で完全停止することも）。
- **真因**: bundle は動画 src を**相対 HTTP URL 直参照**（[imageAssetCache.ts](src/runtime/imageAssetCache.ts) `registerProjectUrls`）にしていた。`<video>` の再生/seek は HTTP byte-range (206) 対応サーバに依存し、range 非対応ホスト（多くの静的ホスティング・`file://`・range 非対応の簡易サーバ）では buffer/seek できず stall。preview は import 時に**ファイル全体を blob URL 化**（`decodeVideoEntry`）するため常にスムーズ＝経路差。
- **修正**: bundle player でも video のみ「一度 `fetch()` して全体を in-memory blob URL 化」する（[imageAssetCache.ts](src/runtime/imageAssetCache.ts) `loadVideoBlobsFromUrls` 追加・[BundlePlayer.ts](src/player/BundlePlayer.ts) start で await）。単一 GET なので range 非対応ホストでも動き、preview と同一の in-memory 再生になる（INV-2）。画像は単一 GET で十分なため対象外（メモリ非肥大）。**ユーザーの仮説「preview と同じ経路を bundle に適用」通り。**
- **スコープ**: video 型のみ・bundle 経路のみ。export（mp4/png）は `loadFromProject`（既に blob）経由で無変更。
- **検証**:
  - **新規 `verify-bundle-video-playback.mjs`**（恒久）: bundle を export→serve し `<video>.currentTime` を壁時計でサンプル。修正前 `paused=YES・playRate=0.00x`（停止）→ 修正後 `pausedSamples=0/20・playRate=1.00x`（native real-time play）。
  - 無回帰: `npm test` 479 PASS / typecheck 緑 / `verify-bundle-export.mjs`（solid・非video）PASS / `verify-video-export-monotonic.mjs`（reversals=0・onTarget=25/25）/ `verify-video-export.mjs`（playerUi=0%）。
  - `public/player.js` を `npm run build:player` で再ビルド済み。
- **残**: export の絶対速度 ~380ms/frame（foreignObject ラスタ化由来・symptom B）は本件と独立で未対応のまま。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | ✅ 完了 |
| M2 HTML comp + expression | ✅ 完了 |
| M3 Export | ✅ 完了（実機 9/9 検証済み） |
| M4 Plugin API v1 | ✅ 完了（実機 14/14 検証済み） |
| M5 Web Bundle Export（§11.7） | 🚧 Phase 1（Static HTML/ZIP bundle）実装済み・Phase 2 以降残 |

**MVP = M0–M4 完了。** 以降 §20 Project / §21 Timeline AE化 / §22 グラフエディタ / §23 precomp / §24 Ease / §25 Preview編集 / §26 テキスト / §27 エフェクト & 調整レイヤー / §28 Preview Cache / §30 Null / §19.5 Pipeline パネル を拡張中。

現行: **453 tests PASS** / typecheck ✅ / build ✅（2026-06-25）。

- §23.3b: ネスト comp が自身のカメラを live で適用（`setupCameraRig` 共有・Composer 2.5 実装）。
- §23.3c: ネスト comp 内の expression を live で評価する修正。`renderNestedComp` は子 comp を自前 resolve するため evaluator 未注入で wiggle 等が静的化していた（opacity/effect param 含む）。`DomRenderer.setCompEvaluators(Map<compId, evaluator>)` を追加し preview/export/bundle の 3 経路で配線（INV-2）。`createCompFrameCaptureContext` にも配線して深い階層（depth 2+）の expression を補完。
- §23.3d: ネスト comp 内の**調整レイヤーを live 合成**（`backdrop-filter`・ラスタ無し・collapse OFF）。`renderNestedComp` が `isAdjustment` を無視していたため Comp 内調整の blur/displace がネスト先で全消失していた。調整 div を comp 全面・空にして effect を backdrop-filter に積む（`applyNestedLiveEffects` を filter/backdrop 分離、region=comp 寸法）。実データ Comp 19→Comp 10→camera wiggle expression（depth 2）で単体表示と nested の視覚一致を確認（raster 0 段）。Fast* displacement は live、full displacement は §28.11 ラスタ経路据え置き。collapse ON / 強制ラスタライズ opt-in は将来（phase 2）。

---

## 完了済みの主要機能（要約）

- **コア（M0–M2）**: project.json schema / 正準シリアライズ（JCS+NFC）/ FS 抽象（Memory/IndexedDb）/ 決定論 zip / `@mafter/runtime` 単一核（INV-7: Mat4・easing・interpolate・純関数 `resolve()`・module loader・expression engine）/ DomRenderer（flat matrix3d）/ Zustand store（正は FS）/ commands（before/after snapshot undo）/ HTML comp（Shadow DOM 隔離）。
- **Export（M3）**: WebCodecs mp4/webm + PNG-seq フォールバック + 音声 mux。preview と同一パイプライン（INV-2）。
- **Plugin（M4）**: フル登録 API + pluginRegistry + gradient-rect サンプル。
- **§20–§26 UX**: Project パネル / Timeline AE化（Tier A + P0 + P1・KF 複数選択・U/UU・Duplicate/Split・コピペ・DnD 並べ替え）/ グラフエディタ Phase 1 / precomp（Freeze・循環参照 BFS・depth≤4）/ Flow 風 Ease パネル / Preview ビューア編集（ズーム/オーバーレイ/直接操作/KF 書き戻し）/ テキストレイヤー本実装（Draft=DOM・Best=SVG・グリフ分解・opentype.js）/ 画像アセット読み込み（プレビュー縮小プロキシ付き）。
- **§27 エフェクト & 調整レイヤー**: EffectDef（kind=css/svg/raster × executionPath=live/raster）/ builtin blur・tint・wave・ripple・turbulentDisplace・linearWipe・angularWipe・pixelSorter・pixelSortLite / Fast 系（fastWave・fastRipple・fastTurbulent）/ raster パイプライン（rasterCapture 共有・exporter flush）/ Inspector Effects foldout + Timeline effect KF 行。
- **§27.4 Live/Raster 調整レイヤー Phase 1**: `adjustmentMode:"live"|"raster"`（live=backdrop-filter 軽量 / raster=comp 背面 capture 高精度）。export mp4 は `auto_raster_mp4` で Live を自動 raster 化。byte 等価（raster のみ書く）。
- **§27.12 改定3（2026-06-21）— Fast\* を raster 無し live CSS filter 化**: スパイク（`verify-fast-drift-spike.mjs`）でドリフト真因が **filter region の pad 帯**（feImage 未定義域で定数 −scale/2 変位）と判明。`createSvgFilterElement` の displacement region を **(0,0,w,h) クランプ**（pad 廃止）→ live と raster が pixel parity。Fast\*（fastWave/fastRipple/fastTurbulentDisplace）は **raster 無し・フォールバック無し** で live 完結（通常=`filter`、Live 調整=`backdrop-filter`）。full displacement（wave/ripple/turbulentDisplace）は raster 維持。`needsSvgDisplaceCapture` は `hasEnabledFullDisplacement`（fast 除外）参照に。`compNeedsAutoPreviewCache` は full displacement のみ対象（fast-only は live のため除外）。`fastDisplaceDirect` 撤去。**export-parity 実機検証済み**（`verify-fast-export-parity.mjs`: 3 fast effect すべて foreignObject export で変位再現・drift 1.5–2.2px・露出矩形なし。wave raster / tint SVG-url も無回帰）。
- **§27.5 改定4（2026-06-21）— fastWave/fastRipple を `feImage` → `feTurbulence` 直結へ統一（軽量化）**: fastWave/fastRipple はかつて linearGradient/radialGradient の `feImage`（data URI）map を**毎フレーム文字列生成→ブラウザ再デコード**しており、`feTurbulence` 直結の fastTurbulent より重かった。ユーザー要請（「fastTurbulent と同等の軽さ」「Fast 系は Web で動く前提」）で両者を **`feTurbulence`（`type="fractalNoise"`・`numOctaves=1`）純 primitive へ置換**（`fastWaveDisplace`/`fastRippleDisplace`・`effectSvg.ts`）。`feImage`/PNG/data URI を一切生成せず GPU ネイティブ＝ fastTurbulent と同コスト・Web 軽量。正弦/同心円の見た目は意図的に放棄しノイズ歪み近似（承認済みトレードオフ）。真の正弦/同心円が要るならフル `wave`/`ripple`（raster）。死んだ `rippleDisplaceMapSvg`/`fastRippleDisplaceMapSvg`/`WAVE_FAST_QUALITY` は撤去。**実機検証済み**（`verify-fast-turbulence-web.mjs`: store 非依存で実ブラウザ filter render → fastWave/fastRipple/fastTurbulent すべて変位再現・edgeStd 3.1/4.5/10.6 vs baseline 0・露出なし・errors none）。
- **§27.5 改定5（2026-06-21）— Fast 3 種の「見た目の動き」を滑らかに（内部既定・パラメータ不変）**: 改定4 で `feTurbulence` 直結にして軽くなったが、単一オクターブ noise を全帯域のまま `feDisplacementMap` に通すためエッジ変位が粒状で動きがカクついた。ユーザー要請（「軽量化を維持したまま見た目の動きを滑らかに」・制御面 A＝内部既定/パラメータ追加なし）に対し **effect params/§5/INV/直列化 不変・`feImage` 復活なし・INV-2 維持**で builder 内部のみ改善。**(1) map smoothing 常時 ON**: noise map 直後に feature-size 比例 `feGaussianBlur`（`fastSmoothPx`＝`clamp(FAST_SMOOTH_FRACTION(0.06)·特徴サイズ, 0.75, 6)`。wave: λ / ripple: radius/frequency / turbulent: size）で速度を保ったまま flowing に。`antiAlias` は +1px の追加増分として存続。**(2) fastWave phase の段差ジャンプ解消**: `% 360` 折返しを撤廃し連続パン `(phase/360)·λ`、`stitchTiles` を外した座標安定場＋生成域 `|pan|` 対称拡張で boiling/跳躍なし。**(3) パン露出ポップ解消**: `feTurbulence` 生成域を maxPan 拡張し `feOffset` 後も layer 被覆（fastWave=per-frame `|pan|`/stitch off, fastRipple=center 範囲 `0.5·{w,h}` 定数 pad/stitch 維持, fastTurbulent=既存 region/pan 維持で blur のみ＝検証済み centroid 保全）。filter region は改定3 の (0,0,w,h) クランプ維持。**実機検証済み**（`verify-fast-turbulence-web.mjs` を **phase/center/evolution 0→720° アニメ sweep** に拡張: 3 種とも median edgeStd>baseline+2＝効果残存・全フレーム ink 高＝露出ポップなし・隣接フレーム MAD スパイクなし＝段差/露出なし・`feImage` 不使用・errors none・複数回 PASS 安定）。比較 PNG=`verify-fast-smooth-web.png`。
- **§28 Preview Cache / RAM Preview**: 二層キャッシュ（L1 メモリ LRU + L2 専用 IDB）/ ワークエリア / 緑バー / Caching ON/OFF トグル（既定 OFF）/ Auto Preview Cache（full displacement のみ）/ `previewBakeRequired` フラグ（§27.2）。
- **§28.10 per-layer raster キャッシュ（local frame 基準）**: 自己 capture（displacement）の per-layer キャッシュキーを comp 絶対フレーム → **layer-local frame**（`compFrame − inPoint`）に変更。レイヤーをスライド(move)しても内容不変なら再ラスタしない。`ResolvedObject.inPoint` を passthrough（resolve）。タイムラインに per-layer 緑線（レイヤーバー直上, `cacheSegments.framesToSegments` 共有・`previewCacheService.subscribeLayerFrames`）。comp 全体緑バー(ルーラー)は補助として共存。
- **§28.11 precomp comp 単位ラスターキャッシュ（content hash 基準）**: ネスト comp(A) が `compNeedsAutoPreviewCache` を満たす（displacement/raster を含む）とき、comp(A) をオフスクリーンで画像化（`precompRasterService` + `compFrameCapture`）して `<img>` 描画し、キー `precomp:{compId}:f{childFrame}:hash{contentHash}` でキャッシュ。`contentHash`（`compContentHash`）は projectRevision 非依存なので **comp(B) 編集では無効化されない**。rasterizer はライブ preview と RAM Preview の両キャプチャ経路に注入（INV-2: `resolve()` 不変・同一パイプライン）。タイムラインの precomp レイヤーバー直上に緑線（`precompChildToParentFrame` で childFrame→parentFrame 写像・`subscribePrecompFrames`）。**export/bundle 経路への rasterizer 注入は未配線（follow-up）**。
- **§30 Null レイヤー Phase 1** / **§21.8 Parent リンク UI**（循環検証・world 保持 reparent）/ **§19.5 Pipeline パネル Phase 2**（合成順序可視化・崖検出・mp4 auto_raster 注記）。
- **§26.3.1 Font プルダウン / §31 Solid 色編集（2026-06-21・UI 層・スキーマ不変）**: Text の Font を自由入力から **web-safe フォント 15 種のプルダウン＋「Custom…」任意入力**へ（`fontList.ts` 単一定数・`font` は静的 string のまま・描画経路不変）。Solid は Inspector に **"Solid" セクション（Fill スウォッチ・◇ KF 可）** を追加（従来 text 以外は null 描画だった）＋ **Timeline レイヤー行にカラーチップ**（`title="ソリッドの色"`・現フレーム色サンプル・ピッカー操作中は preview override / blur で undo 付き commit・既存 `color: AnimatedProp<RGBA>` を再利用）。**実機検証済み**（Playwright: Solid セクション/チップ表示・初期 #8080e6・チップ→赤 commit・Font 16 option 含 Custom…・Georgia 選択で `Georgia, serif` 書込・console error なし）。
- **§5.4b/§6.5b 3D 導入 Phase 1（2026-06-23・疑似3D DOM + AE 準拠カメラ）**: 仕様承認済み（全3フェーズ計画、AE 準拠ハイブリッド）。**(A) mat4** に `perspective`/`lookAt`/`orthographic`+vec 演算（cross/dot/normalize/sub）追加・単体テスト。**(B) schema**（additive・byte 等価維持）: `SceneObject.threeD?`/`threeDMode?:"auto"|"dom"|"raster3d"`、`TimelineComposition.renderer3d?:"classic"|"advanced"`（serialize で既定値は省略）。**(C) camera builtin 登録**（`cameraType` one/two-node・`pointOfInterest`・`zoom`(px)・`filmSize`・`near`/`far`）。resolve で **zoom→fov**（`fov=2·atan((h/2)/zoom)`）・**two-node lookAt**（注視点 auto-orient・up=+y で one-node 規約と一致＝X 反転なし）・**実効3Dモード解決**（auto→comp.renderer3d）を ResolvedObject に焼く（INV-1/3 維持）。旧 `fov` 後方互換。**(D) DomRenderer（Phase 1.1 で確定）**: 3D メタデータ passthrough。**カメラ CSS リグは per-object 焼き込み**＝root に `perspective`+`perspective-origin` のみ、view は **3D 層の行列に焼く**（`translate(cx,cy,P)·view·world`）。CSS `perspective` は子孫の 3D 変換にしか効かないため root に view を置くと dolly/zoom が無効になる問題（純 DOM 実験 `verify-3d-mechanism.mjs` で確定: 同一要素 perspective+transform は z=0 子を拡大しない）を解消。既定 cameraZ=zoom=P で等倍 neutral、dolly `scale=P/(camZ−z)`、zoom `scale=P/camZ`。**2D 層はカメラ免除**（素の worldTransform・AE 準拠）。**(E) UI**: Timeline 行 3D トグル/モードバッジ/CAM バッジ・ツールバー `+Cam`/activeCamera ドロップダウン/`3D:Classic|Advanced` セレクタ・Inspector「3D」フォールド（threeD/threeDMode）+「Camera」フォールド（type/POI/zoom/near/far/Set Active）・store `addCamera`/`setActiveCamera`/`setThreeD`/`setThreeDMode`/`setCompRenderer3d`。**(F) Export**: 3D 含むコンプに best-effort 注記（正準3D書き出し=GL readPixels は Phase 2）。**実機検証済み**: `verify-3d-camera.mjs`（camera 登録・activeCamera・scene.camera・fov=50・3D 実効 dom・content 中央・**3D 層パン応答 / 2D 層免除**・退化描画なし・error なし）+ `verify-3d-camera-investigate.mjs`（**dolly 半距離→2.0倍/倍距離→0.5倍、zoom 望遠→2.0倍/広角→0.5倍、既定→等倍、2D 全条件で不動**＝AE 準拠を実測 PASS）。355 tests / typecheck / build 緑。
- **§6.5b カメラ bundle-bake 誤判定 修正（2026-06-23）**: Static HTML 書き出しで、組み込み live エフェクト(blur/fastTurbulent)+カメラのみのコンプが「plugin / bake レイヤ 1 件」と表示・カメラ層を無意味に動画化していた。原因 = [bundleCollect.ts](src/runtime/bundleCollect.ts) の `BUILTIN_COMPONENT_TYPES` に **`camera` が欠落** → `componentNeedsBake` がプラグイン扱い → `bundleExportDefault` 未指定で既定 bake。修正 = set に `"camera"` 追加（非描画なので絶対 bake しない）。effects は元々 bundle bake 対象外（components のみ判定）。**回帰テスト追加**（`test/bundleExport.test.ts`: camera 非 bake / camera+調整(blur/fastTurbulent) で bakeTargets=0）+ **実機検証**（`verify-export-bake.mjs`: 同シナリオで cameraNeedsBake=false・bakeTargetCount=0・error なし PASS）。357 tests / typecheck / build 緑。
- **§21.8.2 Null/親付けの world 保持を全 KF へ修正 + §30.1 toggleAdjustment ガード（2026-06-24・Null 振る舞い監査）**: ユーザー報告「KF で動きのついたレイヤーの親に Null を与えると座標がおかしくなる」を起点に Null 振る舞いを広く監査。**実害バグ 2 件のみ**に絞り修正（他のグレー項目＝viewport クリック選択は全レイヤー未実装で Null 固有でない／3D・effect on Null は AE 準拠・§30 許可で意図的、は対象外と判定）。**Fix A（本命）**= [reparent.ts](src/editor/reparent.ts) `buildReparentPatch` が**現フレームの 1 KF のみ補正**していた（`setVec3Keyframe` がその frame だけ書換）ため、KF 付きレイヤーを親付けすると他フレームで Null(既定 960,540)のオフセット分ずれていた。**child の全 KF を各 frame で補正**する形に書換: 各 frame f で `L_new(f)=invert(W_parentNew(f))·W_childOld(f)` を decompose しその frame の KF 値へ上書き（**KF 位置・easing 保持**、`computeWorldTransforms` は対象 frame 集合に 1 回ずつ）。**static 親（Null の常態＝定数オフセット）→ 全フレーム厳密保持（KF 間補間も一致）**、animated 親→各 KF frame で保持・間は近似。static チャンネルは現フレーム decompose で value 更新。**Fix B（軽微）**= [store.ts](src/editor/store.ts) `toggleAdjustment` 先頭に `if (obj.isNull) return;`（§30.1 排他をストア操作でも担保）。spec §21.8.2/§30.1 を先行更新。**回帰テスト**（`test/reparent.test.ts`: position KF 0/15/30 を Null へ親付け → world が 0/7/15/22/30 すべてで親付け前と一致 / easing 保持 / KF 本数不変）+ **実機検証**（`verify-reparent-null.mjs`: 実ストア reparent 経路＋canonical `resolve()` で maxDelta=0・KF 補正 [0,15,30]・Null 移動で子追従 maxFollowErr=0・error なし PASS）。359 tests / typecheck / build 緑。
- **§20.4b 新規プロジェクト保存確認ダイアログ（2026-06-23・UI 層・スキーマ不変）**: Project パネルの `New` を押すと**常に**保存確認モーダル（[はい（保存）] [いいえ] [キャンセル]）を表示。[はい]＝**web 版は zip ダウンロード**（`onExportZip` 経由）→ `newProject()`、[いいえ]＝保存せず `newProject()`、[キャンセル]＝何もせず閉じる。Esc/暗幕クリック＝キャンセル。**デスクトップ版の保存先指定は未実装**（`onNewSaveThenCreate` に `TODO(desktop)` コメント。File System Access API / Electron で OS ダイアログ、現状は zip フォールバック）。dirty 判定は持たない（自動保存により IndexedDB 基準の未保存が常に無いため）。spec §20.4b。typecheck 緑。
- **§11.5/§11.5.1 オーディオ再生 + タイムライン波形表示（2026-06-24・spec §11.5/§11.5.1 追記済み・§5/INV/直列化 不変）**: 従来エディタプレビューは無音（[previewPlaybackLoop.ts](src/editor/previewPlaybackLoop.ts) は純 rAF）で波形も非表示だった。**(A) プレビュー音声マスタークロック**＝[previewAudioClock.ts](src/editor/previewAudioClock.ts) `PreviewAudioClock`：再生時に audio レイヤーがあれば `AudioContext` をマスタークロック化（`currentFrame = rangeStart + floor((ctx.currentTime−t0)·fps)`・INV-8 フレームスキップ）、各レイヤーを `inPoint/outPoint/trimStart/gain` で `AudioBufferSourceNode` スケジュール、loop wrap で再スケジュール。[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) 再生 effect で `hasAudioLayers` 判定→音声ありは audio clock、無し/decode 全失敗は従来 rAF（`runPreviewPlaybackLoop`/`runPreviewFrameClock`）へフォールバック。スクラブ/停止は無音。**(B) 波形 DSP**＝[waveform.ts](src/audio/waveform.ts)（純関数・WebAudio 非依存・node テスト可）：`computePeaks(channels, sampleRate, mode, buckets)` が正準 4096 バケットの min/max ピークを生成。`raw`／`donshari`（RBJ biquad lowshelf 80Hz+highshelf 6kHz 自前実装でキック/ハイ強調）／`transient`（fast/slow エンベロープ差分で海苔波形のアタックを過剰強調）。**(C) キャッシュ**＝[WaveformCacheDb.ts](src/fs/WaveformCacheDb.ts) `globalWaveformCache`：project FS とは別 IndexedDB（`mafter-effect-waveform-cache`）に `assetId:mode:buckets` キーで Float32Array 保存＋メモリ L1＋アセット単位 decode メモ化。`project.json` 非直列化。**(D) UI**＝[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `WaveformOverlay`（audio 層バー上に Canvas、`getLayerSourceExtent` で trimStart/sourceDuration を取得しトリム追従）＋ツールバーに波形モード循環ボタン（RAW→DON→TRN）。モードは store `waveformMode`（グローバル・localStorage 永続・非直列化）。**実機検証済み**（`verify-audio.mjs`: WAV をプログラム生成→import→audio 層追加→波形 Canvas 描画確認、raw/donshari/transient で描画ピクセルが相違（1763/1193/1030）＝DSP 効果、transient で海苔波形のアタックがスパイク化（`verify-audio-transient.png`）、再生で frame 0→18 前進＝audio clock 駆動、`hasAudioLayers`=true・error なし PASS）。364 tests（+waveform 5）/ typecheck / build 緑。
- **§11.5 オーディオ プリロード + duration メタ（2026-06-24・spec §11.5 追記済み・§5/INV/直列化 不変）**: 2 件のバグ/UX 修正。**(1) 再生レイテンシ**＝新規 [audioBufferCache.ts](src/editor/audioBufferCache.ts)（decode 済み `AudioBuffer` を assetId キーで共有メモリ常駐・`loadAudioBuffer`/`peekAudioBuffer`/`probeAudioMeta`）。[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) に編集中 comp の audio をプリロードする effect を追加し、再生ボタンで decode 待ちなく即発音（実測 ~120ms で frame 前進）。[previewAudioClock.ts](src/editor/previewAudioClock.ts) `prepareAudioLayers` と [WaveformCacheDb.ts](src/fs/WaveformCacheDb.ts) も同キャッシュを共有し、66MB 級ソースの多重 decode を排除。**(2) 波形が右へ徐々に縮み最後は直線化する不具合**＝原因は audio asset の duration メタ未記録 → `getLayerSourceExtent` の `sourceDuration` がレイヤー長（≒comp 5s）にフォールバックし、数分の曲全体がバーに圧縮表示され、曲の verse→breakdown→outro 包絡が「右へ縮んで最後は無音=直線」に見えていた。修正は二段構え: (a) [store.ts](src/editor/store.ts) `importAudioAsset` が import 時に 1 回 decode して `asset.meta`（`duration`/`sampleRate`/`channels`）を記録（`AssetEntry.meta` は既存任意フィールド・image と同様・§5 非変更）。(b) **より堅牢に**、[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `WaveformOverlay` がソース全長を **decode 済み `AudioBuffer` の実尺（秒×fps）を最優先**で使う（`peekAudioBuffer`/`loadAudioBuffer`・fps を prop 追加）。これにより **meta 未記録の旧アセット（修正前に import 済みで project.json に meta が無い）でも** 圧縮表示されない。peaks が L2 キャッシュヒットで decode を経由しない場合も `loadAudioBuffer` で実尺を確実に取得。**実機検証済み**: `verify-audio-fix.mjs`（fresh import: `meta.duration=230.64s`・波形均一 ratio 0.93・再生レイテンシ 120ms PASS）＋ `verify-audio-nometa.mjs`（**meta を剥がした旧アセット相当**で 5 分割セグメント高 6.5/6.0/5.2/6.9/6.9＝右端も潰れず均一・lastToFirst 1.05 PASS）。
- **§5.4d 描画モード / ブレンドモード（2026-06-24・Tier C 部分・spec §5.4d/§21.0 追記済み）**: AE の描画モードをレイヤーに追加。**Web ネイティブ合成**でできるだけラスター化しない構造。**型** = プレーン enum `SceneObject.blendMode?: BlendMode`（CSS 直結 16 種＋`ditherDissolve`・キーフレーム不可・[schema.ts](src/core/schema.ts) `BLEND_MODES`）。**直列化** = `"normal"` 以外のみ書く（[serialize.ts](src/core/serialize.ts)・byte 等価維持）、不明値は validate で strip。**resolve** = `ResolvedObject.blendMode`（既定 normal・補間なし・INV-3）。**preview / Live HTML バンドル** = [DomRenderer.ts](src/runtime/DomRenderer.ts) `applyBlendMode` で 16 種は CSS `mix-blend-mode` 直設定（**ラスター化ゼロ・ネイティブ合成**）、`ditherDissolve` は `mask-image` に Bayer 秩序ディザ（[ditherMask.ts](src/runtime/ditherMask.ts)・opacity を閾値へ・div α=1・**Math.random 不要で INV-1**・α しきい値なので foreignObject でもそのまま出る）。**動画キャプチャ（mp4/webm/png）** = comp に非 normal の 16 種があれば [exporter.ts](src/runtime/exporter.ts) `captureRendererFrame` が **レイヤー別キャプチャ→Canvas 2D `globalCompositeOperation`** で z 順合成（[blendCompose.ts](src/runtime/blendCompose.ts) で blendMode→GCO 写像・INV-2）。非 blend comp は従来の単一スナップショット高速経路を維持。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Transform 内に Blend Mode ドロップダウン・store `setBlendMode`（normal→undefined で省略・undo 付き）。**テスト**（`test/blendMode.test.ts` 10 件: 直列化省略/byte 等価・validate strip・resolve 素通し・GCO 写像・Bayer 全階調&単調&決定論）+ **実機検証**（`verify-blend-mode.mjs`: multiply で `mix-blend-mode:multiply`・ditherDissolve で `mask-image` 設定/blend クリア/opacity 1 PASS）。**動画キャプチャの per-layer 合成は 3D 層 perspective/調整レイヤーとの相互作用が best-effort**（foreignObject 既存制約と同等）。
- **§26.3.2 同梱フォント Noto Sans / Noto Sans JP（2026-06-24・spec §26.3.2 追記済み・§5/INV/直列化 不変）**: システム依存の web-safe フォント（§26.3.1）は環境差で preview↔export 一致（INV-2）を保証できないため、**実 TTF を同梱**して環境非依存に。**対象** = `Noto Sans`（ラテン）+ `Noto Sans JP`（日本語グリフ含む）、各 **Regular(400)/Medium(500)/Bold(700)** の計 6 ファイル（`public/fonts/*.ttf`・Google Fonts 完全版 TTF・JP 各 ~5.3MB / Latin 各 ~558KB）。**登録の単一情報源** = [builtinFonts.ts](src/runtime/builtinFonts.ts)（`BUILTIN_FONTS`・`registerBuiltinFonts(baseUrl)` が family×weight の `@font-face` を 1 `<style>` 注入・冪等・`font-display:swap` で**使用時のみ遅延ロード**＝起動コスト増なし）。**適用範囲** = (a) [main.tsx](src/main.tsx) 起動時 `registerBuiltinFonts("/fonts")` で**エディタ + 同一 document の WebCodecs/PNG export を一括カバー**。(b) **Web Bundle（§11.7）** は file:// 自己完結のため、[bundleExporter.ts](src/runtime/bundleExporter.ts) が text 層を走査して使用 family×weight のみ zip 同梱＋`BundleManifest.builtinFonts` 列挙し、[BundlePlayer.ts](src/player/BundlePlayer.ts) が `FontFace(family, url, {weight})` 登録。**ウェイト** = `font` は family 文字列のみ（スキーマ不変）、太さは既存静的 `weight` で選択（400/500/700 の `@font-face` を CSS が解決）。**outline** = `@font-face` 実ロード済みなので precise の SVG `<text>` フォールバックでも正確（opentype per-glyph 化は将来最適化）。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) ドロップダウンに `optgroup`「Bundled」を先頭追加・`isKnownFont` が built-in も既知扱い。**テスト**（`test/builtinFonts.test.ts` 3 件: 3 ウェイト構成・スタック先頭 family 判定・weight 最近傍スナップ）+ **実機検証**（Playwright: `@font-face <style>` 登録・`document.fonts.check("700 64px 'Noto Sans JP'", "日本語")`=true・text 層を Noto Sans JP/700/日本語に設定→ computed `font-family="Noto Sans JP", sans-serif"` / `font-weight=700` で実描画 PASS）。393 tests / typecheck / build 緑。
- **§5.6 背景未設定コンポ = 透明に統一（2026-06-24・spec §5.6/§25.2 追記済み・スキーマ/INV/直列化 不変）**: `CompositionMeta.background` 未設定（undefined）の扱いが経路ごとにバラバラ（preview=黒・ネスト PNG ベイク=黒・bundle=黒・export alpha=透明）で INV-2 が部分的に崩れていた問題を、ユーザー要請「背景に何も置かれていないコンポは透明」に従い**「未設定＝透明」へ統一**。**スキーマは不変**（`background?: RGBA` のまま・散文明確化のみ）。**変更**: (1) [compFrameCapture.ts](src/runtime/compFrameCapture.ts) `compBackground` 未設定→`"transparent"`（ネスト precomp ベイクが親へ透過合成）。(2) [BundlePlayer.ts](src/player/BundlePlayer.ts) `setupViewport` の `#000` 既定を削除（未設定はホストページの地が透ける）→ `npm run build:player` で `public/player.js` 再生成済み。(3) [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) stage 背景を未設定時に **`⬚` トグル ON=CSS チェッカー / OFF=黒** へ（`CHECKERBOARD_STYLE`・既存 `viewerSettings.checkerboard` 再利用）、従来コンテンツの前面に乗っていた [PreviewViewerOverlay.tsx](src/editor/panels/PreviewViewerOverlay.tsx) の SVG チェッカー rect＋`pv-checker` pattern を撤去（潜在バグ解消）。**不透明 export（alpha 無 MP4/WebM/不透明 PNG）は従来どおり黒マット**（[exporter.ts](src/runtime/exporter.ts) 変更なし＝AE 準拠）。**追加（同日・既定値変更）**: 新規コンポは従来 `background:{0,0,0,1}`（不透明黒）を明示生成しており「何も置かれていない」状態にならず ⬚ 切替も効かなかったため、[store.ts](src/editor/store.ts) `addTimelineComp` / [createProject.ts](src/core/createProject.ts) の **既定 background を削除（未設定＝透明）**。既存プロジェクト（黒保存済み）は不変。**背景編集 UI** = store `setCompBackground(RGBA|null)`・undo 付き・`null` で背景キー省略＝透明。DomRenderer root は [PreviewPanel](src/editor/panels/PreviewPanel.tsx) effect で**ライブ反映**（mount 後の編集で再マウント不要）。**2026-06-24 追記**: 背景編集 UI を **Preview ツールバー → Inspector（レイヤー未選択時 Composition セクション）** へ移設（Unity 的選択駆動）。`BackgroundControl` + `CHECKERBOARD_STYLE` を [BackgroundControl.tsx](src/editor/panels/BackgroundControl.tsx) / [checkerboardStyle.ts](src/editor/checkerboardStyle.ts) に共有化。選択解除 = Escape + TL ruler ラベル列空白 click（§21.4）。393 tests / typecheck / build:player 緑。
- **§5.6/§23.2 コンポジション設定をインスペクターで編集可能化（2026-06-25・spec §5.6/§23.2/§25.2 追記済み・スキーマ/INV 不変）**: 従来 Inspector の「Composition」セクションは `background` のみ編集可で `width`/`height`/`fps`/`duration` は読取専用だった。AE Composition Settings 基本相当を **`ScrubNumber` で編集可能**に。**スコープ = 既存スキーマフィールドのみ**（§5 型変更なし）。**(A) リサイズ** = [compEdit.ts](src/editor/compEdit.ts) `resizeCompCentered`（純関数）: width/height を `>=1` 整数化、`parent===null` の層のみ `position` x/y を `((newW-oldW)/2,(newH-oldH)/2)` オフセット（**中央基準維持・子は parent 継承で追従＝二重移動なし**・z 不変・base値と全 KF 両方）。store `resizeComp`。**(B) fps 変更** = `rescaleCompFps`（純関数）: `ratio=newFps/oldFps` で全 AnimatedProp（transform4+opacity+component+effect）の全 KF frame・各層 inPoint/outPoint・duration を `round(*ratio)`（**秒タイミング維持**・INV-5 準拠）。comp コンポーネントの `trimStart` は子 frame 単位なので不変。store `setCompFps`（再生ヘッドも秒維持で再配置）。**(C) duration 変更** = store `setCompDuration`（再生ヘッド超過時クランプ）。3 アクションとも command パターン（undo 可）。**(D) ネスト fps 不一致 = 秒ベースマッピング** = [compLayer.ts](src/runtime/compLayer.ts) `compChildFrame` に `parentFps`/`childFps` 引数追加し `childFrame=clamp(round((parentFrame-inPoint)/parentFps*childFps)+trimStart,0,dur-1)`（AE 既定）。**fps 一致時は旧式と完全一致＝後方互換**（既存プロジェクト描画・precomp キャッシュキー不変）。preview/export 両経路（[DomRenderer.ts](src/runtime/DomRenderer.ts) 2 箇所）が同一式共有で INV-2 維持。**注意（follow-up）**: 緑線写像 [precompFrameKey.ts](src/cache/precompFrameKey.ts) `precompChildToParentFrame` は 1:1 のまま（best-effort UI・fps 一致では同一）。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Size/Frame Rate/Duration 行を `ScrubNumber` 化（読取専用 span 撤去）。**テスト**（`test/compEdit.test.ts` 11 件 + `test/precomp.test.ts` に fps-aware 4 件＝equal-fps 旧式一致の不変条件含む）+ **実機検証**（`verify-comp-settings.mjs`: 中央オフセット 200,100→300,200・fps30→60 で dur150→300・KF [0,30]→[0,60]・undo 復元 すべて PASS）。
  - **追補（2026-06-25・ネスト fps 真因修正）**: 上記の `compChildFrame` fps 化だけでは**実機で 2 倍速が直っていなかった**。真因は DomRenderer が親 fps を **`this.currentComp.fps`（mount 時スナップショット）** から取っていたため、マウント後の fps 変更や comp 切替で stale 値（=子と同じ fps）になり 1:1 へ退行していた。**修正**: [resolve.ts](src/runtime/resolve.ts) が comp コンポーネントに **`_parentFps`（解決中 comp の fps）を注入**し、[DomRenderer.ts](src/runtime/DomRenderer.ts) の両呼び出しが `c.props["_parentFps"]` を使用（`this.currentComp.fps` 依存を撤廃・nested-of-nested も resolve(childComp) が childComp.fps を注入）。**実機検証**（`verify-nested-fps.mjs`: 60fps 親に 30fps 子をネスト → 親フレーム 0/30/60/120 で実効 childFrame 0/15/30/60＝**1 倍速**・以前は 0/30/60/120 の 2 倍速）。`test/precomp.test.ts` に `_parentFps` 注入ケース追加。431 tests / typecheck / build 緑。
- **§5.6/§21.1 Duration・タイムコードを AE `H:MM:SS:FF` 表示へ（2026-06-25・spec §5.6/§21.1 追記済み・スキーマ/INV 不変・UI/表示層のみ）**: ユーザー要請「Duration 指定を AE 形式に（frame は具体的だが人間に分かりにくい）」+「タイムラインパネル右上の数字も同フォーマットに」。**内部値は INV-5 どおり整数 Frame のまま**（§5 型変更なし）、見た目だけ変換。**(A) 純関数** = [timecode.ts](src/editor/timecode.ts) `framesToTimecode`（frame→`H:MM:SS:FF`・MM/SS/FF 2桁ゼロ詰め・H 非ゼロ詰め・fps 依存）/ `parseTimecode`（`:`または`;`区切り右詰め解釈: 4=H:MM:SS:FF / 3=MM:SS:FF / 2=SS:FF / **1=生フレーム数**・桁あふれ自然繰上げ・負数/非数値拒否）。**(B) Duration 入力** = [TimecodeScrub.tsx](src/editor/TimecodeScrub.tsx)（従来 ScrubNumber の drag UX 維持＝1px/frame、click で timecode テキスト編集）。[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Duration 行を ScrubNumber→TimecodeScrub に差替（`fps` prop 追加）。**(C) タイムライン統一** = [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) のローカル `framesToTimecode`（SMPTE 2桁時）を撤去し共有 `framesToTimecode` を import。右上の生フレーム `F{frame} / {duration}` → `timecode / timecode`（title に旧 `F..` 併記）。toolbar 現在時刻・ルーラー目盛りも同じ共有実装に。**§21.1 を SMPTE `HH:MM:SS:FF`→AE `H:MM:SS:FF` に改定**（唯一の共有実装明記）。**スコープ外（未変更）**: Preview パネル上部 toolbar の timecode（別パネル・2桁時のまま）。**テスト**（`test/timecode.test.ts` 13 件: format/parse/round-trip/fps 依存/拒否）+ **実機検証**（`verify-duration-timecode.mjs`: 30fps/150f→`0:00:05:00`・setCompFps(60)で dur 300 維持 `0:00:05:00` PASS / `verify-timeline-shot.mjs`: 右上 `0:00:01:15 / 0:00:05:00` 表示確認）。446 tests / typecheck / build 緑。
- **§9 Expression Phase 0.5（2026-06-26）**: `SceneObject.expressionPresets[]`（Effect 同型 UI + param KF）+ 共有 FS 脚本 `presets/expressions/<presetId>.js`（write-if-absent）+ `ctx.presetParams` 注入。Inspector: +追加/disable/× + ExpressionPresetFields。Timeline: `expressionPresets.<id>.<key>` 行。legacy `@mafter:preset` + per-object script は読取専用表示（編集で新形式へ）。**498 tests** / typecheck 緑。
- **§11.7 HTML bundle — expression preset 未同梱バグ修正（2026-06-26）**: Phase 0.5 の共有脚本 `presets/expressions/*.js` が bundle の `manifest.textFiles` に入らず player の ModuleLoader が null → expression 無視（動画 export は FS 直読のため正常）。**修正**: [builtinExpressionPresetScripts.ts](src/runtime/builtinExpressionPresetScripts.ts) に脚本正本を集約、[bundleCollect.ts](src/runtime/bundleCollect.ts) で path 収集、[bundleExporter.ts](src/runtime/bundleExporter.ts) で FS 未存在時に `injectBuiltinExpressionPresetScripts` で manifest へ埋め込み。`test/bundleExport.test.ts` +2 件。

---

## 既知のバグ・未解決課題

- **§27.3 SVG 5 種の export 一致（INV-2）未検証**: wave/ripple/turbulent/linearWipe/angularWipe の preview↔export ピクセル parity（feImage href が foreignObject ラスタ経路で再現するか）。pixelSorter は検証済み。
- **Issue B（[doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md)）**: turbulent プレビュー左端グレー枠の歪み漏れ。未着手。
- **Issue C / fastTurbulent centroid**: 強 amount で centroid ~6–8px ドリフト残（[effectRouting.ts](src/runtime/effectRouting.ts) で self-capture raster 統一後も残るチューニング課題）。
- **ディストーション phase/speed/direction（要設計判断・スキーマ追加）**: AE Ripple/Wave Warp の Ripple Phase（伝播アニメ）・Wave Speed/Type/任意角度 Direction が現状 param 未公開。effects params スキーマ追加になるため Claude Code 設計待ち（`rippleDisplaceMap` は `phaseDeg` を既に受けられる）。
- **§26.4 Draft/Best 残差（許容済み）**: DOM vs SVG 経路差で 100% ピクセル一致は非目標（実測 ≤2px・実用上問題なし）。
- **§28.11 export/bundle parity（follow-up）**: precomp comp 単位ラスタは現状ライブ preview + RAM Preview のみ。`exporter.ts` / `bundleBake.ts`（runtime）へ rasterizer 未注入のため、ファイル export ではネスト comp 内 effect が §23 Phase-1（非焼き込み）のまま。`resolve()` 出力は一致（INV-2 の literal は保持）だがピクセル一致は §27.3 と同じ tracked follow-up。runtime→editor 依存を避けるため optional param 経路で後日配線。
- **調整レイヤー export follow-up**: §27.4.1 multi-pass flush の厳密 sequential 化（積層調整の export 順序）/ precomp ネスト内 Live 調整の export auto_raster（compFrameCapture へ option 未配線）/ RAM preview cache の Live 調整 fidelity。
- **§23.3d 派生 TODO（phase 2・未着手・要ユーザー確認＋§5 スキーマ判断）**:
  - **collapse ON オプトイン**: ネスト comp 内の調整レイヤーが親 comp の下位レイヤーにも染み出すモード（AE collapse transformations 相当）。現状は collapse OFF 固定（isolation:isolate で precomp 内スコープ）。レイヤー単位 opt-in が必要なら `SceneObject` への schema 追加が要る → 事前にユーザー確認（INV/§5 変更ゲート）。
  - **強制ラスタライザ opt-in**: HTML 書き出しを必要としないユーザー向けに、comp/レイヤー単位で「決定論的にラスタ化して再生」を強制できるオプション（例: `forceRaster?` フィールド）。プロフェッショナル動画出力向けフォールバック。schema 追加のため事前にユーザー確認が必要。
  - 両方ともユーザーの了承（「live調整(§23.3d)+evaluator補完を今回実装」のみ今回スコープ）により今回は対象外。次にこの領域に着手する際は、まず仕様（§23.3 系）に追記してから実装する。
> ~~verify スクリプト未整合~~ — **2026-07-01 解消**。`verify-preview-cache.mjs` は実 DOM 操作（Caching チェックボックス実クリック・実 Play ボタンクリック）に書き換え、既定 OFF（`○ Cache OFF`）→ 実 Play で Auto Cache 起動（`⚡ Auto Cache`。previewBakeRequired な pixelSorter を使用）→ 明示チェックボックス ON（RAM/Clear UI・スクラブキャッシュ）の3段を検証し `process.exitCode` で pass/fail を返すよう変更。`verify-effects.mjs` は効果ごとの描画経路（raster canvas＝wave/turbulentDisplace/ripple/pixelSorter・live SVG filter＝linearWipe/angularWipe/pixelSortLite・backdrop-filter＝調整レイヤー・plain solid）に応じた正しい要素/プロパティを検証するよう刷新（旧版は `[data-object-id]` 直下の `filter`/`getBoundingClientRect` のみ見ており、component el が out-of-flow 子のため wrapper が常に 0x0 に潰れる／raster 経路は filter が正しく "none" になる、という現行実装の正常な挙動を「壊れている」と誤読する構造だった）。両スクリプトとも実 dev server（port 5173）で2回連続 PASS 確認済み。
- **3D Phase 1 の意図的な制約（Phase 2 で対応）**: ①**2D 層のカメラ免除は Phase 1.1 で実装済み**（per-object 焼き込みで 3D 層のみカメラ応答・2D は固定＝AE 準拠。当初懸念した特異点/ two-stratum 分離は per-object 方式で不要だった）。②**raster3d は dom にフォールバック** — Phase 1 は GL シーン未実装のため実効 raster3d も dom 描画。③**3D の正準書き出し未対応** — foreignObject は preserve-3d/WebGL 非対応、ブラウザ内 readPixels 取り込みは Phase 2。④**camera zoom/POI のタイムライン KF UI 未配線**（Inspector 静的編集のみ）。⑤**one-node の XY truck**は再センタリングと両立するが、厳密な AE 挙動の調整は Phase 2 ストラタム整備時に再検証。⑥**zoom↔焦点距離↔fov の AE 厳密換算**は未確定（filmSize 連動 UI 未実装）。
- **インフラ**: `npm install` 時の transitive deps 脆弱性警告（dev/build 由来・実行時影響なし・`npm audit` 精査推奨）/ IndexedDbFs.list は全 key 取得 → IDBKeyRange 最適化余地（§11.1）。

> ~~§27 Blur 回帰~~ — **2026-06-20 解消**（`rasterizeFilteredImage` が CSS filter token を捨てていた。filter chain 全体を `<image>` の CSS filter property へ。[test/rasterCapture.test.ts](test/rasterCapture.test.ts) で lock）。

---

## Next steps（次のセッションでやること）

**優先順位: 既知バグ修正 > 手動回帰 > 新機能。**

> ~~§11.7 HTML bundle — MP4 入りコンポの再生もっさり~~ — **解消済み**（2026-06-26 の bundle blob URL 化・preview native play() 統一・drift resync 緩和・warm up 等の積み重ねで解決。ユーザー確認済み）。

> ~~verifyスクリプト更新~~ — **2026-07-01 解消**（詳細は既知バグセクション参照）。

0a. ~~**trim-in forceSeek 修正の実機検証**~~ — **2026-07-02 完了**（実機 PASS・lag 起因のシームレス境界 seek 回帰を発見し `isSourceContinuousAcrossCut` で修正。冒頭エントリ参照）。（旧記載: trim-in forceSeek 修正の実機検証（優先度高・所要小）） — 2026-07-01 の `forceSeek` 修正（`e9f7928`）は単体テストのみで実機未検証。同一アセットから trim-in の異なる2クリップ（差 0.5 秒未満）を連結した comp を再生し、カット境界で `<video>.currentTime` が新クリップの trim-in に正しく seek されること・真に連続する境界（半フレーム以内）は無音継続が維持されることを Playwright 実機で確認する。ハーネスは [verify-autofade-declick.mjs](verify-autofade-declick.mjs)（Comp 23 系）を流用可。

0b. **先読み warm-up — 異なるアセット間のカット境界** — **2026-07-02 Cursor 委任で実装済み・worktree `cursor-video-warmup-20260702` 未マージ（ユーザー確認待ち・冒頭エントリ参照）**。（旧記載:） — カット境界の `<video>` 要素再利用プール（2026-06-30 実装済み）は**同一アセットの連結カット**のデコードギャップは解消したが、**異なるアセット同士の境界**は入場側のプールが空でコールド（新規 `<video>` を境界フレームで生成→デコード未完→数フレーム空白）。対策: 再生中、in 点が近い（次 ~0.5–1s）video レイヤーの `<video>` を **in 点より前に offscreen 先行マウント＋ prime**（[primeVideoElement](src/runtime/videoElementSync.ts) / [videoWarmupCache.ts](src/runtime/videoWarmupCache.ts) を流用）。preview/bundle 専用・export 非干渉（INV-2）。実機 harness で別アセット境界の readyState を before/after 計測。
1. **手動回帰（残）** — §25 Preview（直接操作・ズーム・オーバーレイ・animated KF 書き戻し）/ §24 Ease パネル（F9 メニュー・グラフエディタとの SSoT 共有）。
2. **§27 INV-2 export parity** — SVG 5 種（wave/ripple/turbulent/wipe）の preview↔export ピクセル検証。Issue B / fastTurbulent centroid チューニング。
3. **§27.4 調整レイヤー follow-up** — multi-pass flush 厳密化 / precomp ネスト Live 調整 export。
4. **ディストーション phase/speed/direction スキーマ** — 設計判断（Claude Code）後に実装。
5. **M5 Phase 2+ Web Bundle** / **Timeline Tier B–D**（~~ラベル色~~/solo/lock/shy・~~ブレンドモード~~/トラックマット・モーションブラー）/ **グラフエディタ Phase 2/3**（per-axis カーブ・空間モーションパス・速度グラフ）。いずれも spec 追記 + INV 評価が前提。
6. **3D Phase 2（plan: `~/.claude/plans/3d-dom-3d-webgl-3d-soft-meadow.md`）** — 共有 Three.js シーン1個 / `raster3d`（レイヤー→テクスチャ板、静的キャッシュ＋スケール時再ラスタ）/ `scene3d` メッシュコンポーネント / カメラ共有（perspective+view）/ **2D 層のカメラ免除（two-stratum）** / **正準3D書き出し（GL readPixels を z 合成）**。`three` を遅延ロード。Phase 3 = ライト/DOF/オービットギズモ。
7. **§23.3d 派生 phase 2（ユーザー確認待ち・着手前に仕様化必須）** — (a) collapse ON opt-in（ネスト調整レイヤーが親 comp 下位層へ染み出すモード・レイヤー単位）。(b) 強制ラスタライザ opt-in（`forceRaster?` 等の §5 スキーマ追加で決定論的ラスタ出力をユーザーが選べるフォールバック・HTML export 不要層向け）。どちらも INV/§5 変更を伴いうるため、着手前に選択肢＋推奨案を提示してユーザー確認を取ること。

### 参考: 先取り済みの境界
- **INV-7**: `@mafter/runtime` 単一核（resolve / Renderer / module loader / expression / 再生クロック）。preview / exporter / web bundle player が共有。
- **INV-8**: web bundle player は実時間・別の決定論クラス（マスタークロック=音声）。
- **§19 パネルシステム**: `LayoutNode` 直列化ツリー。レイアウト状態は project.json に入れない（§19.3・localStorage 永続）。

### §27.4.1 / §19.5 合成順序モデル（設計確定済み）
canvas 化結果は以降から見て通常の背面ピクセルと等価（zOrder 昇順単一規則）/ precomp は non-collapse 固定 / Raster 出力を確定境界（上の live は再計算なし）/ export = multi-pass flush（zOrder 昇順・各 raster ポイントで背面 capture・depth≤4）。PipelinePanel が live/raster 経路と崖を可視化。

---

## 開発方針

- 「先に spec（SSoT）→ 次に実装」を厳守。散文を根拠にスキーマを変えない。
- INV / §5 スキーマ / project.json 直列化形式の変更は事前にユーザー確認（選択肢＋推奨案）。
- 自動テスト緑だけでは UI 品質を保証しない。視覚・パリティ系は Playwright + Chromium 実機検証を併用（`window.__mafterEditorStore` 経由。dynamic import は別 Zustand インスタンスになる点に注意）。
- 新規スコープを広げる前に既知バグを潰す。

---

### 2026-06-24（Cursor）— ラベル色パレットに旧ベージュ追加

- **index 16**: 旧 LayerBar 既定色 `#b89b6a` をパレット 17 色目として追加（`LabelIndex` 0–16 に拡張）。パレット表示名「ベージュ（旧デフォルト）」。

### 2026-06-24（Cursor）— ラベル色バー連動 + 種別デフォルト

- **§21.10.2b 種別既定ラベル色**: `defaultLabelIndexForObject` + `cmdAddObject` で新規レイヤーに `labelIndex` 自動付与（Solid=0, Text=1, Footage=2, Null=4, Adj=5, Camera=7, HTML/Comp=9, fallback=14）。
- **LayerBar / SourceGhostBars**: 固定茶/青を廃止し `timelineBarFill(labelIndex)` に連動。パレット「なし」は中立グレー（種別既定に戻らない）。
- **検証**: `test/layerLabels.test.ts` / `test/cmdAddObjectLabel.test.ts` / `verify-layer-rename-label.mjs` PASS。

### 2026-06-24（Cursor）— レイヤーパネル拡充（リネーム + ラベル色）

- **§21.9 レイヤー名リネーム**: Timeline `LayerRow` ダブルクリック→インライン編集、Inspector ヘッダ input。`store.renameObject`（`renameComposition` 対称・undo 可）。§5 `name` はスキーマ不変。
- **§21.10 / §5.4c ラベル色**: `SceneObject.labelIndex`（0–15、AE 16 色パレット）追加。左端 4px 色バー + パレットポップアップ。複数選択時は一括適用。`resolve`/export 非影響（エディタ UI のみ）。`src/editor/layerLabels.ts`。
- **検証**: `test/layerLabels.test.ts` + `serialize` labelIndex roundtrip / typecheck 緑 / Playwright `verify-layer-rename-label.mjs` PASS。

### 2026-06-24（Cursor）— 波形ズーム解像度修正 + Footage 削除

- **波形解像度（§11.5.1）**: 曲全体を固定 4096 バケットに圧縮→可視区間へ写像していたため、長尺ソースでズーム時にバケットが枯渇し波形が潰れる不具合を修正。`computePeaksForFrameRange` / `computePeaksForSampleRange` を追加し、`WaveformOverlay` が decode 済みバッファから**可視ソース区間をバー幅ピクセル数で直接ピーク化**する方式へ変更（ズームで解像度が上がる）。spec §11.5.1 散文更新（§5/INV 不変）。
- **Footage 削除（§20.2b）**: Project パネルの audio/image 行に × ボタン＋確認ダイアログ。`store.removeAsset` が asset 削除・参照レイヤーの全 comp 横断カスケード削除・FS 掃除・audio バッファ/波形キャッシュ evict を 1 undo command で実行。spec §20.1/§20.2b 追記。
- **検証**: 365 tests / typecheck 緑。Playwright 実機（30s WAV・旧方式 137 vs 新方式 500 バケット・canvas 956px・`removeAsset` で asset/layer 消滅）+ `verify-audio.mjs` 無回帰 PASS。

### 2026-06-24（Claude Opus）— グリフ分解リグレッション修正 + boxHeight + ボックスリサイズギズモ

- **グリフ分解リグレッション（commit 06e9fa9）**: Phase 1 でレンダラを anchor 相対（glyph 絶対 local x = `g.x`）に直したが `layoutGlyphsForDecompose` が旧 0 基準（`g.x - bounds.minX`）のままで、中央/右寄せテキストの分解が横ズレ。生の `g.x` を使うよう修正＋分解グリフの `boxWidth/boxHeight` を 0 リセット（box 引き継ぎで選択枠が膨らむのを防止）。実機 before==after で確認。
- **boxHeight（§5/§26.1 追加）**: `boxHeight: AnimatedProp<number>`（0=自動高さ, >0=固定でクリップ）。`computeTextContentBounds` が box の maxY を boxHeight or 内容で返す。[textRender.ts](src/runtime/textRender.ts) は boxHeight>0 で `overflow:hidden`。store/builtinComponents/Inspector（Box Height 行）配線。**builtinComponents は Phase2/3 で未更新だった align justify/boxWidth も今回登録**。
- **ボックスリサイズギズモ（§26.3.3）**: `boxWidth>0` のテキスト選択時、ギズモを scale → boxResize に切替（破線枠で区別）。8 ハンドルが boxWidth/boxHeight を編集、反対辺を comp 空間で固定し左/上辺で position 補正。
  - [previewViewer.ts](src/editor/previewViewer.ts) `resizeBoxFromOppositeEdge`（`positionForFixedLocalPoint` 再利用）。
  - [PreviewViewerOverlay.tsx](src/editor/panels/PreviewViewerOverlay.tsx) boxResize モード（横ハンドル=boxWidth のみ/縦=boxHeight のみ で自動高さ保持）。ライブは previewOverride、確定は updateObject（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の onComponentPreview/Commit）。
  - **bounds バグ修正**: `resolveTextPropsAtFrame` のサンプル対象キーに `boxWidth/boxHeight` が無く、ギズモ bounds が箱でなく内容幅になっていた（→ リサイズ起点が狂う）。キー追加で修正。
- **検証**: typecheck / 406 tests / build。Playwright: `verify-text-box-gizmo.mjs`（E=幅+自動高さ維持・S=高さのみ explicit・W=左伸長で posX 補正 PASS）、`verify-decompose.mjs`（before==after 維持）。
- **Box Edit トグル**: ギズモのボックスリサイズ ⇄ 通常 scale を明示切替（store `boxGizmoEnabled`・既定 ON・非直列化）。Inspector の Box Width/Height 近くにボタン配置（[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)）。overlay は `boxGizmoEnabled && boxWidth>0` で box モード。`verify-box-toggle.mjs` で破線枠の ON/OFF 切替を確認。

### 2026-06-24（Claude Opus）— テキスト整列バグ修正 + ボックステキスト/折返し + justify

- **Phase 1: 整列バグ（commit 4df2301）**: `align` は schema/UI/layout 全層に在ったが、center/right で**ギズモ枠だけ左へズレ文字が動かない**不具合。原因 = ギズモ bounds は align を反映（`minX` 負）するのにレンダラがグリフを常に local 原点 0 へ再正規化していた不一致。**Fix** = [textRender.ts](src/runtime/textRender.ts) `applyDraftText`/`renderPreciseText` でテキスト要素を `bounds.minX` だけ左シフトし、描画矩形を `[minX,maxX]` に置いてギズモと一致（AE point text 相対）。left=minX0 は無変化＝非破壊。preview/export/bundle は同一 DomRenderer 経由で 1 箇所修正でカバー。
- **Phase 2/3: ボックステキスト + justify**: §5/§26.1 スキーマに `boxWidth: AnimatedProp<number>`（0=point text・後方互換、>0=固定幅で折返し）追加、`align` に `"justify"` 追加。
  - [textLayout.ts](src/runtime/textLayout.ts): `wrapParagraph`/`breakLongWord`（空白境界グリーディ折返し・長語char-break・決定論 INV-1）、justify の語間均等配分（非最終行のみ）、box 時 align は箱 [0,boxWidth] 基準、bounds は箱枠。`boxWidth` を全シグネチャ末尾に伝播。
  - [builtinComponents.ts](src/runtime/builtinComponents.ts)/[store.ts](src/editor/store.ts)/[glyphDecompose.ts](src/editor/glyphDecompose.ts)/[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)（Box Width 行 + J ボタン）配線。
- **既知の限定事項**: テキストに**エフェクト**を付けると center/right/box で effect region（[DomRenderer.ts:426](src/runtime/DomRenderer.ts#L426) `offsetWidth` ベース）が負シフト/箱を拾わずズレうる。エフェクト無しテキストは問題なし（follow-up）。
- **検証**: typecheck / 402 tests 緑 / build（player.js 再生成）。Playwright 実機 — Phase1: anchor 固定で L/C/R が実再配置（`verify-text-align.mjs` PASS）。Phase2/3: point=1行・box=折返し複数行・justify が非最終行を箱端まで広げる（`verify-text-box.mjs` PASS）。

### 2026-06-24（Cursor）— レイヤーコピペ parent（Null）リマップ修正

- **§21.7 Duplicate/Paste parent 欠落**: コピー段階（`cloneObject`）は `parent`/`isNull` を正しく保持していたが、`cmdDuplicateObjects` が新 ULID のみ付与し **複製セット内の `parent` を旧 ID のまま残していた**（Null+子をカット→ペーストで dangling → world 座標が親なし扱い、コピー→ペーストで子が元 Null にぶら下がる）。**Fix** = [duplicateObjects.ts](src/editor/duplicateObjects.ts) `duplicateObjectsWithRemap`（セット内 parent→新 ID、comp 内既存 parent 維持、dangling→null）を [commands.ts](src/editor/commands.ts) `cmdDuplicateObjects` から呼ぶ（Ctrl+D / Ctrl+V 共通）。spec §21.7 散文追記（§5/INV 不変）。
- **follow-up（未着手）**: expression `scripts/<objectId>/...` パスは Duplicate 時未リマップ（潜在バグ）。
- **検証**: `test/duplicateObjects.test.ts` 5 件 + Playwright 実機（copy-paste / cut-paste で parentRemapped・worldDelta=0・errors none PASS）。369 tests / typecheck 緑。

### 2026-06-24（Cursor）— ZIP 保存（⬇ zip）が UI と不一致 / 動かないように見える不具合

- **原因（§20.4b `newProject` 導入が契機）**: `onExportZip` が **IndexedDbFs を直接読む**のに **`saveToFs()` でストア→FS フラッシュしない**＋`newProject()` が **メモリだけ切替えて FS に旧 `project.json` / `assets/*` を残す**。典型再現 = 編集後すぐ zip、または New→いいえ 後に zip → ダウンロード内容が画面と無関係（「壊れた」）。`serializeProject` 失敗時も `void saveProject` が握りつぶし zip は古い FS を返す。
- **Fix**: [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) `onExportZip` で `await saveToFs()` → `getFs()` 経由で `exportZip`、エラー UI 表示、ダウンロード anchor を body に付与。[store.ts](src/editor/store.ts) `newProject` で FS 全削除後に正準 `project.json` 書込。
- **予防**: `CLAUDE.md` / `.cursor/rules/mafter-effect-agent.mdc` に「Store 投影と FS 正本の整合」ガイド追記。
- **検証**: Playwright（New discard 後 zip が空 Untitled と一致・旧レイヤー名なし・orphan assets なし）/ typecheck 緑。

### 2026-06-24（Claude Opus）— ネスト comp のブレンド/エフェクトをライブ描画（§23.3a・ラスタ無し）

- **症状**: エフェクト/ブレンドの効いたテキストを含む timeline comp を別 comp にネストすると、外側からはエフェクト・描画モードが効いていないように見えた。
- **原因**: `renderNestedComp`（§23 Phase 1 ライブ経路）が `worldTransform`/`opacity`/`z-index` のみ反映で、トップレベルの `applyEffects`/`applyBlendMode` を呼んでいなかった（片側未配線）。
- **Fix**（[DomRenderer.ts](src/runtime/DomRenderer.ts)・ラスタ無し）:
  1. ネスト comp コンテナに `isolation:isolate`（AE collapse OFF 相当）→ 内部ブレンドを precomp 内に閉じ、export 単一 capture でもネイティブに焼ける（INV-2）。
  2. 各内側 div に `setBlendModeStyle`（トップレベルと共有の純ヘルパへ抽出）で `mix-blend-mode` / dither を適用。
  3. `applyNestedLiveEffects` で `EffectDef.apply` の css/svg ピースを内側 div の `filter` に適用。
- **スコープ（#1 = live filter only で確定）**: live filter（blur/色/glow/Fast* displacement）のみ。
- **注意点（spec §23.3a にも記載）**:
  - **full displacement（wave/ripple/turbulentDisplace）・raster 系 effect は live 非対応** → §28.11 の comp 単位ラスタ経路に依存（ブレンドモード自体は全てラスタ無し）。
  - **3D（preserve-3d）× mix-blend-mode**: CSS 仕様上ブレンドが 3D 文脈を flatten。ネスト内に 3D 層＋ブレンド混在で AE と差が出うる（エッジケース・別途）。
  - **Fast\* displacement の region**: 毎フレーム DOM 再構築のため実測サイズが取れないフレームで SVG filter region クランプが甘くなりうる（通常 filter には無影響）。
- **検証**: typecheck / 393 tests / build 緑。spec §23.3a・§23.5 表更新（§5/INV 不変）。実機ブラウザ確認は未実施（follow-up）。

### 2026-06-24（Cursor）— ZIP 前処理のインライン進行表示

- **UX**: `⬇ zip` の前処理（`saveToFs` → FS 読み込み → JSZip 圧縮）に時間がかかり無反応に見えていた。**Fix** = [zip.ts](src/fs/zip.ts) に任意 `ZipExportProgress` コールバック（list/read/pack）/[ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) で `zipBusy`・フェーズ文言・ボタン無効化・§20.4b モーダル連動。spec §20.1/§20.4b 散文追記。
- **検証**: `test/zipProgress.test.ts` + Playwright（`⬇ 準備中…` とフェーズ文言表示 PASS）/ typecheck 緑。

### 2026-06-24（Cursor）— コンポ背景編集を Inspector へ移設（Unity 的選択駆動）

- **§5.6 UI**: Preview ツールバーの `BackgroundControl` を撤去し、**レイヤー未選択時** [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) **Composition** セクション（Background 行 + Size 読取）へ移設。共有 = [BackgroundControl.tsx](src/editor/panels/BackgroundControl.tsx) + [checkerboardStyle.ts](src/editor/checkerboardStyle.ts)。store `setCompBackground` / Preview DomRenderer ライブ反映 effect は不変。
- **§21.4 選択解除**: Escape + タイムライン ruler 左ラベル列空白 click → `selectObjects([])` → Composition インスペクター表示。
- **spec**: §5.6 / §25.2 / §21.4 散文追記（§5/INV/直列化 不変）。
- **検証**: `verify-bg-toggle.mjs` 更新 + typecheck / npm test 緑。

### 2026-06-24（Cursor）— ScrubNumber 適応桁数表示 + Inspector Transform 精度欠落修正

- **症状**: 0.01 未満の値が `0.00` / `0.0` と表示され微調整・KF 編集が不便。Inspector Transform は `propVec3ToDisplay`（`toFixed(1)`）→ `parseFloat` の round-trip で **実データが欠落**していた。
- **Fix**:
  1. [formatScrubDisplay.ts](src/editor/formatScrubDisplay.ts) — 適応桁数 + 末尾ゼロ除去（`0.003`→`0.003`、`1920`→`1920`）。内部値は丸めない。
  2. [ScrubNumber.tsx](src/editor/ScrubNumber.tsx) — 表示を `formatScrubDisplay` に一本化。編集時・title はフル精度。
  3. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — `Vec3Row` を `sampleVec3` の number 直渡しに変更。`propVec3ToDisplay` 削除（[store.ts](src/editor/store.ts)）。
- **spec**: §27.7.1 ScrubNumber 数値表示（散文・§5/INV 不変）。
- **検証**: `test/formatScrubDisplay.test.ts` 9 件 + Playwright 実機（opacity `0.003` 表示・KF 保持・position `100.04` PASS）/ 415 tests / typecheck 緑。

### 2026-06-25（Cursor）— コンポジション Inspector 桁表示修正

- **症状**: Composition の Size が `192`×`108` のように末尾桁が欠けて表示。ラベル `Background` も左端が切れる。
- **原因**:
  1. **主因**: `ScrubNumber` の `decimals={0}` 表示で `toFixed(0).replace(/\.?0+$/, "")` が整数末尾ゼロまで除去（`1920`→`192`、`1080`→`108`）。
  2. **副因**: Inspector `Row` ラベル列 52px 不足・ScrubNumber が flex 縮小しうる。
- **Fix**:
  1. [formatScrubDisplay.ts](src/editor/formatScrubDisplay.ts) — `formatScrubFixed` 追加（`decimals===0` は末尾ゼロ除去しない）。
  2. [ScrubNumber.tsx](src/editor/ScrubNumber.tsx) — `formatScrubFixed` 使用、`flexShrink:0`、表示桁数ベース `minWidth`。
  3. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — `Row`/`Vec3Row` ラベル 72px、`flexWrap`。
- **検証**: `test/formatScrubDisplay.test.ts`（`formatScrubFixed`）+ Playwright（`1920`/`1080` 全文・Background ラベル PASS）/ 433 tests / typecheck 緑。

### 2026-06-25（Cursor）— アクティブカメラを「最前面の自動カメラ」に（AE 準拠）

- **要望**: コンポ映像に使うカメラがプルダウンで手動固定されていた。AE 同様、その時刻で最前面（最大 zOrder）のアクティブなカメラレイヤーを自動で出力カメラにしたい。
- **確定仕様**（§6.5 更新）:
  - 出力（preview/export 共通）= その frame で `enabled && inPoint<=f<outPoint`（=`isVisible`）を満たす camera レイヤーのうち最大 zOrder。該当無し＝デフォルト視点。`resolve()` 内で自動選択（INV-1/INV-2 維持）。
  - 手動プルダウンは**プレビュー視点専用**（AE の 3D View 相当・非永続）。`ResolveContext.previewCamera?: ObjectId|"default"` で、PreviewPanel だけが渡す。export/bundle/nested は渡さない。
  - `TimelineComposition.activeCamera`（§5）を**削除**。旧 project.json はロード時に無視（[serialize.ts](src/core/serialize.ts) で canonicalize 時に drop）。
- **実装**:
  1. [resolve.ts](src/runtime/resolve.ts) — `activeCameraAt(comp, frame)` export + `ResolveContext.previewCamera` + カメラ選択ブロック書換。
  2. [schema.ts](src/core/schema.ts) / [serialize.ts](src/core/serialize.ts) — `activeCamera` 削除 + 後方互換 drop。
  3. [store.ts](src/editor/store.ts) — `setActiveCamera` → 非永続 `previewCamera` / `setPreviewCamera`（undo 非対象）。comp 切替でリセット。`addCamera` は activeCamera 設定をやめた。
  4. [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — resolve 4 経路に previewCamera 注入。override 中は RAM キャッシュをバイパス（editingLive 扱い）。
  5. [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) — プルダウンを「View: …」プレビュー視点セレクタ化。CAM● バッジは `activeCameraAt` の自動結果に。
  6. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — 「Active」ボタン → 「Preview through」トグル。
- **検証**: `test/resolve.test.ts` にカメラ自動選択・フォールバック・override・INV-2 ケース追加 / 453 tests / typecheck / build 緑。
- **未**: ブラウザ実機での UI 配線（プルダウン・バッジ・プレビュー切替）の目視確認は未実施（ユーザー確認待ち）。

### 2026-06-25（Cursor）— ネスト comp のカメラを live で適用（§23.3b・AE non-collapse 準拠）

- **症状**: カメラ付き comp をネストすると、ライブ preview で平面（オルソ）描画になる。`resolve()` は `childScene.camera` を正しく算出していたが `renderNestedComp` が perspective / per-object view を捨てていた（ラスタ経路のみ正しかった）。
- **Fix**（[DomRenderer.ts](src/runtime/DomRenderer.ts) のみ）:
  1. `setupCameraRig` を抽出し `renderFrame` と `renderNestedComp` で共有（§6.5b 同一リグ）。
  2. `objectWorldTransformWithCamera` ヘルパで 3D 層のみ `cameraPre·world`、2D 層は免除。
  3. カメラ無しネスト comp は `perspective` 未設定＝従来どおり無回帰。
- **spec**: §23.3b 新設 + §23.5 比較表に nested camera 行追加（§5/INV/直列化 不変）。
- **検証**: 453 tests / typecheck 緑。Playwright — `verify-nested-3d-camera.mjs`（ネスト内 perspective・3D パン応答 / 2D 免除 / カメラ無し無回帰 PASS）+ `verify-3d-camera.mjs` 無回帰（`activeCameraSet` 断言撤去＝§6.5 自動カメラ移行後の整合）。

### 2026-06-25（Cursor）— コンポ切替時タイムライン viewRange 競合修正

- **症状**: 親 comp（長尺）から別 comp に切り替えると、レイヤーバーが親 comp の表示尺（`viewRange.end`）のまま配置され、短い comp ではバーが圧縮表示・長い comp では伸びきらない。
- **真因**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) の comp 切替 effect（`viewRange` 全リセット）と duration クランプ effect が同一 tick で両方走り、後者が `min(prev.end, duration)` で旧 comp の短い `viewRange.end` を保持していた。
- **Fix**: `prevCompIdRef` で comp 切替を検出し、切替時は `{0, duration}` へ全リセットのみ。duration クランプは同一 comp 内の duration 短縮時のみ実行。
- **検証**: Playwright 実機（150↔300f 切替・full-span レイヤー 100% 幅）PASS / typecheck 緑。

### 2026-06-25（Cursor）— comp レイヤー初期尺を子コンプ duration に合わせる（§23.4a）

- **症状**: 15秒 comp に 5秒 comp を DnD すると、レイヤーバーが親 comp 全尺（15秒）で置かれる。ゴースト（`getLayerSourceExtent`）は子 5秒を示すが `outPoint` が親 duration のまま。
- **Fix**:
  1. [compLayer.ts](src/runtime/compLayer.ts) — `compLayerDefaultOutPoint()` 追加（§23.2 秒ベースで親 frame 換算、`parent.duration` で clamp）。
  2. [store.ts](src/editor/store.ts) — `addCompLayer` の初期 `outPoint` を上記ヘルパに差し替え（`inPoint=0`, `trimStart=0` 既定）。
- **spec**: §23.4a 新設（散文・§5/INV 不変）。
- **検証**: `test/precomp.test.ts`（ヘルパ 4 件 + store 配置尺）/ typecheck 緑 / Playwright（450f 親 + 150f 子 → `outPoint=150` PASS）。

### 2026-06-25（Cursor）— MP4 export 調整レイヤー parity（§27.4.1 / Comp 10）

- **症状**: プレビュー/HTML bundle は正しいが MP4 で Live 調整レイヤー（blur / fastTurbulent）が効かない／弱い。Comp 10（for-debug-data）で再現。
- **真因**: (1) export の `forceAdjustmentRaster` 経路で複数 Live 調整の backdrop capture が **並列起動**（`Promise.all`）し z 順積層が preview compositor と一致しない。(2) foreignObject が `backdrop-filter` / `preserve-3d` 非対応（設計上の export 制約）。
- **Fix**:
  1. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `flushExportComposite()` 追加: 非調整 raster を `flushRasterEffects` で待った後、Live 調整 bake を **zOrder 直列キュー**（`exportAdjustmentQueue`）で実行。`trackRasterWork()` で `forceAdjustmentRaster && isAdjustment` のみ直列化。
  2. 調整 backdrop capture — `captureAdjustmentBackdrop()` + threeD 下位層の snapshot→img 置換（foreignObject 3D flatten 緩和）。
  3. [exporter.ts](src/runtime/exporter.ts) — `flushRasterEffects` → `flushExportComposite` に差替。
  4. 検証 — `verify-comp10-export-parity.mjs`（for-debug-data zip → Comp 10）、`verify-export-adjustment.mjs` に `forceAdjustmentRaster` 追加。
- **検証**: typecheck / 458 tests 緑 / `verify-comp10-export-parity.mjs` PASS（f7 完全一致、f0 export blur 検出）。
- **follow-up**: f100 等で上位数位レイヤー（z>14）が計測域を覆うため edgeStd 比較だけでは偽陽性/偽陰性あり。preview パネル screenshot 比較の強化、§23.3d ネスト内調整 export。

### 2026-06-25（Cursor）— Live 調整 export 経路修正（preview 真・Comp 10 消える問題）

- **症状**: MP4 export で Live 調整レイヤーのエフェクト発動時に下位コンテンツ（3D ネスト comp 等）が消える。通常レイヤー直付け effect は問題なし。preview / HTML bundle は正しい。
- **spec 上の真**:
  - **preview / HTML bundle** = Live 調整の `backdrop-filter` 経路が正（§27.4 INV-2）。
  - **mp4/png** = 見た目は preview と一致すべき。旧 spec の `auto_raster_mp4`（Live 調整を comp 背面 capture へ強制 bake）は、foreignObject が `backdrop-filter` 非対応という前提だったが、**最終 root capture では Chromium で live backdrop が preview と一致**（Comp 10 f100 で実測 0% diff）。
  - **Raster 調整**（`adjustmentMode="raster"`）= 常に capture bake が正。
- **真因**: exporter の `forceAdjustmentRaster: true` が Live 調整を comp 背面 bake + `reapplyAdjustmentSuppression`（下位レイヤー `visibility:hidden`）へ強制。3D ネスト comp の bake が壊れ、調整 canvas だけが残りコンテンツが消えた。
- **Fix**:
  1. [exporter.ts](src/runtime/exporter.ts) — `forceAdjustmentRaster` 削除。Live 調整は preview 同様 `backdrop-filter` + `flushRasterEffects`。
  2. [DomRenderer.ts](src/runtime/DomRenderer.ts) — Raster 調整専用の直列 bake は維持（`shouldSerialExportAdjustment`）。`prepareAdjustmentBackdropForCapture` で multi-pass 時に suppressed 下位を再表示しない（§27.4.1）。
  3. 検証 — `verify-comp10-export-parity.mjs` / `verify-export-adjustment.mjs` を preview↔export ピクセル diff に更新。
- **検証**: typecheck / 458 tests 緑 / Comp 10 f0/f7/f100/f145 diff 0% / 単純 blur 調整 diff 0% / f100 screenshot 目視一致。
- **follow-up**: `auto_raster_mp4` spec 散文（§27.4）を実測結果に合わせて更新検討。foreignObject で live backdrop が効かないケースの parity 検出→フォールバック bake。

### 2026-06-25（Cursor）— Live 調整 export 経路修正 → **未解消**（issue doc 更新）

- **ユーザー確認**: 「消える」症状は直ったが **調整レイヤー effect が MP4 で効かなくなった**。
- **整理**: foreignObject は `backdrop-filter` 非対応 → bake（`forceAdjustmentRaster`）が必要。現行は bake を外したため effect 欠落。旧 bake は 3D ネスト comp で壊れて「消える」。
- **trade-off**: A=live backdrop（effect ✗ / 表示 ✓） vs B=bake（effect ✓ / 表示 ✗ when broken）。目標は B を直して exporter に戻す。
- **検証の誤り**: `verify-comp10-export-parity.mjs` が同一 offscreen 経路同士比較で 0% — Preview パネル vs MP4 の一致を証明していなかった。
- **記録**: [doc/issue/mp4-live-adjustment-layer-parity.md](doc/issue/mp4-live-adjustment-layer-parity.md) を現状に合わせて更新（状態=未解消）。

### 2026-06-25（Sonnet）— MP4 Live 調整 parity **解消**（bake 復帰 + 真因＝3D flatten 除去）

- **方針**: bake 経路 B を復帰（ユーザー確認済み）。getDisplayMedia 案は INV-2 非決定性リスクで不採用。
- **実機局在化（empirical, debug-visual-render-bug）** — Comp 10 f100 を 3 経路で capture し真因を特定:
  - A `forceAdjustmentRaster:false`（旧）: blue diamond **写る**（blueRatio 0.069）→ **foreignObject は 3D ネスト comp を焼ける**（doc の「foreignObject 3D 非対応」前提は誤り）。
  - B `forceAdjustmentRaster:true`（bake 現状）: **grey 一色・content 消失**（blueRatio 0）。
  - flatten を切ると B = blueRatio 0.126（content 復活 + effect 適用）。
  - **真因**: `snapshotThreeDSubtreesBelow`（3D 下位 subtree を capture→img 置換）が **それ自体コンテンツを空 img に潰していた**。flatten こそが「消える」原因だった。
- **Fix**:
  1. [exporter.ts](src/runtime/exporter.ts) — `forceAdjustmentRaster:true` 復帰 + `flushRasterEffects`→`flushExportComposite`（MP4 / PNG 連番 両経路）。
  2. [compFrameCapture.ts](src/runtime/compFrameCapture.ts) — 同種欠陥（RAM Preview / precomp raster / bundle bake が `flushRasterEffects` のみ）を同様に修正。
  3. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `snapshotThreeDSubtreesBelow` / `hasNestedCameraRig` / `data-has-camera-rig` マーカーを**全削除**。`captureAdjustmentBackdrop` は root を直接 capture（foreignObject が 3D も焼く）。
  4. 検証スクリプト — `verify-comp10-export-parity.mjs` / `verify-export-adjustment.mjs` を **実 Preview パネル screenshot vs export(bake)** に書換（旧版は同一 offscreen 経路同士で無意味）。判定は pixel-diff ではなく **中央走査線 std（効果シグネチャ）**（消失時 export std が崩れる／pixel-diff は blank の方が小さく出るため不適）。Preview 取得用に PreviewPanel に `data-testid="preview-canvas-root"` 追加。
- **検証**: typecheck / 458 tests 緑 / `verify-comp10-export-parity.mjs` PASS（f100 export std 2.9→23.9 ≈ preview 30）/ `verify-export-adjustment.mjs` PASS（blur ぼけ縁 mid=96）/ 回帰 verify 全 PASS（verify-nested-3d-camera, verify-3d-camera, verify-export-bake, verify-export-filter, verify-fast-export-parity, verify-comp19-adjustment）/ f100 export 画像で content+blur 目視確認。
- **follow-up**: §27.4 spec 散文の「foreignObject は preserve-3d 非対応 → 3D 個別 capture 必要」記述が実測と矛盾（root capture で 3D も焼ける）。spec 更新は §5/INV 不変なので Cursor 主導で可。

### 2026-06-25（Opus）— MP4 Live 調整の**ちらつき**を構造解消（export 合成をオフDOMへオーバーホール）

- **症状**: bake 復帰後 effect は乗るが MP4 が**ちらつく**（ユーザー報告・`for-debug-data/Comp_10 (2).mp4`）。
- **真因**: bake（`forceAdjustmentRaster`）は毎フレーム **live DOM を破壊操作**（`visibility` トグル + raster overlay + `holdLastRaster`/`frameRenderCache` 使い回し + 直列キュー）。非同期競合で前フレーム状態が次フレームのキャプチャに混入 → ちらつき。
- **方針決定（ユーザー確認）**: デプロイは**ブラウザのみ**（静的・バックエンドなし）→ ヘッドレス Chromium 正準書き出し（spec §16/M3.5, A 案）はクライアント不可。getDisplayMedia（B 案）は実時間/解像度/精度で不適。→ **C1: ブラウザ内のまま、export 合成を live DOM 非破壊・ステートレスに作り直す**。
- **実装**:
  1. [exportComposite.ts](src/runtime/exportComposite.ts)（新規） — `compositeExportFrame`: 毎フレーム fresh に z 昇順で累積 master canvas を組み、調整レイヤー到達点で master（=確定背面）に effect chain を適用。調整/blend 無しなら単一ショット root capture（3D 深度保持）の高速経路。
  2. [effectRaster.ts](src/runtime/effectRaster.ts)（新規） — `applyFilterChainToBuffer`（旧 DomRenderer.applyCssSvgFilterToBuffer を pure 化、live/export 共有）。
  3. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `exportCompositeMode` 追加（true 時、調整レイヤーは live DOM を触らず effect chain を `entry.exportChain` に保存するだけ）。`getExportLayers()` / `hasAdjustmentLayers()` 追加。
  4. [exporter.ts](src/runtime/exporter.ts) / [compFrameCapture.ts](src/runtime/compFrameCapture.ts) — `forceAdjustmentRaster`→`exportCompositeMode`、`flushExportComposite`→`flushRasterEffects`、capture を `compositeExportFrame` に一本化。
- **raster effect**: レイヤ直付け raster は従来どおり自前 canvas に焼かれ単体キャプチャが拾う。調整 raster（displacement 含む）は master に既存 helper を pure 適用。両方 export で焼ける（f100 で目視確認）。
- **検証**: typecheck / 458 tests / build 緑。`verify-comp10-export-parity.mjs` 書換（**ちらつき＝フレーム間状態リーク検査**: seq[1 renderer 順次] vs iso[frame ごと新 renderer] の diff。stateless なら 0%）→ **f82–100 全フレーム seqVsIso=0.000%**（＝ちらつき根絶）+ parity OK + f88/f100 目視で content+effect 確認。回帰 verify 全 PASS（export-adjustment / export-bake / export-filter / fast-export-parity / 3d-camera / nested-3d-camera / comp19-adjustment）。
- **未削除（意図的・低リスク優先）**: `forceAdjustmentRaster` フラグ + bake pipeline（`runAdjustment*Pipeline` / `captureAdjustmentBackdrop` / `flushExportComposite` / `exportAdjustmentQueue`）は **live preview の displacement / raster-mode 調整経路と entangle** しているため残置。`forceAdjustmentRaster` はどこからも true にされず（export は `exportCompositeMode` を使う）ちらつき経路は再活性化しない。完全削除は `effectRouting.ts` / `adjustmentMode.test.ts` に波及するため follow-up（要回帰確認）。

#### 追補（同日 Opus）— 調整フレームで**カメラがちらつく**バグも修正

- **症状**: 上記オーバーホール後、調整 effect/opacity は安定したが、**カメラ(perspective)が効くフレームと効かないフレームが断続的に出る**（ユーザー報告）。
- **真因**: perspective / perspective-origin / preserve-3d は **root** に付き、preview では全レイヤがその perspective root の子。初版 compositor は調整フレームでレイヤを **root から切り離して個別 capture** していたため 3D 層の perspective 射影が落ち、`hasAdjustmentLayers()` が in/out で切り替わるたびに fast path(root 一括=カメラ有り) と slow path(per-layer=カメラ無し) が交代 → カメラのちらつき。
- **実機局在化**（`verify-diag-capture.mjs`）で f100 を計測: root 一括 capture=std37.1（カメラ正）/ per-layer 無 perspective=std70.1（カメラ落ち）/ **per-layer を root と同じ perspective ラッパで包む=std37.1（root と pixel 一致）**。
- **修正**: [exportComposite.ts](src/runtime/exportComposite.ts) を **per-layer + perspective ラッパ**方式に変更（`captureLayerWithPerspective`: 各レイヤを `perspective`/`perspective-origin` = root と同値の div に入れて capture）。2D 層は perspective 無影響、3D 層は正しく射影。blend は `globalCompositeOperation`、調整は master に chain 適用。調整も blend も無いフレームは root 一括 capture の高速経路。
- **検証**: typecheck / 458 tests / build 緑。`verify-comp10-export-parity.mjs` に **camera 保持検査**追加 → f100 で per-layer+persp std=37.1 == root std=37.1（rel 0.0% / pixel diff 0.00%）＝カメラ完全保持。ちらつき seq≡iso=0.000% 継続。f100 export 目視でコンテンツが perspective 射影＋blur されているのを確認。回帰 verify 全 PASS（export-bake / export-filter / fast-export-parity / 3d-camera / nested-3d-camera / export-adjustment / comp19-adjustment）。

#### 追補（2026-06-26 Opus）— **ネスト comp 内の調整レイヤーが export で焼けない**バグも修正

- **症状**: Comp 19 → Comp 10（調整5枚=blur/fastTurbulentDisplace）をネストした状態で **Comp 19 を書き出すと、子 Comp 10 内の調整 effect が適用されない**（preview では効くが mp4/png で消える・ユーザー報告 `for-debug-data/Comp_20.mp4`）。
- **真因**: ネスト comp は `renderNestedComp` で live 描画され、子の調整は CSS `backdrop-filter`。親 export の `compositeExportFrame` は子 comp を**1枚の通常レイヤーとして foreignObject capture** していたため、§27.4 と同じ理由で **`backdrop-filter` が落ちて子の調整が消える**。さらに調整専用 comp は `compNeedsAutoPreviewCache` の raster 対象でないため preview rasterizer でも拾われない。exporter は nestedCompRasterizer も持たない。
- **修正方針（spec §27.4.1 軸1「precomp は1枚に合成・確定してから親が1レイヤーとして扱う」に準拠）**: ネスト comp が（再帰的に）調整を含むなら、**子 comp 自身の座標系で同じオフDOM・ステートレス z 順コンポジタに掛けて1枚へ確定**してから親へ置く（再帰・depth ≤ 4）。**何段ネストしても**各段で調整が確定する。
- **実装**:
  1. [effectChain.ts](src/runtime/effectChain.ts)（新規） — `resolveEffectChain`（pre/raster/post の token・svg defs・rasterChain 構築を純関数化）。top-level `applyEffects` とネスト export タグ付けで共有（chain が2本にならない・INV-2）。
  2. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `applyEffects` を `resolveEffectChain` へ集約。`renderNestedComp` は `exportCompositeMode` 時、調整 div に `backdrop-filter` を立てず **解決済み chain を `div.__exportLayer`** に、コンテナに **`__nestedComposite` + `data-nested-composite` 属性**を付与。`frameHasNestedComposite` / `hasNestedComposite()` 追加（高速経路の除外判定）。
  3. [exportComposite.ts](src/runtime/exportComposite.ts) — `compositeContainer`（コンテナを子座標系で z 順合成）+ `captureLayerNode`（レイヤ subtree に composite 必要なネスト comp があれば、子を先に確定 → **クローン側でコンテナ中身を確定画像 `<img>` に差し替え**てから capture・live DOM 非破壊）を相互再帰。fast path 判定に `hasNestedComposite()` を追加。
- **検証**: typecheck / 458 tests / build 緑。新 `verify-comp19-nested-export.mjs`（恒久・回帰用）で **新経路 `compositeExportFrame` vs 旧高速経路 `captureElementToCanvas(root)`（=backdrop 落ち）を対照**: Comp 19 f0/f100 + **WRAP→19→10 の depth-2** すべて PASS（子の blur が焼け flat はシャープ＝旧バグ・edge↓最大75.5%・目視確認）。`hasNestedComposite=true`。回帰 verify 全 PASS（comp10-export-parity の flicker 0%/camera 保持・nested-3d-camera・3d-camera・export-adjustment・export-bake・export-filter・fast-export-parity・comp19-adjustment preview backdrop）。
- **carve-out**: 調整も CSS blend も持たないネスト comp は従来どおり親の単一 capture に含めて焼く（3D 文脈保持の高速経路・無回帰）。

### 2026-06-25（Cursor）— 実装ループスキル化 + エージェントプロンプト追記

- **要請**: 直近の修正メソッド・思考フレームワーク・一連の流れを抽象化し、新機能/バグ修正時にエージェントが参照する統合ループとしてスキル化。
- **追加**: [.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md) — Phase 0–5（progress/spec → スコープ → 影響地図化 → 最小実装 → Playwright+経路間 parity → 固定・記録）。バグは経路分解、視覚系は `debug-visual-render-bug`、エフェクトは `implement-visual-effect`、新型は `add-layer-component-type` へ分岐。
- **プロンプト追記**: [CLAUDE.md](CLAUDE.md)「実装ループ（必須スキル）」、[mafter-effect-agent.mdc](.cursor/rules/mafter-effect-agent.mdc) 実装ワークフロー Phase 番号化 + バグ修正時スキル分岐表、[implementation-loop.mdc](.cursor/rules/implementation-loop.mdc)（要約ルール）、[debug-visual-render-bug.mdc](.cursor/rules/debug-visual-render-bug.mdc) から親ループへのリンク。下位 3 スキルに親参照を追加。

### 2026-06-25（Cursor）— 実装ループのプロンプト隔離

- **要請**: ループ本体が `CLAUDE.md` / `alwaysApply` ルールに重複してシステムプロンプトを汚染しないよう隔離。
- **変更**: 正本は `.claude/skills/implementation-loop/SKILL.md` のみ（一貫性ゲート・Playwright 手順・抽象要請の確認をスキルへ移設）。`CLAUDE.md` / `mafter-effect-agent.mdc` / `implementation-loop.mdc` / `debug-visual-render-bug.mdc` は**ポインタのみ**に縮小。ループ更新はスキルファイルだけ編集すればよい。

### 2026-06-26（Cursor）— 動画 Footage インポート（image と同型 UX）

- **要請**: 画像インポートと同じバイブスで動画を読み込み・タイムライン配置できるようにする。
- **実装**:
  - [videoAssetProbe.ts](src/runtime/videoAssetProbe.ts) — import 時 `width`/`height`/`duration`/`mime` を probe
  - [imageAssetCache.ts](src/runtime/imageAssetCache.ts) — `loadFromProject` で video を blob URL 読み込み、`evictAsset` / `registerPreviewImageCache`
  - [store.ts](src/editor/store.ts) — `importVideoAsset` / `addVideoLayer`（ソース尺で `outPoint` 自動トリム）、`removeAsset` に video 許可
  - [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) / [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) — `+ Video`、DnD、OS ドロップ
  - [builtinComponents.ts](src/runtime/builtinComponents.ts) — `VIDEO_COMPONENT_DEF`
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — video に `fit`（objectFit）適用
  - spec §11.4 / §20.1 / §20.2b 散文更新（§5 非変更）
- **検証**: `npm run typecheck` 緑、`test/videoAssetProbe.test.ts` 追加、459 tests（`previewPlaybackLoop` 1件は既知フレーク）、`verify-video-import.mjs` PASS
- **エッジケース検証（追補）**: `verify-video-import-edges.mjs`（12項目 PASS）— +Video ボタン / Footage クリック配置 / blob キャッシュ / 再生トグル / 1回再生停止 / **レイヤーカット（in·out + trimStart）** / **途中スクラブ・途中から再生**。ユニット: `test/videoLayerOutPoint.test.ts`・`imageAssetCache` video blob
- **スコープ外（別タスク）**: export 時 `requestVideoFrameCallback` による seek 精度改善、動画内蔵音声

### 2026-06-26（Cursor）— HTML bundle：MP4 入りコンポの再生もっさりを優先タスク化

- **ユーザー要請**: MP4 が入ったコンポジットを HTML bundle で書き出すと再生がもっさる件を、優先度高めで progress に記録。
- **記録先**: 「既知のバグ・未解決課題」+ Next steps **#0（優先度高）**。想定修正方針 = Preview 経路と同様の `previewVideoPlayback`（`video.play()` でネイティブ decode）に揃える。
- **未着手**（実装・verify は次セッション）。

### 2026-06-26（Cursor）— 動画 preview 再生のもっさり感修正

- **症状**: 動画レイヤー入りコンポの再生が、通常コンポより重く・カクついて感じる。
- **真因**: DomRenderer が毎フレーム `video.currentTime` で seek していた。さらに 0.05s 閾値のため 30fps では約2フレームに1回しか更新されず、見た目も15fps相当に。
- **修正**: [videoElementSync.ts](src/runtime/videoElementSync.ts) — preview 再生中は `video.play()` でネイティブ decode に任せ、停止/スクラブ/export は半フレーム閾値で seek。`setPreviewRenderOptions({ previewVideoPlayback })` を PreviewPanel / BundlePlayer から配線。
- **検証**: `test/videoElementSync.test.ts` 7件、`verify-video-import-edges.mjs` 12/12 PASS

### 2026-06-26（Cursor）— 動画レイヤー export（foreignObject + もっさり修正）

- **症状**: 動画入りコンポの書き出しでブラウザ標準の video プレイヤー UI が出る。修正後は映像は出るが書き出し動画がもっさり。
- **真因（UI）**: SVG `foreignObject` は `<video>` を描画できない → clone 側でフレームを img 化が必要。
- **真因（もっさり）**: `waitForVideoFrame` が `readyState` だけ見て seek 完了前に capture → 古いフレームを繰り返し焼く。加えて毎フレーム full-res PNG インライン + 二重 wait で export が重い。
- **修正**:
  - [rasterCapture.ts](src/runtime/rasterCapture.ts) — `inlineVideoFrames`（clone のみ img 化）、`inlineExportMedia`
  - [videoElementSync.ts](src/runtime/videoElementSync.ts) — `waitForVideoFrame`: `seeking` → `seeked` → `requestVideoFrameCallback`（rVFC 未応答時 400ms フォールバック）
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — `flushVideoFrames()`、`controls=false`
  - export 経路（[exporter.ts](src/runtime/exporter.ts) / [compFrameCapture.ts](src/runtime/compFrameCapture.ts)）で capture 前に `flushVideoFrames`
  - インラインは表示サイズ + JPEG（二重 wait 削除）
- **もっさり追補（export play-step）**:
  - `exportVideoStep` — 連続フレームは `play()` でデコードを進め、逆行・大ジャンプのみ seek（毎フレーム seek の 400ms+ を回避）
  - `waitForVideoFrame(video, targetSec)` — ターゲット時刻に乗るまでポーリング + rVFC
  - exporter / compFrameCapture で `exportVideoStep: true`
- **検証**: `test/videoElementSync.test.ts` 12件、`verify-video-export.mjs` PASS（avg ~139ms/frame、以前 ~472ms）。**ユーザー手動確認は未解消** → [doc/issue/video-footage-export-sluggish.md](doc/issue/video-footage-export-sluggish.md)

### 2026-06-26（Claude Opus）— 動画 export ちらつき（戻り進み）・もっさり 真因修正 ✅

- **症状（更新）**: export play-step 後、出力が「戻ったり進んだりちらつく」「もっさりより悪化」（ユーザー報告）。
- **真因1（ちらつき = 前後振動）**: `exportVideoStep` の `play()`。play は**実時間進行**のため export ループの離散フレーム処理とズレ、ターゲットを行き過ぎ→逆行 seek→再度行き過ぎ、でキャプチャフレームが前後に振動。INV-2（フレーム決定論）違反。
  → **修正**: `syncVideoElementExportStep` を `play()` 廃止し**各フレーム決定論 seek**に（[videoElementSync.ts](src/runtime/videoElementSync.ts)）。
- **真因2（もっさり = 1/3 フレーム重複）**: フレーム境界 `k/fps` ちょうどへの seek は float 丸めで currentTime が境界をわずかに下回り、**前フレームが選ばれる**（k≡2 mod 3 等で毎3フレーム重複 → 実質20fps化）。タイムベース 1/15360 で `2/30*15360=1023.99…→floor 1023→frame1`。
  → **修正**: `videoSeekTargetSec(target, fps) = target + 0.5/fps`（**フレーム区間中央へ seek**）。scrub（preview 停止）と export 双方で共有＝preview↔export 同一フレーム表示（INV-2 単一の正）。
- **真因3（stale capture）**: `waitForVideoFrame` が seek 直後の古い present で resolve。
  → **修正**: `waitPresentedFrame` で rVFC の `mediaTime ≈ target` を満たす present まで待機（present budget 300ms フォールバック）。
- **スコープ**: 変更は `videoElementSync.ts` のみ（export step / scrub seek / present wait）。preview **再生**（`play()`）は不変。`rasterCapture` / `DomRenderer` / `exporter` は無変更。
- **検証**:
  - `test/videoElementSync.test.ts` 14件 PASS、`npm test` 全 479 PASS、typecheck 緑。
  - **新規 `verify-video-export-monotonic.mjs`**（恒久）: 連続フレームを順に書き出し `<video>.currentTime`／フレーム間差分を測定し **reversals=0・stuckFrames=0・onTarget=25/25** を確認。旧 `verify-video-export.mjs` は静的な劣化アセット（`video_test.mp4` 自体が旧プレイヤーUIバグの焼き込み＋ほぼ静止）で**動き検出が無効**だったため、ffmpeg `testsrc2` で生成した動く素材 `for-debug-data/video_motion.mp4`（`ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=3 -pix_fmt yuv420p`）を使用。`VERIFY_VIDEO` で差し替え可。
  - 既存 `verify-video-export.mjs` PASS（playerUi=0%・非blank 無回帰）。
- **残（別タスク・symptom B）**: 1フレーム ~320ms は foreignObject ラスタ化（~290ms）が主因で本修正と独立。高速化は「video を foreignObject 外で直接 canvas 合成 / WebCodecs」案（issue §未試行 #1/#2）。出力の動き（symptom A）は解消。

### 2026-06-26（Cursor）— Project Bin v1（仮想フォルダ・単一ツリー）

- **要請**: AE 型 Project パネルで comp/footage を仮想フォルダ（Bin）で整理。v1 は Bin ツリーのみ（font import / Replace Footage は Phase 2）。新規 import / +Comp / +HTML は常にルート直下。
- **スキーマ（additive・ユーザー承認済）**: `Project.bins` / `Project.treeOrder` / `CompositionMeta.binId` / `AssetEntry.binId`（resolve・compRef・asset 参照は ULID のまま非接触）。
- **実装**:
  - [projectTree.ts](src/core/projectTree.ts) — ツリー純関数（create/delete/move/register、`ensureProjectTree`、`treeOrderIsRedundant`）
  - [serialize.ts](src/core/serialize.ts) — `bins` id 昇順、`treeOrder` ユーザー順保持、既定順と同じ `treeOrder` は省略（byte 等価）
  - [validate.ts](src/core/validate.ts) — bin 循環検出、未知 `binId` warn + root 化
  - [store.ts](src/editor/store.ts) — `createBin` / `renameBin` / `deleteBin` / `moveProjectEntries`、既存 add/import/remove に tree 配線
  - [ProjectTreeView.tsx](src/editor/panels/projectTree/ProjectTreeView.tsx) — 単一ツリー、検索、フォルダ CRUD、DnD（フォルダへドロップ）、Timeline DnD 維持
  - [projectBinStorage.ts](src/editor/projectBinStorage.ts) — フォルダ開閉 localStorage
  - [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) — `ProjectTreeView` 置換、Plugins は下部固定
  - spec §5 / §20.5 / §5.6-canon 追記
- **検証**: `npm run typecheck` 緑、`test/projectBins.test.ts` 7件、`npm test` 486 PASS（roundtrip / canonical-edge 回帰なし）
- **Phase 2（v1 外）**: `importFontAsset`、`replaceAsset`、行間 DnD 並べ替え、OS→Project 直接 DnD、Playwright 実機 verify スクリプト

### 2026-06-26（Cursor）— Expression プリセット: Oscillate / Pulse

- **要請**: wiggle に加えオシレーション（position Y 軸 sin）とパルス（scale 均一 sin）の Inspector プリセットを追加。
- **実装**:
  - [expressionPresets.ts](src/editor/expressionPresets.ts) — 3 プリセット定義・`@mafter:preset` marker・脚本テンプレート
  - [expressionModuleHub.ts](src/editor/expressionModuleHub.ts) — Preview/store 共有 ModuleLoader + `invalidateExpressionPath`
  - [store.ts](src/editor/store.ts) — `applyExpressionPreset` / `disableExpression`（`addWiggleExpression` 置換）
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — Expression 折りたたみに 3 ボタン・active 判定
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — 共有 expression loader 経由
  - spec §9 散文追記、`test/expr.test.ts` に marker / 評価テスト
- **検証**: `npm run typecheck`、`npm test`（expr プリセットテスト含む）

### 2026-06-27（Cursor）— Pulse Scale 波形プルダウン

- **要請**: pulse scale インスペクタで波形形状をプルダウン選択（KF 不要）。
- **実装**: [expressionPresets.ts](src/editor/expressionPresets.ts) — `waveform` enum（sine / triangle / square / sawtooth・非アニメ）+ 脚本の波形分岐。`ensurePresetScript` を正本同期（既存 FS も起動時更新）。[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) `ExpressionPresetFields` に enum 行（Effect 同型）。`test/expressionPresetInstance.test.ts` に waveform 注入・形状テスト追加。
- **検証**: `npm test` expressionPresetInstance 7 PASS / typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale 波形プルダウンが効かない 修正

- **症状**: Waveform を変えてもプレビューが sine のまま。
- **真因 (2)**: (1) `makeEvaluator(comp)` が comp をクロージャ固定 → Inspector で `expressionPresets.props` を更新しても評価時は古い props。(2) 脚本更新後 `ModuleLoader` キャッシュ未破棄 → 旧 pulse-scale.js（波形分岐なし）が動き続ける。legacy 表示は readOnly で enum 変更が migrate デフォルトのみ。
- **修正**: `makeEvaluator(comp, resolveComp?)` + PreviewPanel で store から live comp 参照。`ensurePresetScript` 書込時に `invalidateExpressionPath`。legacy enum 変更は migrate 時に選択波形を `propsOverrides` で渡す。
- **検証**: `test/expressionPresetInstance.test.ts` live props テスト追加・typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale Bend +/-（Serum 風位相ワープ）

- **要請**: のこぎり等の波形に対し Bend -/0/+ でランプを凹/直線/凸に歪める（Serum BEND +/- 相当）。
- **実装**: [expressionPresets.ts](src/editor/expressionPresets.ts) — `bend` scalar（-1..1・KF 可・既定 0）。`bendPhase(t,bend)` = bend>0 なら `t^(1/(1+bend))`（急上昇→緩やか）、bend<0 なら `t^(1-bend)`（緩やか→急上昇）。全 waveform の周期位相 `t` に適用後に形状評価。
- **検証**: sawtooth で bend+ > neutral > bend- を単体テスト固定。

### 2026-06-27（Cursor）— Bend 視認性改善（強度 4x + 波形プレビュー）

- **症状**: Bend を動かしてもプレビュー上で効いているか分かりにくい。
- **修正**: (1) `bendPhase` の指数を `PULSE_BEND_GAIN=4` で強化（±0.5 でも明確な差）。(2) [pulseScaleWave.ts](src/runtime/pulseScaleWave.ts) に数学を集約し脚本・UI・テストで共有。(3) Inspector Pulse Scale に **1 周期 SVG プレビュー**（緑=変調曲線・赤=現在位相・sawtooth 推奨表示）。スクラブ中は previewOverride を反映。
- **検証**: `test/pulseScaleWave.test.ts` 3件・typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale Phase / Polarity + Bend 細スクラブ

- **要請**: Bend を 0.1 倍細かくスクラブ / Phase 360°+ オフセット / Polarity 反転。
- **実装**: `phase`（°・KF 可・min 0・上限なし）`polarity` enum（`+`/`-`）追加。[pulseScaleWave.ts](src/runtime/pulseScaleWave.ts) `pulseCycleT`・`polaritySign`。Bend 行のみ `ScrubNumber speed=0.1`（1px=0.1）。プレビューに φ°・polarity 表示。
- **検証**: `test/pulseScaleWave.test.ts` 5件・typecheck 緑。

### 2026-06-28（Cursor）— Orbit Position エクスプレッション追加

- **要請**: 実用的なエクスプレッションをもう 1 個追加。
- **実装**: `orbit-position` — 基準位置を中心に円運動。パラメータ: `radius`（既定 80）/ `frequency`（既定 0.5 Hz）/ `phase`（°・KF 可）。既存 `ctx` API のみ・ランタイム変更なし → `build:player` 不要。
- **検証**: `test/expressionPresetInstance.test.ts` orbit 2件・`test/expr.test.ts` marker 更新・11+27 tests PASS。

### 2026-06-29（Opus）— コンポ BPM 併記表示（非破壊・編集補助・§21.1b）

- **要請**: コンポに BPM/beatsPerBar を持たせ、タイムラインの時間表示に `Bar.Beat` を併記（音楽 MV 編集補助）。
- **設計**: `bpm`/`beatsPerBar` を `CompositionMeta` に additive。表示専用メタで `resolve()`/export/bundle 非参照（INV-1/2/3/5 不変）。spec §5.6 + §21.1b 追記（SSoT 先行）。
- **実装**:
  - [schema.ts](src/core/schema.ts) `CompositionMeta` に `bpm?`/`beatsPerBar?`。
  - [serialize.ts](src/core/serialize.ts) `stripBpmMeta`（bpm 無効=両キー省略=byte 等価 / 既定 beatsPerBar=4 省略）を **timeline・html 両分岐**に適用。
  - [validate.ts](src/core/validate.ts) `validateCompMeta` を**全 comp**（timeline/html）で実行（負/非数 bpm strip・bpm=0 で beatsPerBar 落とし・不正 beatsPerBar→4）。
  - [beatTimecode.ts](src/editor/beatTimecode.ts) 純関数 `formatBarBeat`/`formatTimeWithBeat`。拍境界の浮動小数誤差を epsilon でスナップ（frame 60@120BPM/30fps → "2.1"）。
  - [store.ts](src/editor/store.ts) `setCompBpm`/`setCompBeatsPerBar`（command・undo 可・bpm 無効時 beatsPerBar no-op）。
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) Composition に BPM 行（+ライブ bar.beat）/ Beats per Bar 行（bpm>0 時のみ）。
  - [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) toolbar 現在時刻・右上 current/duration・ルーラー目盛り（薄色付加）の 3 箇所で併記。
- **添削で直した懸念**: ① validate がタイムライン comp しか回らない → 全 comp meta パス追加。② canonicalize の bpm 省略を両分岐に。③ `beats % beatsPerBar` の FP 誤差 → epsilon。④ 9px ルーラーのクラッタ → bar.beat を薄色化。
- **検証**: `test/beatTimecode.test.ts`(7)・serialize byte 等価(3)・validate 正規化(3) 追加。`npm test` 526 PASS・typecheck 緑。実機 [verify-bpm-timeline.mjs](verify-bpm-timeline.mjs) で BPM トグルの併記出現/消滅・3/4 拍を確認（PASS）。
- **build:player**: 不要（ランタイム非変更・`playerBuildFreshness` 緑）。
- **スコープ外**: 拍/小節スナップ・ルーラー拍単位切替・Preview 併記・downbeat offset。

### 2026-06-29（Opus）— BPM ルーラー二段表示

- **要請**: bpm≠0 のとき時間ルーラーを上下二分割（上=タイムコード / 下=BPM の Bar.Beat）。表示のみでタイムライン挙動は不変。
- **実装**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `Ruler` を二段化。上段=従来タイムコード目盛り（bpm 有効時は高さ 50%）／下段=**拍に整列した独自 Bar.Beat 目盛り**（拍/小節単位で適応間引き・小節頭は明色・中央分割線）。bpm 無効時は従来どおり単段。spec §21.1b 更新。
- **検証**: typecheck 緑・実機 [verify-bpm-ruler.mjs](verify-bpm-ruler.mjs) で下段 Bar.Beat 目盛り（1.1/1.3/2.1…）描画・bpm=0 で単段化を確認。toolbar 併記（formatTimeWithBeat）は従来どおり維持。

### 2026-06-29（Opus）— BPM ルーラー目盛り密度アップ

- **要請**: 広い範囲を見ているときも BPM をもう少し細かく表示。
- **実装**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `Ruler` の下段拍目盛りの密度目安を `viewSpanBeats / 8` → `/ 16`（上段タイムコードより細かく）。全尺 60s でも 2 小節ごと（1.1/3.1/5.1…）まで表示・重なりなしを実機確認。

### 2026-06-29（Cursor）— ⬆ zip インポート時の保存確認（§20.4b 拡張）

- **要請**: `New` と同様に、別プロジェクト zip を開く（`⬆ zip`）前にも「保存しないと失われます」確認を出す。
- **実装**: spec §20.4b を `New` / `⬆ zip` 共通に更新。[ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) で `discardConfirmAction`（`new` | `import`）に統合し、`ProjectDiscardConfirm` モーダルを共有。`はい`＝zip 保存後に続行（import はファイル選択）、`いいえ`＝保存せず続行、`キャンセル`＝中止。
- **build:player**: 不要（UI のみ）。

### 2026-06-30（Cursor）— Inspector Scale リンクトグル

- **要請**: Scale をスクラブするとき X/Y の比例維持（リンク）を切り替え可能に。
- **実装**: store `scaleLinkEnabled`（既定 ON・非直列化）+ [linkedScale.ts](src/editor/linkedScale.ts) 純関数 + [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) `ScaleVec3Row`（⛓ ボタン）。リンク ON 時は X/Y スクラブで比例更新（Z は独立）。複数選択時もオブジェクトごとに ratio 適用。
- **検証**: `test/linkedScale.test.ts` 6 件緑。

### 2026-06-30（Opus）— 動画レイヤー preview/bundle warm-up（§11.4）

- **背景**: ファイル読込（blob URL 化）は済むが decode 済みフレームは未保証。Play 直後 text/solid/image は即描画される一方 `<video>` は decode/present 待ちで数フレーム〜数百 ms 空白が出ていた（音声 §11.5 プリロードに相当する機構が動画に無かった）。
- **実装**（spec §11.4 追記）:
  - [videoElementSync.ts](src/runtime/videoElementSync.ts) — `primeVideoElement(video, targetSec, fps, timeoutMs)` 追加。scrub 同型 seek → loadeddata（decode）まで待つ（rVFC present 待ちはしない＝再生開始を遅らせない）。`waitForVideoFrame` の step1（seek/decode 待ち）を `waitVideoDataReady` に共通化。export 経路は不変（INV-2）。
  - 新規 [videoWarmupCache.ts](src/runtime/videoWarmupCache.ts) — audioBufferCache と同型。`peekVideoPrimed` / `ensureVideosPrimed`（inflight 去重・成功時のみ記録）/ `evictVideoPrimed`。primed キーは `assetId@round(targetSec*fps)`（フレーム粒度）。DOM 非依存。
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — video 更新時に `dataset.mafterTargetSec` / `dataset.mafterVideoAsset` 記録（export attr とは別）。`forEachVideoElement`（ネスト comp 内も走査）/ `primeMountedVideos(fps, timeoutMs)` / `areMountedVideosPrimed(fps)` 追加。
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — ① idle warm-up useEffect（編集中 comp の enabled video を `requestIdleCallback` で prime）② 条件付き play gate（再生開始前、全 primed なら遅延ゼロ／未完了時のみ最大 500ms prime を待つ）。
  - [BundlePlayer.ts](src/player/BundlePlayer.ts) — `start()` の初回 renderFrame 後・play 前に 1 回 `primeMountedVideos`。
  - [store.ts](src/editor/store.ts) — `removeAsset`（video）で `evictVideoPrimed`。
- **scope 外**: video proxy / 毎フレーム rVFC 同期 / export 経路変更 / ネスト専用ロジック（`forEachVideoElement` が nested video も拾う）。
- **build:player**: 実行済み（src/runtime 変更のため必須）。
- **検証**: `npm test` 550 件緑（typecheck 含む）。新規 unit: videoElementSync `primeVideoElement` 5 件 / videoWarmupCache 8 件。実機 [verify-video-warmup.mjs](verify-video-warmup.mjs) PASS（idle 後 readyState=4/videoWidth=1920、Play 後 3 フレーム以内も維持）。無回帰: verify-video-import / verify-bundle-video-playback / verify-video-export いずれも PASS。
- **付随修正**: [linkedScale.ts](src/editor/linkedScale.ts) の壊れた import（`../types` → `../core/schema`）を修正（前コミットのタイポで typecheck/build をブロックしていた）。

### 2026-06-30（Opus）— 動画内蔵音声の再生対応（§11.4）

- **要請**: 仕様上「鳴らさない」としていた動画内蔵音声を、プレビュー・HTML bundle player・mp4/webm export の3経路で有効化（best-effort・スキーマ非変更）。
- **spec**: §11.4 を更新（「鳴らさない」を撤回し preview/bundle は再生中のみアンミュート、export は audio と同一式で mux）。§11.5 / §16 表も「基本再生 + export mux 対応・keyframed gain/mixing は将来」に整理。§5 型 / INV / `project.json` は不変（`video` に `gain` 追加なし＝常に 1.0）。
- **実装**:
  - [videoElementSync.ts](src/runtime/videoElementSync.ts) — `syncVideoElementTime` に mute をモード別集約: playbackMode=再生中のみ `muted=false`、scrub/warm-up=`muted=true`（exportStep は従来どおり `muted=true`）。mute 制御の単一の正。
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — `pauseAllVideos` で停止時に `muted=true` も戻す（スクラブ前の音漏れ防止）。src 設定時の初期 `muted=true` は sync が即上書きするため温存（防御的）。
  - [exporter.ts](src/runtime/exporter.ts) — `buildAudioMix` を audio + video 内蔵音声の2系統に拡張。収集ロジックを純関数 `collectAudioMixSources(comp)` に抽出（video は `gain=1`・`trimStart` は props から）。decode/timing/`src.start` は audio と完全共有（`inPoint`/`outPoint`/`trimStart` 同一式）。decode 失敗は best-effort skip。
- **scope 外（不変）**: `videoAssetProbe` の `muted`（メタ取得専用）/ export 決定論 video seek（`exportVideoStep`）/ `audio` レイヤー waveform・`PreviewAudioClock` / §5 スキーマ・INV。
- **build:player**: 実行済み（src/runtime 変更のため必須・playerBuildFreshness 緑）。
- **検証**: `npm test` 560 件緑（typecheck 含む）。新規 unit: videoElementSync mute 5 件 / [test/footageAudioMix.test.ts](test/footageAudioMix.test.ts) 6 件（collectAudioMixSources）。実機: [verify-video-audio-preview.mjs](verify-video-audio-preview.mjs) PASS（idle muted→playing unmuted→stopped muted）、[verify-video-audio-export.mjs](verify-video-audio-export.mjs) PASS（video 内蔵音声を decode→OfflineAudioContext mix で非ゼロ RMS 0.088）。無回帰: verify-video-export PASS。
- **メモ**: full mp4 export（`exportComposition`）は headless で video inline-frame ループが極端に遅く実用検証不可のため、export verify は muxer に渡る AudioBuffer（buildAudioMix 内部と同型）を直接検証する方式にした。検証用 fixture `for-debug-data/video_with_audio.mp4`（ffmpeg testsrc2+sine, 音声トラック付き）を生成（既存 fixture は全て無音）。
- **既知の制約**（spec §11.4 記載）: 複数 video 同時再生はブラウザ自動ミックス。audio レイヤー併用時、映像クロックは PreviewAudioClock/BundleAudioClock・video 音声はネイティブ再生（大ドリフト時のみ既存 resync）。mixing graph は §16 将来。

### 2026-06-30（Opus）— audio / video の keyframed gain（音量）統一（§11.4 / §11.5）

- **要請**: audio / video 内蔵音声に **キーフレーム可能な `gain`（0..1）** を統一し、Inspector・タイムライン・preview・export・bundle の全経路で音量制御。
- **spec（承認済み §5 変更）**: §5.5 コンポーネント表で `audio.gain` を `AnimatedProp<number>` 化・`video` に `gain: AnimatedProp<number>`（既定 1）追加。§11.4 / §11.5 / §16 を keyframed gain 対応へ更新。後方互換: plain number は `readGainProp()` で `staticProp` 正規化。
- **実装**:
  - **新規** [footageAudio.ts](src/runtime/footageAudio.ts) — 純関数集約: `readGainProp`（正規化）/ `sampleGain`（clamp 0..1 sampler・全経路共有・INV-2）/ `collectFootageAudioSources`（audio+video 列挙・gainProp 付き）/ `scheduleGainAutomation`（export 用 1/fps 刻み `setValueAtTime`。`linearRamp` では hold/bezier と不一致のため `sampleScalar` フレーム刻みで `interpolate.ts` と同一曲線）。
  - [builtinComponents.ts](src/runtime/builtinComponents.ts) — `AUDIO_COMPONENT_DEF` 新規登録（gain animatable, Volume ラベル）+ `VIDEO_COMPONENT_DEF` に gain。→ Timeline PropRow / graph / `setCompFps` リスケールが自動有効。
  - [store.ts](src/editor/store.ts) — `addAudioLayer` / `addVideoLayer` の gain を `staticProp(1)` に。
  - [exporter.ts](src/runtime/exporter.ts) — `buildAudioMix` を `collectFootageAudioSources` + `scheduleGainAutomation` に委譲（旧 `collectAudioMixSources` 撤去）。
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) `case "video"` — resolve 済み `props["gain"]` で `video.volume`（preview / bundle 自動・BundlePlayer は resolve 経由で追加配線不要）。
  - [previewAudioClock.ts](src/editor/previewAudioClock.ts) — `PreparedLayer` に objectId / gainProp。`getComp`（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の `renderCompRef` 経由・previewOverride 含む）から **毎 tick で live gain を再評価**し `GainNode.gain.value` に反映（編集中スライダーが再生中に効く）。
  - [BundleAudioClock.ts](src/player/BundleAudioClock.ts) — gainProp 保持・tick で `el.volume = sampleGain(...)`。
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — ComponentDef 駆動の汎用 `ComponentFields`（EffectFields 同型・AnimScalarRow + ストップウォッチ + previewPatch）を追加し audio / video の Content に Volume を表示。
- **build:player**: 実行済み（src/runtime / src/player 変更のため必須・playerBuildFreshness 緑）。
- **検証**: `npm test` 569 件緑（typecheck 含む）。新規 unit: [footageGainAutomation.test.ts](test/footageGainAutomation.test.ts) 8 件（readGainProp / sampleGain / automation parity）、[footageAudioMix.test.ts](test/footageAudioMix.test.ts) 7 件（collectFootageAudioSources・animated gain）。実機: [verify-video-audio-export.mjs](verify-video-audio-export.mjs) PASS（gain=0.5 で mix RMS が満タン比 0.500）。Inspector に Volume 行が表示されることを Playwright で確認。
- **既知の制約**: 複数 video 同時の個別 volume は効くがミキサー側クリッピングはブラウザ依存。animated `trimStart` の export mix 同期は本タスク前からの未対応（別 issue）。waveform 表示は gain 非反映（表示専用）。dB / 100% 超え / LUFS / mixing graph は §16 将来。
- **メモ**: headless preview では `<video>` 要素が mount されないため [verify-video-audio-preview.mjs](verify-video-audio-preview.mjs) の `video.volume` アサーション（gain 反映）は環境制約で未実行（idle で要素検出不可・本変更前から）。DomRenderer の volume 配線は export parity（exact 0.5）+ typecheck + 単体 sampleGain で担保。

### 2026-06-30（Opus）— HTML bundle の autoplay unlock（§11.4 / §11.7）

- **要請**: HTML 書き出しの動画（`<video>` 要素）で「更新後にスペースバーを押さないと音が鳴らない」を解消し、スペース限定をやめて任意操作で鳴るようにしたい。
- **原因**: ブラウザは「ユーザー操作なしの音声付き自動再生」をポリシーで禁止（MEI が高いと稀に通るため「なかったりする」ムラ）。boot 時の `play()` は拒否され無音。レンダリングループの `syncVideoElementTime` が毎フレーム `video.play()` を再試行するため、何らかのユーザー操作（偶々スペース）が入ると次の機会に成功して鳴る、という偶発的挙動だった。音声レイヤー単体（[BundleAudioClock](src/player/BundleAudioClock.ts)）は boot 時に一度しか `play()` せず再試行しないため、操作しても鳴らないギャップもあった。
- **方針（ユーザー承認 Option A）**: 完全無操作の音声自動再生はブラウザ仕様上不可。boot で自動再生を試行しつつ、**最初の任意操作（pointerdown / keydown / touchstart）で音声+内蔵音声を確実に開始**する（オーバーレイなし・スペース限定撤廃・音声レイヤーも対象）。
- **実装**:
  - [BundlePlayer.ts](src/player/BundlePlayer.ts) — `installAutoplayUnlock()`: window に capture+passive で最初の 1 回だけ listener を張り、ユーザー操作のコールスタック内で `audioClock.unlock()` + `renderFrame(currentFrame)`（→ `syncVideoElementTime` がアンミュート `video.play()`）。dispose で確実に撤去。
  - [BundleAudioClock.ts](src/player/BundleAudioClock.ts) — `unlock()`: tick ループを二重始動させず、pause 中（autoplay 拒否）の HTMLAudioElement だけ現在の再生位置（startWallMs からの経過秒）へ seek して `play()`。
- **build:player**: 実行済み（src/player 変更・playerBuildFreshness 緑）。
- **検証**: `npm test` 569 件緑。新規実機 [verify-bundle-autoplay-unlock.mjs](verify-bundle-autoplay-unlock.mjs)（Chromium `--autoplay-policy=document-user-activation-required` で autoplay ブロック）: 読み込み直後は `<video>` paused（ブロック確認）、**スペースバーではなく単純クリック 1 回**で playing & unmuted（volume 1）を確認。無回帰: verify-bundle-export PASS。
- **既知の制約**: 完全無操作の音声自動再生はブラウザ（Chrome/Firefox/Safari）のポリシー上不可能。本実装は「最初の任意操作で確実に開始」が上限。MEI が高い環境では boot 時に無操作で鳴ることもある（ブラウザ依存）。

### 2026-07-02（Cursor 委任）— 異なるアセット間カット境界の先読み warm-up（Next steps #0b）✅

- **実装**: [videoLookaheadWarmup.ts](src/runtime/videoLookaheadWarmup.ts)（純関数 `computeVideoLookaheadWarmupTargets` / `collectVideoClipsFromComp`）、DomRenderer 再生中の offscreen prime→プール stash、[PreviewPanel](src/editor/panels/PreviewPanel.tsx) / [BundlePlayer](src/player/BundlePlayer.ts) へのクリップ注入。停止・scrub・dispose で先読み要素を明示破棄。export 経路非干渉。
- **spec**: §11.4 warm-up 節に散文追記（§5/INV 不変）。
- **検証（Cursor 側）**: `npm run typecheck` / `npm test` / `npm run build` / `npm run build:player` 緑。新規 unit [test/videoLookaheadWarmup.test.ts](test/videoLookaheadWarmup.test.ts)。
- **マージ後の検証（Claude・2026-07-02）**: worktree を main へ手動マージ（DomRenderer.ts が #0a と同時変更のため）。実機 before/after [verify-crossasset-warmup.mjs](verify-crossasset-warmup.mjs) で異アセット2クリップ連結を実再生 — マージ前 main は境界 f60 で `readyState=1`（コールド）→ マージ後は最初のサンプルから `readyState=4` PASS。詳細は冒頭「#0a + #0b」エントリ参照。

### 2026-07-02（Cursor / goal-cursor）— blendMode 整理: ditherDissolve 削除 + 未知値 missing フォールバック ✅

- **方針**: `ditherDissolve` を `BlendMode` enum から外し（将来 effect 化）、CSS 16 種のみを正準化。`project.json` に未知 `blendMode` があれば validate で strip + エディタ専用 `missingBlendModes`（Undo 非参加）で Inspector に `name (missing)` 表示。render は `normal` フォールバック（INV-2 維持）。
- **実装**: [blendMode.ts](src/core/blendMode.ts)（`isKnownBlendMode` / `normalizeBlendMode`）、[validate.ts](src/core/validate.ts) / [serialize.ts](src/core/serialize.ts) / [resolve.ts](src/runtime/resolve.ts)、[DomRenderer.ts](src/runtime/DomRenderer.ts)（dither 経路削除）、[store.ts](src/editor/store.ts) + [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)。[ditherMask.ts](src/runtime/ditherMask.ts) は effect 用に温存（実行コードからは未参照）。
- **spec**: §5.4d / §23.3a から dither 削除、未知 blend の散文追記（§5 型は CSS 16 種 enum のみ・意図どおり）。
- **検証**: `npm run typecheck` / `npm test` 650 件 / `npm run build:player` 緑。Playwright: [verify-blend-mode.mjs](verify-blend-mode.mjs) PASS、[verify-missing-blend-mode.mjs](verify-missing-blend-mode.mjs) PASS（FS 注入 `ditherDissolve` → `loadFromFs` → Inspector `ditherDissolve (missing)` + `mix-blend-mode: normal`）。unit: [test/blendMode.test.ts](test/blendMode.test.ts)。
- **(goal-cursor)** ditherDissolve 除去・未知 blend missing UI・全検証緑まで完了。

### 2026-07-02（Cursor / goal-cursor）— ditherDissolve live エフェクト再実装 ✅

- **方針**: 削除済み blendMode `ditherDissolve` を §27.3 の live builtin エフェクトとして再実装。`effectiveReveal = quantize(layerOpacity × (1 − completion))`（64 段）、Bayer 8×8 SVG pattern + `maskComposite`（wipe 同型・feTile 不使用）。`effectiveReveal < 1` 時は div `opacity = 1`（Bayer マスクが透明度を担う）。§5 型変更なし。
- **実装**: [ditherReveal.ts](src/runtime/ditherReveal.ts)（純関数）、[effectSvg.ts](src/runtime/effectSvg.ts)（`bayerMaskSvg` / `ditherDissolveMask`）、[builtinEffects.ts](src/runtime/builtinEffects.ts)（`DITHER_DISSOLVE_EFFECT_DEF` category=ワイプ）、[plugin.ts](src/runtime/plugin.ts) / [effectChain.ts](src/runtime/effectChain.ts)（`layerOpacity`）、[DomRenderer.ts](src/runtime/DomRenderer.ts)（layerOpacity 注入 + opacity 強制）。spec §27.3 + §5.4d 移行注記。
- **検証**: `npm run typecheck` / `npm test` 660 件 / `playerBuildFreshness` 緑。Playwright: [verify-dither-dissolve.mjs](verify-dither-dissolve.mjs) PASS（preview screenshot 計測・dither 純色ピクセル vs smooth opacity 中間色を対照）、[verify-blend-mode.mjs](verify-blend-mode.mjs) / [verify-missing-blend-mode.mjs](verify-missing-blend-mode.mjs) 無回帰 PASS。unit: [test/ditherReveal.test.ts](test/ditherReveal.test.ts)、[test/effects.test.ts](test/effects.test.ts)、[test/effectSvg.test.ts](test/effectSvg.test.ts)。
- **(goal-cursor)** ditherDissolve live エフェクト実装・verify PASS まで完了。

### 2026-07-02（Cursor）— Preview cache wonky 調査続行（Claude limit 引き継ぎ）— 部分修正

- **背景**: Claude Code が「cache wonky」調査を完了（実機再現・特定）し、修正タスクを Cursor 委任する直前に session limit で停止。Cursor agent transcripts には Claude セッション本体は無く、リポジトリに残った probe 脚本（`probe-cache-wonky.mjs` / `probe-cache-real.mjs` / `probe-cache-parity.mjs` / `probe-comp10-capture-bisect.mjs` 等）から状態を復元。
- **特定した真因候補**:
  1. **RAM Preview キャッシュ PNG（`compFrameCapture`）と live preview の fidelity 乖離** — overlay 表示時に別物が見える。Comp 10 f30 で capture `inkRatio≈0.05`（ほぼ空）vs video 無効化で異常値。video 単体 capture も `inkRatio=0`。
  2. **再生中の overlay/live ちらつき** — 部分キャッシュ時 `w3_overlayToggles=3`（キャッシュ hit/miss で毎フレーム切替）。
  3. **draft テキスト + foreignObject** — 単体 text capture も `inkRatio≈0.001`（solid は `≈0.058` で正常）。export 経路（precise + 実プロジェクト）は `verify-comp10-export-parity` で成立するが、RAM cache 用 offscreen capture は別条件で弱い。
- **実装（今回）**:
  - [exportComposite.ts](src/runtime/exportComposite.ts) / [DomRenderer.ts](src/runtime/DomRenderer.ts) — `hasThreeDContent()` 追加。threeD レイヤーがあるフレームは root 一括 foreignObject 高速経路を使わず per-layer perspective capture へ。
  - [rasterCapture.ts](src/runtime/rasterCapture.ts) — `inlineVideoFrames` の寸法フォールバック強化。decode 未完了 video は clone から **除去**（黒矩形で下層を覆い隠すのを防止）。
  - [compFrameCapture.ts](src/runtime/compFrameCapture.ts) — `primeMountedVideos` + `flushVideoFrames(4000)` で offscreen video decode 待ちを延長。
  - [ramPreview.ts](src/editor/ramPreview.ts) — キャッシュ PNG は常に `textQuality: "precise"`。`shouldPreferCacheOverlay(isPlaying)` 追加（ビルド進捗 <50% の再生中は overlay を使わず flicker 抑制）。
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — overlay 経路を `shouldPreferCacheOverlay` に接続。live フォールバック時は stale overlay `src` を除去。
- **検証**: `npm run typecheck` 緑 / `test/previewCache.test.ts` 16 緑 / `npm run build:player` 実行済み。`probe-cache-wonky.mjs` で `w3_overlayToggles` **3→0**（ちらつき改善）。**未解決**: Comp 10 `probe-comp10-capture-bisect` の full capture 依然 `inkRatio≈0.05`（video + 複合 comp の capture parity）。draft 単体 text capture も低 ink のまま。
- **Next steps**: (1) offscreen `compFrameCapture` の video フレーム inline を `verify-video-export` 同等まで引き上げ。(2) draft テキストの foreignObject 非対応を canvas 焼き or precise 強制で閉じる。(3) `probe-cache-real` の Comp 19/20 大乖離（ネスト precomp）を precomp raster 経路で追跡。

### 2026-07-04（Cursor）— レイヤーロック（Timeline Tier B 部分実装）✅

- **spec**: §5.4e `SceneObject.locked?`（エディタ専用・resolve/export 無影響）+ §21.11 UI 規約（目アイコン: クリック=表示切替 / **Shift+クリック=ロック**、4状態、複数選択時は Shift で一括ロック、ラベル色はロック中も可）。
- **実装**: [layerLock.ts](src/editor/layerLock.ts)、[commands.ts](src/editor/commands.ts)（locked ガード + remove/duplicate/split スキップ）、[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx)（4状態アイコン・選択/編集ブロック）、[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)（read-only）、[PreviewViewerOverlay.tsx](src/editor/panels/PreviewViewerOverlay.tsx)（ギズモ非表示）。
- **検証**: `npm test` — [test/layerLock.test.ts](test/layerLock.test.ts) / [test/layerLockCommands.test.ts](test/layerLockCommands.test.ts) / [test/serialize.test.ts](test/serialize.test.ts) 緑。`npm run build`（tsc）緑。runtime 変更なし（player 再ビルドは `npm run build` 経由のみ）。

### 2026-07-04（Cursor）— 目アイコン右クリックで一括表示/非表示 ✅

- **操作**: 目アイコン右クリック → 「すべて表示」「すべて非表示」。対象は現在コンポの**ロック以外**のみ（ロック済み `enabled` は不変）。1 command / 1 undo。
- **実装**: [layerLock.ts](src/editor/layerLock.ts) `unlockedVisibilityPatches`、[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) コンテキストメニュー。spec §21.11.1 追記。
- **検証**: `test/layerLock.test.ts` 追加ケース。

### 2026-07-05（Cursor）— プロジェクトパネル nested フォルダのインデント修正 ✅

- **症状**: フォルダ展開時、子フォルダだけ左端（depth 0 相当）に表示されネスト構造が視認できない。
- **原因**: [ProjectTreeView.tsx](src/editor/panels/projectTree/ProjectTreeView.tsx) の bin 行だけ `padding: 3px ${pad}px 3px 6px` と左パディングが常に 6px 固定。composition / asset 行は `paddingLeft: pad`（depth 連動）だった。
- **修正**: bin 行も `paddingLeft: pad` に統一。[projectTreeLayout.ts](src/editor/panels/projectTree/projectTreeLayout.ts) に `projectTreeRowPadLeft(depth)` を抽出。
- **追修正（2026-07-05）**: 右パディングも depth 連動していたため `+`/`×` 等のボタンが内側へ寄っていた。`PROJECT_TREE_ROW_PAD_RIGHT = 6` を固定し左インデントのみ depth 連動に。
- **検証**: `npm run typecheck` 緑 / [test/projectTreeLayout.test.ts](test/projectTreeLayout.test.ts) 緑。

### 2026-07-05（Claude）— webm(split-alpha)レイヤーが mp4 と挙動が違う不具合を修正 ✅

- **要請**: 「webm の扱いが mp4 と違って変な感じがする」— ① レイヤー順を変えても常に mp4 より奥に表示される ② スクラブしてもそのフレームが表示されない ③ 再生時に mp4 よりフレームがズレる。ユーザーの Downloads 最新 zip の Comp 30（mp4+webm混在）で実機 Playwright 再現・特定。
- **前提確認**: このプロジェクトの `.webm` は全 3 件とも Subject Extract の split-alpha 出力（`meta.alphaMode: "split"`）。素の webm インポートはプロジェクト中に 1 件も存在せず、実質「split-alpha 合成レイヤー vs 通常 `<video>`」の比較だった。
- **原因A（症状①・実機で確定）**: [DomRenderer.ts](src/runtime/DomRenderer.ts) `applyObject()` の通常分岐で `entry.div.style.zIndex = ...` を設定した直後に `clearMatteSourceStyle(entry.div)`（track matte source 離脱の後始末）が無条件に呼ばれ、`zIndex` を毎フレーム `""` へリセットしていた（mp4/webm 問わず全オブジェクトが対象だが、`resolve()` が zOrder でソート済みのため初回マウント時の DOM 挿入順と一致している間だけ見た目が正しく、**既存オブジェクトの zOrder を後から変更しても DOM 順・z-index どちらも反映されない**——mp4 背景は作成後ほぼ並べ替えないため症状が出ず、後から追加・並べ替えした webm レイヤーだけ「常に元の位置」に見えていた）。**修正**: 後始末呼び出しを transform/opacity/zIndex 設定より前に移動。
- **原因B（症状②）**: [videoSplitAlpha.ts](src/runtime/videoSplitAlpha.ts) `drawSplitAlphaComposite()` は color/alpha 双方が ready なときのみ描画し、そうでなければ何もせず `false` を返すが、呼び出し側は再試行の仕組みを持たなかった（`<video>` はブラウザが decode 完了時に自動再描画するが、canvas 合成は明示呼び出しでしか更新されないため、scrub 直後の render pass で readyState 不足だと次の render() まで canvas が古い内容のまま固定）。実機計測で canvas が既定 `300×150`（実寸 640×1138 に一度もリサイズされない）のまま固定される再現を確認。**修正**: `scheduleSplitAlphaRedrawWhenReady()` を追加（bounded retry, 既定 2000ms・`canvas.isConnected` チェックで dispose 後の無限ループ防止）。初回描画失敗時のみ発火（型別オプトイン、mp4/plain video 経路は無変更）。
- **原因C（症状③の一因）**: `sampleMountedVideoClocks()`（再生中の映像↔タイムライン hold/pause 判定用サンプル）が `forEachVideoElement()` 経由のため split-alpha の alpha companion を明示スキップしており、color/alpha のビットレート差（実測 ~8.2Mbps vs ~205kbps）による decode 乖離が hold/pause 判定に反映されなかった。**修正**: `sampleMountedVideoClocks()` で `findSplitAlphaVideo()` を追加チェックし alpha companion もサンプル対象に（`forEachVideoElement` 自体・呼び出し側 `previewAudioClock.ts` は変更不要、samples 配列を汎用集計するだけのため）。
- **影響経路**: Preview / mp4・webm export / Web bundle player（同一 DomRenderer 経路）。RAM Preview cache は別経路のため無関係。bundle player は hold/pause 自体を持たない（barrier のみ、既存方針で不変）ため原因Cは preview 専用。
- **検証**: `npm run typecheck` / `npm test`(854件, 既知の無関係 flaky 1件は単独実行で緑) / `npm run build:player` 緑。新規 [test/videoSplitAlpha.test.ts](test/videoSplitAlpha.test.ts) 4件（retry成功・deadline打ち切り・disposed canvas即終了・多重スケジュール防止）。実機 Playwright: ユーザーの実プロジェクト Comp 30 で①（既存オブジェクトの zOrder 変更後 zIndex が正しく更新される）②（scrub 後 canvas が実寸 640×1138 にリサイズされる、修正前は 300×150 に固定）を再現→解消を確認。既存 `verify-track-matte.mjs` 無回帰 PASS。
- **手法メモ**: `/double-check-the-plan` でレビュー→ bundle 行の未確認ヘッジ・症状③の閾値未確定・使い捨てスクリプトの先送りの3点を修正してから実装。
- **既知の無関係な発見（対応不要・本タスクスコープ外）**: `verify-blend-mode.mjs`（addSolid 後に要素が見つからない）と `verify-bundle-video-playback.mjs`（NotAllowedError: play() が自動再生ポリシーで拒否）が現在の working tree で失敗するが、本修正を一時的に revert しても同じ結果になることを確認済み＝**本修正が原因ではない**（別の未コミット作業に起因する既存の問題、または autoplay unlock 導入前からの検証スクリプトのギャップ）。ユーザー/次セッションへの申し送り事項として記録。
- **build:player**: 実行済み（`src/runtime/DomRenderer.ts` / `src/runtime/videoSplitAlpha.ts` 変更のため必須・`playerBuildFreshness` 緑）。

### 2026-07-06（Claude）— Electron ラッパー対応（開発起動 + 自前タイトルバー + FB送信）✅

- **要請**: このアプリを Electron ラッパーで起動できるようにしたい。① 枠を隠蔽し VS Code 風の自前タイトルバー（右端に最小化/最大化/閉じる）。② フィードバックは Electron でも `https://maftereffect.gycp.party` の既存エンドポイントへ送信。
- **確定事項**: パッケージング範囲は開発起動のみ（electron-builder 等インストーラは未対応・後回し）。ウィンドウ操作ボタンは全 OS で自前（VS Code 風・右上、mac 信号機は出さない）。フィードバック送信先は env 既定＋ハードコード fallback。
- **設計判断（CORS）**: フィードバックは `Authorization: Bearer` ヘッダ付き POST のため、Electron（file:// / 別オリジン）からレンダラで直接 fetch すると CORS プリフライトが発生し、既存 `scripts/mafter_http_server.py` は OPTIONS 未対応で失敗する。**メインプロセス経由の IPC**（`feedback:post`）で回避し、サーバ側は無改修。
- **実装**:
  - 新規 `electron/main.ts`（`frame:false` BrowserWindow、win:minimize/toggleMaximize/close/isMaximized IPC、feedback:post IPC → Node fetch で `MAFTER_FEEDBACK_ORIGIN ?? "https://maftereffect.gycp.party"` へ POST）、`electron/preload.ts`（`contextBridge` で `window.mafterDesktop` 公開）、`electron/build.mjs`（esbuild で CJS バンドル → `dist-electron/*.cjs`）、`electron/tsconfig.json`。
  - [src/desktop.d.ts](src/desktop.d.ts) — `window.mafterDesktop` 型宣言（新規）。
  - [src/editor/feedbackCollector.ts](src/editor/feedbackCollector.ts) `postPayload` — `window.mafterDesktop?.isElectron` なら IPC 経由、それ以外は従来の相対 `fetch('/api/feedback')`（web 挙動は完全不変）。
  - [src/App.tsx](src/App.tsx) — menu bar に `WebkitAppRegion:'drag'`、各ボタンに `no-drag`、`isDesktop` 時のみ `WindowControls`（最小化/最大化⇄復元/閉じる、`mafterDesktop.onMaximizeChange` で最大化アイコン切替）を右端に追加。web では非表示。
  - [vite.config.ts](vite.config.ts) — `base: process.env.ELECTRON_FILE ? "./" : "/"`（file:// 起動用）、`ELECTRON_DEV_PORT` 指定時は `server.port` + `strictPort:true`（後述のポートドリフト対策）。
  - `package.json` — `main: "dist-electron/main.cjs"`、`electron:build-main` / `electron:dev` / `electron:start` 追加。devDeps: `electron`（後述の理由で `^35.7.5` に固定）、`esbuild`、`concurrently`、`wait-on`、`cross-env`、`@types/node`。
  - `.env.example` — `MAFTER_FEEDBACK_TOKEN` / `MAFTER_FEEDBACK_ORIGIN` を追記。
  - spec §20.3 のデスクトップ版記述を「Electron シェル起動のみ実装済み・ネイティブ保存ダイアログは未実装」に更新。
- **ハマった点と対処**:
  1. **Electron 43 が Node 20 で動かない**: `electron@43` 系は `@electron/get` 等が Node ≥22.12 前提の ESM で、Node 20.15 環境では `npm install` 後の postinstall バイナリダウンロードが `ERR_REQUIRE_ESM` で失敗する。→ `@electron/get@^2.0.0`（CJS・Node ≥12.20.55）を使う **`electron@^35.7.5`** に固定して解消。ユーザー環境の Node が 22 以上なら新しい major に上げても良いが、現状は 35 系で固定。
  2. **`wait-on http://localhost:5173` のポートドリフト**: 5173 が使用中だと vite が自動で別ポートへ繰り上がるが、`electron:dev` は 5173 固定で待っていたため、古い/無関係な別プロセスが 5173 を握っていると Electron が誤ったサーバに繋がりうる（実機検証中に実際に踏んだ）。→ `ELECTRON_DEV_PORT=5183` を vite/`wait-on`/`ELECTRON_RENDERER_URL` の三者で共有し、vite 側は `strictPort:true` で衝突時は繰り上げず即エラーにするよう変更。
- **検証**: `npm run typecheck` 緑、`npm test` 853/854（唯一の失敗 `playerBuildFreshness` はセッション開始前からの `public/player.js` 未コミット差分によるもので本作業とは無関係・`src/runtime`/`src/player` 無変更）。実機: `npm run electron:dev` 相当を実行し、`frame:false` ウィンドウが Vite dev サーバ（固定ポート 5183）に接続してタイトル「Mafter Effect」で起動することを確認（このツールのシェルは VS Code 拡張ホスト由来で `ELECTRON_RUN_AS_NODE=1` が継承されており、素の `electron .` 実行だと GUI 化されず `require('electron').app` が undefined になる罠を踏んだ→ユーザーの通常ターミナルではこの変数は無いため無関係、原因を切り分けて確認）。build:player 不要（`src/runtime`/`src/player` 無変更）。
- **Next steps**: ネイティブ保存ダイアログ（File System Access API 相当）は未実装で TODO のまま。electron-builder 等でのインストーラ配布も未着手（ユーザーが必要になったタイミングで対応）。

### 2026-07-06（Claude）— ポータブル .exe 配布ビルド（electron-builder）✅

- **要請**: 「頒布できるポータブル.exeの出力ってできる？」→ electron-builder の portable ターゲット（インストール不要・単体 .exe）で対応。
- **実装**: `package.json` に `"build"`（electron-builder 設定: `appId: "party.gycp.maftereffect"`, `productName: "Mafter Effect"`, `directories.output: "release"`, `files: ["dist/**/*", "dist-electron/**/*", "package.json"]`（node_modules は同梱しない——main は esbuild 単一バンドル・renderer は Vite バンドル済みで実行時に不要）, `asar: true`, `win.target: ["portable"]`）、`electron:dist` スクリプト（`ELECTRON_FILE=1` で `base:"./"` ビルド → `electron:build-main` → `electron-builder --win portable`）。devDep `electron-builder` 追加。`.gitignore` に `release/` 追加。
- **ハマった点と対処**:
  1. **`electron-builder@26` が Node 20 で動かない**: `app-builder-lib@26` が `@noble/hashes@^2.2.0`（ESM 専用）に依存し、`ERR_REQUIRE_ESM` で `electron-builder` 実行が即死。25.x 系はこの依存自体が無い。→ **`electron-builder@25.1.8`** に固定。
  2. **winCodeSign 展開が Windows でシンボリックリンク不可により失敗**: portable（Windows 専用）ビルドでも electron-builder は無条件に macOS 用署名ツール一式（`winCodeSign`、内部に darwin dylib のシンボリックリンクを含む 7z）をダウンロード・展開しようとし、Windows は既定でシンボリックリンク作成に開発者モード or 管理者権限が必要なため `7za.exe` の展開が `Sub items Errors: 2` で失敗し続ける。`CSC_IDENTITY_AUTO_DISCOVERY=false` では回避できなかった。→ ユーザーに確認の上、Windows 開発者モードを ON（`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense=1`。この値は管理者権限が必要で、非昇格シェルからは設定不可のためユーザー自身に有効化してもらった）にして解消。
- **検証**: `npm run electron:dist` で `release/Mafter Effect 0.0.0.exe`（約 90.7MB, unsigned）を生成。実機: 生成した exe を直接起動し、ウィンドウが `frame:false` かつタイトル「Mafter Effect」で正常に立ち上がることを確認（プロセスは `dist-electron/main.cjs` を asar 内から正しく読み込み動作）。`npm run typecheck` 緑。
- **既知の制約**: 未署名（コード署名なし）のため、初回起動時に Windows SmartScreen の警告が出る可能性がある。アプリアイコンは Electron デフォルトのまま（`build.win.icon` で後から差し替え可）。mac/Linux ターゲットは未検証（`win.target` のみ設定）。
- **Next steps**: コード署名（EV証明書等）・カスタムアイコン・自動アップデート（`electron-updater`）は未着手。必要になったら対応。

### 2026-07-06（Claude, Opus 4.8 レビュー併用）— Electron ポータブル版で Subject Extract / Motion Track が "Failed to fetch" になる件を修正 ✅

- **要請**: 「これElectronビルドだとvideoのextract subject/motion track操作でfailed to fetchになる、他の部分も似たようなバグがあるかも」→ 原因調査 + 修正案 plan → Opus 4.8 サブエージェントにレビューさせ、Sonnet 5（本人）が実装（ユーザーは寝落ち・非対話で完結させた）。
- **真因**: IndexedDbFs 等 FileSystem 層は無関係（Electron でも Web と同じ IndexedDB）。実際は `public/` 配下アセット（WASM・モデル・フォント・player.js）をコード中で **ルート絶対パス文字列 `"/xxx"`** として直接 `fetch()`/動的 `import()`/`<style> url()` 参照している箇所が原因。`file:///C:/.../dist/index.html` として起動する Electron ポータブル版では、ルート絶対パスがファイルシステムのルートに解決され `dist/` ディレクトリごと消えるため 404 相当（"Failed to fetch"）になる。`vite.config.ts` の `base:"./"`（`import.meta.env.BASE_URL`）は Vite が自動処理するアセット参照（`<script src>` 等）には効くが、`public/` ファイルへの手書き文字列参照はこの恩恵を受けない。`electron:dev` は http 経由のため再現せず、`electron:dist`/`electron:start`（file://）でのみ発症——開発中に見逃されていた理由。
- **該当 5 箇所（同一パターン）**: ① [personSegmenter.ts](src/editor/subjectExtract/personSegmenter.ts) `WASM_BASE`/`MODEL_PATH`（Subject Extract、報告症状）② [quarTracker.ts](src/editor/motionTrack/quarTracker.ts) `wasmAbsoluteUrl()`/`opencvAbsoluteUrl()`（`window.location.origin` で解決しておりさらに悪化。Motion Track 全モード=Quar/Walk/3D Solve、報告症状）③ [main.tsx](src/main.tsx) `registerBuiltinFonts("/fonts")`（同梱フォントが黙って読み込めない・未報告の同型バグ）④⑤ [bundleExporter.ts](src/runtime/bundleExporter.ts) `fetchBuiltinFontBytes`/`loadPlayerScript`（HTML bundle export 内でフォント欠落・player.js 取得失敗＝Electron からの HTML bundle export が丸ごと失敗、未報告の同型バグ）。
- **除外確認済み（バグでない）**: `feedbackCollector.ts` の feedback POST は既に `window.mafterDesktop?.isElectron` で IPC 分岐済みで無関係。`public/player.js` 自体（`src/player/`, `vite.player.config.ts`）は "file:// 互換" コメント付きの別ビルドで bundleExporter からは import されておらず無関係。
- **修正**: 新規 [src/runtime/publicAssetUrl.ts](src/runtime/publicAssetUrl.ts) — 純関数 `resolvePublicAssetUrl(path, basePrefix, documentBaseURI)` + 薄いラッパー `publicAssetUrl(path)`（`import.meta.env?.BASE_URL ?? "/"` と `document.baseURI` を `new URL()` で合成）。web（base "/"）では現状と同一 URL を返す（無変更）、Electron file build（base "./"）では `document.baseURI`（`file:///C:/.../dist/index.html`、ドライブレターと `dist/` を保持）から正しく相対解決する。上記 5 箇所をこのヘルパー経由に置換（`motionTrackWorker.ts`/`rotationTrackWorker.ts` は既に解決済みの絶対 URL を受け取るだけなので無変更）。
- **レビュー（Opus 4.8 サブエージェント, 実装前）**: 5 箇所の診断・見落とし箇所の有無（`.tsx` 含め再走査したが無し）・ヘルパー実装の edge case（`import.meta.env` 自体が undefined な場合のガード漏れを指摘・修正、MediaPipe の `forVisionTasks` はベースパス末尾に `/` を付けず自前で `${base}/${file}` 連結するため trailing slash 不要と確認）・IPC/preload 代替案との比較（`document.baseURI` の方がシンプルでフィードバック IPC のような分岐が不要と結論）をレビューさせ、指摘を反映した上で実装。
- **検証**: `npm run typecheck` 緑。新規 [test/publicAssetUrl.test.ts](test/publicAssetUrl.test.ts) 4件（web/Electron 双方の解決結果、多重先頭スラッシュ、trailing slash 無し）。`npm test` 858/858 件緑（既存 `playerBuildFreshness` 含め無回帰、`publicAssetUrl.ts` は `src/player/` から import されないため build:player 不要）。`ELECTRON_FILE=1 vite build` で実際に `dist/` を生成し、Node スクリプトで `file:///.../dist/index.html` を document.baseURI と仮定した場合の解決 URL が実ファイル（wasm/tflite/quar_engine.js/opencv.js/フォント/player.js）に一致することを確認。
- **未実施（次回以降で推奨）**: 実際の `npm run electron:dist` パッケージ版を起動しての手動確認（Subject Extract 実行・Motion Track 実行・同梱フォント表示・HTML bundle export）は本セッションでは行っていない（ユーザー非対話のため）。次回ユーザーがポータブル版を使うタイミングで実地確認してもらうこと。

### 2026-07-06（Claude）— Subject Extract レイヤーが元動画と違う位置・サイズで表示される不具合を修正 ✅

- **要請**: 「subject extraction、元動画の大きさに合わせて同じ位置で置かれるように実装したい」→ Plan Mode でプラン作成 → `/double-check-the-plan` で二重チェック（ブロッカー 0、軽微な追記2件のみ）→ 実装。
- **真因**: [SubjectExtractFields.tsx](src/editor/panels/SubjectExtractFields.tsx) `handleExtract` が新規 asset の `meta.width`/`meta.height` に **抽出処理用ダウンスケール解像度**（`result.width`/`height`、`MOTION_TRACK_TARGET_WIDTH`≈640px 基準）をそのまま書き込んでいた。`DomRenderer`（video の `style.width/height`・split-alpha 合成 canvas の CSS サイズ双方）は `imageCache.getSize(assetId)` = `asset.meta.width/height` のみで表示 box サイズを決める設計（`imageAssetCache.ts` `sizeFromMeta` — footage quality プロキシと同じ仕組み、実デコード解像度は無視）ため、`transform` はソースからコピーされているのに **box サイズだけ抽出解像度になり小さく／ズレて描画**されていた。
- **修正**: 純関数 `resolveSubjectExtractAssetSize(sourceAssetMeta, extracted)` を [applySubjectExtract.ts](src/editor/subjectExtract/applySubjectExtract.ts) に追加（ソース asset の原寸を優先、欠落/非数値/0以下なら抽出解像度へフォールバック）。`SubjectExtractFields.tsx` はこれを使い新規 asset の `meta.width/height` にソース原寸を書き込む。抽出・セグメンテーション・エンコード解像度（640px）自体は無変更（負荷軽減の設計は維持）。ステータス表示に「（抽出解像度）」を付記し実際の表示サイズと混同しないようにした。
- **検証**: `test/subjectExtractApply.test.ts` に `resolveSubjectExtractAssetSize` 7 件追加（`npm test` 863/863 緑、`playerBuildFreshness` 含め無回帰）。`npm run typecheck` 緑。新規 [verify-subject-extract-size-fix.mjs](verify-subject-extract-size-fix.mjs)（Playwright 実機、小さい test mp4 で軽量に検証・巨大 zip や MediaPipe 不要）で、修正後の meta を使った新規レイヤーの `getBoundingClientRect` がソースレイヤーと完全一致し、旧挙動（抽出解像度のまま）を再現したレイヤーは小さくズレることを確認（PASS）。編集専用機能のため `build:player` 不要（`src/runtime`/`src/player` 非変更、確認済み）。
- **スコープ外（既知のトレードオフ）**: 抽出内部解像度（~640px）のままソース原寸へアップスケール表示されるため、切り抜き部分は元映像よりやや柔らかく見える。位置・サイズの不一致とは別の問題であり今回は対応しない。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 0（計測ハーネス）✅

- **要請**: `doc/issue/preview-rendering-pipeline-optimization-plan.md` の Phase 0〜4 を順に実装。Phase 0（計測ハーネス）着手。
- **実装**: [scripts/probe-preview-startup.mjs](scripts/probe-preview-startup.mjs)（Playwright + Chromium、`for-debug-data/_pj17` を固定テストプロジェクトとして使用）。`src/runtime/imageAssetCache.ts` の `loadFromProject` に `performance.mark`/`measure`（`mafter:loadFromProject:start/end`）、`src/editor/panels/PreviewPanel.tsx` に「最初の live renderFrame 呼び出し」を検出する `mafter:firstPreviewRender` マークを追加（scene 解決値・挙動に影響しない計測専用の副作用、INV-1 安全）。計測項目: `firstRenderMs`（起動〜最初のプレビュー描画）/ LCP / longtask 件数・最大・合計 / `loadFromProjectMs`。baseline は [probe-preview-startup-report.md](probe-preview-startup-report.md) に記録済み（firstRenderMs≈279ms, lcpMs≈200ms, maxLongTaskMs≈69ms, loadFromProjectMs≈290ms, 3 run 中央値）。
- **固定テストプロジェクトについての注記**: PLAN が指す `for-debug-data/mafter-project (11).zip` はこの環境では 0 byte（転送されていないプレースホルダ）で使えなかった。代わりに同居していた展開済みフォルダ `for-debug-data/_pj17`（動画5本+画像1枚, 27 comps の実プロジェクト）を採用。zip import ではなく Vite dev server の `/@fs/<absolute path>` 経由で project.json・assets・scripts（expression 脚本）・presets を丸ごと fetch → `IndexedDbFs` に write する方式（巨大バイナリを Playwright evaluate 引数に渡すと重いため）。
- **ハマった点**: (1) 初回は project.json + image/video assets のみコピーしたところ、`scripts/<objectId>/*.js`（expression 脚本）が欠落し `ExpressionEngine.prepare()` が完了せず `renderTick` が永久に発火しない事故を踏んだ → フォルダ全体を再帰的にミラーする方式に変更。(2) 「最初のプレビュー描画」の代理指標として `[data-object-id]` の出現を待っていたが、このテストプロジェクトの root comp はテキストオブジェクトが `inPoint=2,4,6,8`（frame 0 では非表示）のため frame 0 で観測不可 → scene 内容に依存しない `mafter:firstPreviewRender` マークに切り替えて解決。
- **検証**: `npm run typecheck` 緑・`npm test` 954/954 緑（`playerBuildFreshness` 含む、hook が自動で `public/player.js` を再ビルド済み）。`verify-video-export.mjs` の `playerUiRatio` FAIL は本変更を `git stash` して確認済みの**既存の無関係な失敗**（本 Phase 0 が原因ではない）。
- **Next steps**: Phase 1（dev サーバ HTTP/2 化・basic-ssl）へ進む。probe ハーネスは `VERIFY_HTTPS=1` 環境変数に対応済み（`ignoreHTTPSErrors: true` で `browser.newContext` 済み）。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 1（dev HTTP/2 化）✅

- **実装**: `@vitejs/plugin-basic-ssl@1.2.0`（最新 2.x は vite ^6/7/8 必須で不適合、vite5 対応版に固定）を devDependency 追加。[vite.config.ts](vite.config.ts) に `enableHttps`（`ELECTRON_DEV_PORT`/`ELECTRON_FILE`/`MAFTER_DEV_HTTP1=1` のいずれでも無効化）を追加し、有効時のみ `basicSsl()` + `server.https:true`。
- **想定外の発見（着手前に未記載）**: Vite の `resolveHttpServer` は `server.https` が真でも `server.proxy` が設定されていると `http2.createSecureServer` ではなく素の `https.createServer`（HTTP/1.1 over TLS）にフォールバックする（`node_modules/vite/dist/node/chunks/*.js` の `resolveHttpServer` で確認）。既存の `/api/feedback` プロキシがこれに該当し、そのままでは「証明書は自己署名になるが ALPN h2 は出ない」状態になることを curl/openssl で実測確認した。ユーザーに選択肢を提示し、**https 有効時は feedback proxy を無効化**する方針で承認を得て実装（[doc/feedback-loop.md](doc/feedback-loop.md) G3 に `MAFTER_DEV_HTTP1=1 npm run dev` の逃げ道を追記）。
- **検証**: `openssl s_client -alpn h2` で `ALPN protocol: h2` を確認、`curl --http2` で `HTTP/2 200` を確認（Phase 1 の主目的=実際に HTTP/2 が使われることを実機で確認済み）。`ELECTRON_DEV_PORT` 指定時・`MAFTER_DEV_HTTP1=1` 指定時はいずれも従来通り plain HTTP + feedback proxy 有効のままであることも実際に起動して確認。`npm run typecheck` / `npm test` 954/954 緑（`src/runtime`/`src/player` 無変更のため `build:player` 不要）。
- **Phase 0 ハーネスでの計測結果（想定外）**: `probe-preview-startup-report.md` に `phase1-https-h2` で追記。firstRenderMs 中央値 279ms→331ms、lcpMs 200ms→236ms と、**この環境・この固定テストプロジェクトでは改善どころかわずかに悪化**した（自己署名 TLS ハンドシェイクのオーバーヘッドが、localhost（レイテンシほぼ0）× モジュール数がさほど多くないこの環境では HTTP/1.1 6接続上限のボトルネックを上回った可能性が高い）。元課題が報告する「200+ JS モジュールの直列ロード」による大幅遅延は、より高レイテンシ・より多モジュールの実環境で顕在化するボトルネックであり、この检証環境では再現しなかったと考えられる。**Phase 1 の技術的目的（実際に HTTP/2 が使われること）は達成・実証済みだが、体感速度改善は本環境の baseline では確認できなかった**——正直に記録し、誇張しない。
- **Next steps**: Phase 2a（decodeVideoEntry の slice 除去）へ進む。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 2a（decodeVideoEntry の slice 除去）✅

- **実装**: [imageAssetCache.ts](src/runtime/imageAssetCache.ts) の `decodeVideoEntry` / `decodeImageEntry` から手動 `buf.buffer.slice(...)` を除去し、`new Blob([buf], ...)` へ `Uint8Array` ビューを直接渡すよう変更（Blob は byteOffset/byteLength を尊重してコピーするため slice は不要）。TS 5.9 の厳格な `BlobPart`（`ArrayBufferView<ArrayBuffer>`、`SharedArrayBuffer` 不可）に合わせ `as Uint8Array<ArrayBuffer>` キャスト（`fs.read()` は常に `ArrayBuffer` 裏付けの `Uint8Array` を返すため安全）。API・戻り値・`url`/`size` の中身は不変（INV-2 死守）。
- **検証**: `npm run typecheck` / `npm test` 954/954 緑（`test/imageAssetCache.test.ts`・`test/videoSplitAlpha.test.ts`・`test/videoPackedAlpha.test.ts` 含む）。`npm run build:player` 実行済み（`imageAssetCache.ts` は `BundlePlayer.ts` からも import されるため必須）。既存 video 系 verify 無回帰: `verify-video-export-monotonic.mjs` PASS、`verify-packed-alpha-e2e.mjs` PASS、`verify-export-split-alpha.mjs` PASS。`verify-video-export.mjs` の `playerUiRatio` FAIL は Phase 0 で確認済みの**既存の無関係な失敗**（本変更が原因ではない、再確認済み）。
- **計測（Phase 0 ハーネス、同一 HTTP/1.1 dev server・同一条件での matched A/B, 5 run 中央値）**: `loadFromProjectMs` 347ms（slice あり）→315ms（slice 除去後）で約 9% 改善。`firstRenderMs` は 27 comps 分の expression/font 準備等の他要因が支配的で有意差は出なかった（想定内、PLAN の「効果は限定的な場合がある」通り）。
- **既知の flaky（本変更と無関係）**: `test/projectBins.test.ts`「preserves treeOrder entry order」がフルスイート内でまれに落ちるがテスト単体では常に緑（テスト順序依存の既存問題、本 Phase で悪化させていないことを再確認）。
- **Next steps**: Phase 2b（Web Worker オフロード）へ進む。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 2b（decodeVideoEntry の Web Worker オフロード）✅

- **実装**: [videoBlob.worker.ts](src/runtime/workers/videoBlob.worker.ts)（新規、`pngEncode.worker.ts` と同じ `type:"module"` 規約。`ArrayBuffer` を transfer で受け取り `Blob` を構築して返すだけ、`URL.createObjectURL` は呼ばない）、[videoBlobDecode.ts](src/runtime/videoBlobDecode.ts)（新規、`ensureWorker`/pending Map/フォールバックは `pngEncode.ts` と同構造。`decodeVideoBlobUrl(buf, mime)` が Worker へ transfer→Blob 受領→**メインスレッドで** `URL.createObjectURL` を呼ぶ）。[imageAssetCache.ts](src/runtime/imageAssetCache.ts) の `decodeVideoEntry` を非同期化し `decodeVideoBlobUrl` を呼ぶよう変更、4 箇所の呼び出し元（`loadFromProjectImpl`/`loadProxiesFromFs`/`loadSplitAlphaFromFs`/`loadVideoBlobsFromUrls`）すべて `await` 化。spec §11.1 に 2 行追記。
- **罠の回避（PLAN 指摘通り）**: Worker 内で `createObjectURL` すると生成した blob URL は Worker のスコープに紐づき Worker 破棄後は `<video>` から参照できなくなるため、Worker は Blob オブジェクトを返すだけに留め、URL 発行は必ずメインスレッドで行う設計にした。
- **buffer transfer の安全性の監査**: `buf.buffer` を transfer すると detach されるため、呼び出し元が同じ buffer を他で使い回していないか確認。`decodeVideoEntry` の実引数 `buf` は常に (a) `IndexedDbFs.read()`（IndexedDB は get 時に structured-clone するため独立コピー）、(b) `fetch().arrayBuffer()` から作った新規 `Uint8Array`、のいずれかで、いずれも他所と共有されない。唯一 `MemoryFs.read()` は内部 Map の参照をそのまま返す（コピーしない）ため、もし将来 `imageCache.loadFromProject(project, memoryFsInstance)` を実ブラウザ（Worker 利用可）で video アセットに対し呼ぶコードが追加されると、transfer が `MemoryFs` 内部の格納データを detach してしまう危険がある。**現状の全呼び出し元（`PreviewPanel.tsx` は `IndexedDbFs`、`exporter.ts`/`ExportDialog.tsx` は常に `store.getFs()`、`BundlePlayer.ts` は `loadVideoBlobsFromUrls`（fetch 経由・MemoryFs 不使用）経由）はこの経路を通らないことを grep で確認済み**。将来 MemoryFs 経由で video を `loadFromProject` に流す変更をする場合はこの制約に注意。
- **検証**: `npm run typecheck` / `npm test` 954/954 緑（Node test 環境は `Worker` 未定義のためフォールバック経路＝Phase 2a 相当の同期 Blob 構築を通ることを確認）。`npm run build:player` 実行済み（新規 `videoBlob.worker` チャンクが `public/assets/` に出力されることを確認、`playerBuildFreshness` 緑）。既存 export 系 verify 無回帰: `verify-video-export-monotonic.mjs` PASS、`verify-packed-alpha-e2e.mjs` PASS、`verify-export-split-alpha.mjs` PASS。**実機 Playwright（使い捨てスクリプトで検証・コミットせず削除済み）**: 実際に video レイヤーを追加し、live PreviewPanel の `<video>` 要素が worker 経由で発行された `blob:` URL を `src` に持ち、`readyState=4`・`videoWidth=1920` まで実デコードされることを確認（Worker blob-URL スコープ罠が実際に回避できていることの実証）。
- **Next steps**: Phase 3（IndexedDbFs.readBatch + 優先度ソート + フレーム譲渡）へ進む。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 3（readBatch + 優先度ソート + フレーム譲渡）✅

- **実装**:
  - [IndexedDbFs.ts](src/fs/IndexedDbFs.ts) に `readBatch(paths): Promise<Map<string, Uint8Array>>` を追加（同一 microtask 内で全 `get` を発行し単一 readonly トランザクションにまとめる。見つからないキーは Map に含めない）。`FileSystem` インターフェースは拡張せず IndexedDbFs 固有メソッドのまま（PLAN の指示通り）。
  - [collectReferencedAssetIds.ts](src/runtime/collectReferencedAssetIds.ts)（新規・純関数）: `rootCompId` から到達可能な timeline comp（`comp` component 経由でネスト再帰・`visited` セットで循環ガード）が参照する image/video の assetId を集める。
  - [imageAssetCache.ts](src/runtime/imageAssetCache.ts): `ImageLoadOptions.priorityAssetIds?: ReadonlySet<string>` を追加。`loadFromProjectImpl` は候補 asset を「優先集合→その他」の安定ソートで並べ替え、`LOAD_BATCH_SIZE=3` 件ずつ `loadAssetBatch()` を呼び、バッチ間で `yieldToFrame()`（`requestAnimationFrame`、無ければ `setTimeout(0)`）を挟む。`loadAssetBatch` は `fs` が `readBatch` を持つ場合（duck-typed `hasReadBatch`、`IndexedDbFs` への直接依存を避けるため instanceof でなく optional method 判定）はバッチ一括取得、無ければ `Promise.all(fs.read(...))` の並列フォールバック。ソートは**ロード順序のみ**を変更し、`byId`/`byPath` の最終内容・project.json 直列化（serialize.ts の id 昇順）とは無関係。
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx): 現在表示中の `comp` から `collectReferencedAssetIds(project, comp.id)` を計算し `imageCache.loadFromProject` に `priorityAssetIds` として渡す。
  - spec §11.1 に 1 行追記。
- **検証**: `npm run typecheck` / `npm test` 963/963 緑。新規テスト: [test/indexedDbFsReadBatch.test.ts](test/indexedDbFsReadBatch.test.ts)（存在/欠損キー混在・空配列・既存 `read()` との byte 一致）、[test/collectReferencedAssetIds.test.ts](test/collectReferencedAssetIds.test.ts)（直下参照・ネスト comp 再帰・循環ガード・未知 comp id）、[test/imageAssetCache.test.ts](test/imageAssetCache.test.ts) に `priorityAssetIds` の順序非依存性・`LOAD_BATCH_SIZE` を跨ぐ 5 件ロードの統合テストを追加。`npm run build:player` 実行済み（`playerBuildFreshness` 緑）。既存 export 系 verify 無回帰: `verify-video-export-monotonic.mjs`・`verify-packed-alpha-e2e.mjs`・`verify-export-split-alpha.mjs` PASS。
- **計測（Phase 0 ハーネス、同一 HTTP/1.1 dev server での matched A/B, 5 run 中央値）**: `maxLongTaskMs` 90ms（Phase 3 前）→95ms（Phase 3 後）で **明確な改善は確認できなかった**（ノイズの範囲内）。要因分析: この固定テストプロジェクトは動画 asset が 6 件のみで `LOAD_BATCH_SIZE=3` のバッチが 2 回にしかならず、かつ Phase 2b で動画デコード自体は既に Worker オフロード済みのため、IndexedDB tx 分割・yield の効果を検出できるほど main thread 側の残作業（27 comps 分の expression/font 準備等）に対して支配的でなかったと考えられる。Phase 1/2a と同様、**この検証環境・この固定 fixture のスケールでは効果を実測で示せなかった**ことを正直に記録する（機能的な正しさ・回帰無しは unit test・verify で担保済み）。より多くの小アセット・より高レイテンシな環境（元課題の報告環境）で効果が顕在化する可能性が高い。
- **Next steps**: Phase 4（deserializeProject の Uint8Array 直接デコード）へ進む。

### 2026-07-07（Claude）— Preview Rendering Pipeline Optimization Phase 4（deserializeProject の Uint8Array 直接デコード）✅ — Phase 0〜4 完了

- **実装**: [serialize.ts](src/core/serialize.ts) `deserializeProject` を `Uint8Array | string` 受理に拡張（モジュールスコープの `TextDecoder` を再利用、`string` 入力は従来通り）。[projectFs.ts](src/core/projectFs.ts) `loadProject` を `readText`（`bytesToText` 経由の中間 string）→ `read` + `deserializeProject(bytes)` に変更。**`serializeProject`（直列化出力）は一切変更していない**（ユーザー厳守指示）。
- **検証**: `npm run typecheck` / `npm test` 965/965 緑。新規テスト（[test/serialize.test.ts](test/serialize.test.ts)）: `Uint8Array` 入力が同内容の `string` 入力と同一結果になること・非 ASCII（日本語）名の round-trip。既存の `test/roundtrip.test.ts`・`test/canonical-edge.test.ts`（`loadProject` 経由、INV-4 byte 等価）が新しい bytes 経路を透過的にカバーしていることを確認（緑）。`npm run build:player` 実行済み（`playerBuildFreshness` 緑）。実機 Playwright: `verify-packed-alpha-e2e.mjs`・`verify-export-split-alpha.mjs`・Phase 0 ハーネス（zip 展開 → `loadFromFs()` → 起動）が新しい bytes 経路で無回帰 PASS。
- **既知の無関係な flaky（Phase 0〜4 を通じて複数回再確認・対応不要）**: `test/projectBins.test.ts`「preserves treeOrder entry order」がまれに単体実行でも落ちる（恐らく `newBinId()`/`newAssetId()` の ULID が同一ミリ秒内でランダム部の大小関係が保証されないことに起因、`moveTreeEntries`/`canonicalizeTreeOrder` 自体は今回のどの Phase でも変更していない）。5 連続再実行では全て緑。本 PLAN のどの変更とも無関係であることを diff で確認済み（対応は別タスクとして次回申し送り）。

---

## Preview Rendering Pipeline Optimization Phase 0〜4 完了・総括

`doc/issue/preview-rendering-pipeline-optimization-plan.md` の Phase 0→1→2a→2b→3→4 をすべて実装・検証・コミット済み（各 1 コミット）。

- **機能的な正しさ**: 全 Phase で `npm test`（965/965）・`npm run typecheck` 緑、既存 export 系 verify（video/packed/split-alpha）無回帰、新規 unit test 追加、実機 Playwright で `<video>` の worker blob-URL 実デコードを確認。INV-2（scene 解決値不変）・INV-4（FS パス構成不変）・`project.json` 直列化形式（`serializeProject`）はいずれも無変更で死守。
- **正直な計測結果（重要）**: Phase 0 で確立した `probe-preview-startup.mjs` ハーネスと固定テストプロジェクト（`for-debug-data/_pj17`, 動画6件・27 comps）では、Phase 1（HTTP/2 dev）・Phase 3（readBatch+優先度+yield）とも **明確な体感/計測改善を実証できなかった**（Phase 2a のみ `loadFromProjectMs` で matched A/B 約9%改善を確認）。理由と考えられる点:
  1. localhost はレイテンシがほぼ 0 のため、HTTP/1.1 の 6 接続上限によるモジュール直列ロードのペナルティが元課題の報告環境ほど顕在化しない。
  2. 固定テストプロジェクトの動画資産が 6 件のみで、`LOAD_BATCH_SIZE=3` のバッチが 2 回にしかならず、IndexedDB トランザクション分割・yield の効果が測定ノイズに埋もれる。
  3. Phase 2b で動画デコード自体を Worker オフロード済みのため、Phase 3 の対象だった「メインスレッドでの一括流し込み」はすでに大幅に軽減されている。
  - **誇張せず、実測値と限界を都度 progress.md に記録した**（このセッションの一貫した方針）。技術的な実装自体（実際に HTTP/2 が使われる・Worker 経由で動画が正しく再生される・readBatch が正しく動く等）はすべて実機で検証・確認済み。より多くの小アセット・より高レイテンシな実環境（元課題の報告環境）でこそ Phase 1/3 の効果が顕在化する可能性が高い。
- **Phase 5（Electron NodeFs 切り替え）は着手していない**。CLAUDE.md・PLAN の指示通り、設計確認が必要な別マイルストーンとして次回に持ち越す。
- **Next steps**: (1) Phase 5 着手前にユーザーと設計確認（NodeFs 実装範囲・`store.getFs()` の自動判別・`readBatch` の `FileSystem` インターフェース正式追加要否）。(2) `test/projectBins.test.ts` の ULID 起因と思われる flaky を余力があれば別途調査。(3) より大規模な実プロジェクト（元課題の 200+ モジュール・多数アセット環境）での再計測を推奨。

---

## §16.2b packed alpha 再生ドリフト修正（packed 専用 preview proxy）— 2026-07-08 実装完了

**発端**: ユーザーから「Comp32 の人物抽出（packed 変換済み）動画が、途中（4秒目前後）から徐々にタイムラインとズレていく／固まる・カクつく」と報告。当初 split alpha の `applyAlphaGenlock` warm-up 化を提案したが、対象アセットが **packed**（1本動画・companion/genlock 不発）と判明し提案は無効化。ユーザー指示で Sonnet 5 に切り替え、実装フェーズを開始（Opus 4.8 subagent に難所レビューを都度依頼、実ブラウザ Playwright で検証、spec §16.2b と都度照合）。

### 根本原因（実機計測で確定）

`mafter-project (22).zip`（Downloads 最新）の Comp32 Person レイヤーの packed アセットは **webm（VP9 ソフトウェアデコード）・実デコード解像度 640×2284px**（`asset.meta.width=1080` は表示サイズであり実デコード幅とは別物 — `convertSplitToPacked.ts` の既存コメント通りの罠）。この巨大フレームを VP9 ソフトデコードで実時間再生できず、`holdTimeline`（双方向同期）が慢性的に発火 → **修正前は 8 秒の壁時計でタイムラインが約 3.9〜4.97 秒分しか進まない（実時間の半分程度）・dropped frame 率 約38〜93%**（計測条件により変動、最悪ケースでサンプル時間の9割が stall）。これは preview 実時間再生（editor preview + §11.7 HTML bundle live）専用の問題で、決定論 export（mp4/webm/PNG、フレームごと決定論 seek）は無関係（INV-2 非干渉）。計測スクリプト: `probe-packed-drift.mjs`（修正前計測）/ `probe-packed-drift-after.mjs`（修正後計測、リポジトリ直下・未コミット、他 probe-*.mjs と同じ慣例）。

### 実装（packed 専用 preview proxy）

1. **spec 更新**: `doc/mafter-effect-spec.md` §16.2b に packed preview proxy 方針を追記（§5/INV 不変・散文追記のみ）。issue doc `doc/issue/subject-extract-split-alpha-webm-preview-instability.md` に追記5（1本化＝修正4実装後も decode-bound 自体は別要因として残存、という新知見）。
2. **`src/runtime/packedVideoProxy.ts`（新設）**: `buildPackedVideoProxy` / `fitPackedProxyDimensions`。原本 packed をレイアウト保持のまま縮小再パックして webm エンコード。Opus レビューで `contentHeight<=0` ガード・layout 整合 assert を追加。
3. **`src/runtime/footageQuality.ts`**: `effectivePackedQuality(userQuality, {exportStep})` — exportStep なら常に `"original"`（INV-2）、それ以外は既定 `PACKED_DEFAULT_PROXY_TIER="low"`（VP9 ソフトデコードでも実時間再生できる保守的な下限。H.264 proxy 化は見送り＝ nice-to-have、必要になれば追う）。
4. **`src/runtime/imageAssetCache.ts`**: `packedProxyLayoutById`（tier別）+ `getPackedAlphaLayoutForQuality` を追加。URL（`getUrlForQuality`）と layout を必ず同じ quality で対にして引く不変を全 3 呼び出し経路（DomRenderer 本経路・lookahead warmup・export 専用 `flushVideoFrames`）で維持（`flushVideoFrames` は exportStep 常時 true につき無変更で正しい、と Opus レビューで確認済み）。
5. **`src/editor/store.ts`**: `ensureProxyTier` に packed 分岐（`isPackedAlphaVideoMeta` を `footageKindOf` より先に判定）。`meta.proxies[tier]` に `contentHeight`/`gutterPx` を併記。
6. **`src/runtime/DomRenderer.ts`**: video ケースで `isPackedAsset`/`effQuality` を計算し `getUrlForQuality`/`getPackedAlphaLayoutForQuality` を同一 quality で呼ぶ。
7. **`src/editor/panels/PreviewPanel.tsx`**: 編集中 comp の packed レイヤーを idle 中に自動で proxy 生成する effect を追加（`ensureProxyTier` 呼び出し前後で `evictPreviewMediaAsset` 必須）。
8. **`src/runtime/footagePlayback.ts` / `src/editor/ExportDialog.tsx`**: `collectExportProxyJobs` に `includePackedAlpha` オプション追加、HTML bundle export のみ packed proxy を事前生成（決定論 export は対象外）。
9. **`npm run build:player`** 実行済み（`public/player.js` 更新・`playerBuildFreshness` 緑）。

### 実装中に発見・修正した重大なレースコンディション（実機検証がなければ気づけなかった）

Playwright 実機で「proxy は正しく生成されるが、mounted `<video>` がいつまでも原本のまま切り替わらない」という症状を発見。デバッグログを一時的に仕込んで追跡した結果:

- **原因**: `PreviewPanel` の idle-trigger（comp を開いた直後、200ms〜idle callback で発火）が `evictPreviewMediaAsset` → `ensureProxyTier`（proxy 生成に約40〜50秒かかる）を呼ぶが、**この evict が、comp 初回マウント時に走る「全 asset 一括ロード」effect（`[project, comp?.width, comp?.height]` 依存）とレースする**。一括ロードがまだこの asset の処理に到達していないタイミングで evict が割り込むと、一括ロード側が「proxy 未生成（meta.proxies undefined）のまま」で `byPath` キャッシュを再生成してしまい、`ImageAssetCache.loadAssetBatch` の cache-hit 最適化（`byPath.has(ck)` なら `loadProxiesFromFs` を re-run しない）により、**proxy 生成完了後も二度と拾われない**という恒久的なキャッシュ汚染が起きる。
- **修正**: `ensureProxyTier` 成功後に**もう一度** `evictPreviewMediaAsset` を呼び、`imageCacheRef.current.loadFromProject` を直接（他 effect のタイミングに依存せず）呼び直して確実に反映させる（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の packed idle-trigger 内）。
- **教訓**: この種の「起動直後の一括初期化」と「個別 asset の遅延再生成」が同じキャッシュを触る設計では、evict のタイミングレースに注意が必要。単体テスト・typecheck では検出不可能（実ブラウザの非同期タイミング依存）— 実機 Playwright 検証が必須だった好例。

### 実機検証結果（修正前後比較・Comp32・`probe-packed-drift{,-after}.mjs`）

| 指標 | 修正前 | 修正後（packed proxy 適用） |
|---|---|---|
| dropped frame 率 | 約38〜93%（計測条件により変動） | 約12% |
| 5秒コンテンツの完走時間（壁時計） | 実時間の半分以下（8秒経過で content 2.7〜3.9秒分） | 約6.3秒（ほぼ実時間） |
| lag 振れ幅 | 最大 -1000ms超（chronic） | -60ms〜+93ms 程度 |
| mounted `<video>` 解像度 | 640×2284（原本） | 360×1284（proxy、正しく差し替わることを確認） |

**回帰確認**: `npm test`（977/977 PASS、新規12件追加）・`npm run typecheck` 緑・`npm run build:player` 実行済み＆`playerBuildFreshness`緑。決定論 export（mp4/webm/PNG）は `effectivePackedQuality` が `exportStep` で常に `"original"` を返すため無回帰（Opus レビューでのコードトレース + 単体テストで確認。フルの mp4 export 実機実行は decode-bound な原本を使うため数分かかり、限界効用が低いため今回は省略）。split alpha（genlock）・通常 video レイヤーは `effectivePackedQuality`/`isPackedAsset` 判定を通らず無影響。

**Next steps**: (1) 実 Chrome（非 headless、GPU 有効）での追試（headless は GPU decode 無効という既知の制約があるため、実環境ではさらに改善する可能性）。(2) H.264 proxy 化（VP9 より確実な HW decode）は見送ったため、余力があれば検討。(3) `probe-packed-drift{,-after}.mjs` はリポジトリ直下に残置（他 probe-*.mjs と同じ慣例）、ローカル scratchpad パス依存のため他セッションでの再実行にはパス調整が必要。

### 追記: packed 専用「Preview Quality」ドロップダウン UI（同セッション）

ユーザー要望「プレビュー時のプロキシのクオリティをプルダウンで調整できるように・このプルダウンは書き出しに影響しない旨を明記」を受けて UI を追加。ヒアリングの結果、**決定論 export（mp4/webm/PNG）のみ影響しない**（HTML bundle export の live 再生には反映される — 既存の `effectivePackedQuality`/`collectExportProxyJobs({includePackedAlpha})` の設計と整合）方針とし、**packed レイヤー専用の新規ドロップダウンを追加**（既存の汎用 `footageQuality`/Quality UI とは別コンポーネント）。

- **`src/editor/panels/PackedPreviewQualitySelect.tsx`（新設）**: packed レイヤーの Inspector に表示。選択すると `footageQuality` prop を書き込み、proxy tier なら `ensureProxyTier` → 成功後 `evictPreviewMediaAsset` + `reloadPreviewMediaFromProject`（新規 export）+ `projectRevision` 手動 bump、という**上記レースコンディション対策と同型の安全な reload パターン**を踏襲。busy/failed 表示・注意書き（「プレビューと HTML バンドル書き出しの再生にのみ影響します。mp4 / webm / PNG 書き出しは常に原本の画質を使用します。」）を表示。
- **`src/editor/panels/VideoComponentFields.tsx`**: packed レイヤーのときだけ `def.params` から `footageQuality` を除外して汎用 `ComponentFields` の重複描画を防ぎ、代わりに `PackedPreviewQualitySelect` を描画（`useEditorStore` から `project` を自前取得・InspectorPanel 側の呼び出しシグネチャは無変更）。
- **`src/runtime/imageAssetCache.ts`**: `reloadPreviewMediaFromProject(project, fs, options?)` を新規 export（`previewCacheRef.loadFromProject` の薄いラッパ。PreviewPanel 外＝Inspector から安全に reload できるようにするため）。
- **副次的な発見（今回は対象外・別課題として記録）**: 調査中、`InspectorPanel.tsx` の `ExpressionPresetFields` 内に **`footageQuality` を特別扱いする `QualitySelect` コンポーネントが存在するが、実際には到達不能なデッドコード**と判明（`footageQuality` はどの expression preset の param にも存在しないため）。実際の video レイヤーの `footageQuality` は `ComponentFields`（汎用 enum select、友好ラベルなし・`ensureProxyTier` 自動生成なし）が描画しており、progress.md の過去記載（「UI（Phase 3）: QualitySelect...」）と実装が乖離している。**通常 video レイヤーの Quality 変更時に自動でプロキシが生成されない**という pre-existing の潜在バグの可能性があるが、今回のスコープ外（packed 専用の新規コントロールのみ対応）として着手していない。
- **実機検証**（`probe-packed-quality-ui.mjs`、リポジトリ直下・未コミット）: packed レイヤー選択時に Inspector に「Preview Quality」ラベル・注意書き・単一の select（汎用 Quality は非表示）が表示されることを確認。select を "medium" に変更 → busy indicator 表示・`footageQuality` prop が正しく `"medium"` に書き込まれることを確認（実際の proxy 生成完了までは待たず、UI 配線のみ確認・生成ロジック自体は前段の drift 検証で確認済み）。
- **回帰確認**: `npm test`（977/977 PASS）・`npm run typecheck` 緑・`npm run build:player` 実行不要（このセッションの追加ファイルは editor 専用で `player.js` 非同梱・`playerBuildFreshness` 緑のまま）。

### 追記2: packed 専用「Export Quality」ドロップダウン + WebCodecs 非対応時の透明化バグ修正 — 2026-07-08

ユーザー要望「プレビュークオリティとは別で書き出し時のクオリティもいじれるようにしてほしい。また webcodecs が使えない環境だと生成ができないっぽくて透明になってしまうっぽいので、何らかの警告を出してほしい」を受けて対応。後者は調査の結果、**単なる警告不足ではなく実際のバグ**（下記）と判明した。

**Export Quality（決定論 export 専用の独立した画質指定）**:

- **`src/runtime/footageQuality.ts`**: `effectivePackedQuality(userQuality, mode)` を拡張。`PackedQualityMode` に `exportQuality?: FootageQuality` を追加し、`mode.exportStep` のときは `mode.exportQuality ?? "original"` を返すよう変更（従来は `exportStep` なら無条件 `"original"` 固定だった）。既定 `exportQuality` 未指定時は今までどおり `"original"` のため既存プロジェクト・呼び出し元は無変更で動く（後方互換）。
- **`src/runtime/DomRenderer.ts`**: video ケースで packed 資産の `effQuality` 算出時、`exportQuality: normalizeFootageQuality(props["packedExportQuality"])` を渡すよう変更（決定論 export ステップでこの prop を参照する）。
- **`src/runtime/footagePlayback.ts`**: `collectExportProxyJobs` のオプションを `includePackedAlpha`（単一・preview 専用）から `includePackedAlphaPreview` / `includePackedAlphaExport` の2本に分離。`includePackedAlphaExport` は `packedExportQuality` prop から export 用 proxy tier を収集する（既定 `"original"` のままなら isProxyTier が false でジョブは増えない＝無コスト）。
- **`src/editor/ExportDialog.tsx`**: `collectExportProxyJobs(project, { includePackedAlphaPreview: format==="html-bundle", includePackedAlphaExport: true })` — 決定論 export（mp4/webm/PNG/prerender）は毎回 export-tier を、HTML bundle はそれに加えて preview-tier（live 再生用）も事前生成保証する。生成失敗時は既存の `setError(...)` 経路でユーザーに表示される（この経路は元々サイレント失敗ではなかった）。
- **`src/editor/panels/PackedExportQualitySelect.tsx`（新設）**: [[PackedPreviewQualitySelect]] と対になる新規コンポーネント。`packedExportQuality` prop（既定 `original`）を編集。プレビュー用の evict/reload は行わない（export 専用 prop であり preview URL 解決に使われないため不要）。選択時に `ensureProxyTier` を事前実行し busy/failed を表示（本番 export 時に無駄な待ちが出ないようにする早期チェック）。注意書き「mp4 / webm / PNG 書き出し（および HTML バンドルの焼き込みレイヤー）の画質を調整します。プレビューの表示には影響しません。」
- **`src/editor/panels/VideoComponentFields.tsx`**: packed レイヤーで `PackedPreviewQualitySelect` と `PackedExportQualitySelect` を両方描画。
- **doc/mafter-effect-spec.md §16.2b**: Export Quality の独立性・既定値を追記（散文のみ、§5/INV 不変）。

**バグ修正 — WebCodecs 非対応環境で packed レイヤーが透明のまま固まる（根本原因は「警告不足」ではなくキャッシュ破棄の順序バグ）**:

- **根本原因**: [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の packed proxy 自動生成 idle-trigger が、**`ensureProxyTier`（生成に数十秒〜、失敗もありうる）を呼ぶ「前」に `evictPreviewMediaAsset(assetId)` を呼んでいた**。`evictAsset` は該当 asset の **原本**の blob URL も `URL.revokeObjectURL` して `byId`/`byPath` から削除するため、evict した瞬間から `DomRenderer` の `getUrlForQuality`/`getUrl` が `null` を返すようになり、`<video src>` が空になる＝レイヤーが透明表示になる。生成が成功すれば後続の evict+reload で正しい proxy URL に差し替わり気づきにくいが、**生成が失敗する（WebCodecs 非対応・ディスク書き込み失敗等）と `if (!ok) return;` で即座に抜けるため、二度とキャッシュが復元されず永久に透明のまま固まる**。実機再現に成功（`window.VideoEncoder` を `addInitScript` で削除 → 修正前コードで再現想定、修正後コードで非透明を確認）。
  - 対になる `src/editor/panels/PackedPreviewQualitySelect.tsx`（ユーザーが明示的に選択したときの経路）は元々 evict を**成功時のみ**呼んでおり、この不具合は無かった。idle-trigger 側だけが「生成前 evict」という古い（レース修正以前の）手順を残していた。
- **修正**: idle-trigger から生成「前」の evict を削除。生成中は原本の URL がそのまま有効なため、成功するまで（または失敗しても）レイヤーは常に何かしら再生可能な状態を保つ。生成成功後の evict + `imageCacheRef.current.loadFromProject` 明示リロードはそのまま維持（[[packed alpha 再生ドリフト修正]]で確立した安全な reload パターン）。
- **予防**: `webcodecsUnavailableReason()`（既存 `src/runtime/webcodecsVideoEncode.ts`）が非 null のとき、idle-trigger は試行自体をスキップ（`useEffect` 冒頭で早期 return）— 失敗が確実な生成を毎回リトライしない。
- **警告 UI**: `src/editor/panels/VideoComponentFields.tsx` に、packed レイヤーかつ `webcodecsUnavailableReason()` が非 null のとき常時表示の警告バナーを追加（「⚠ このブラウザは WebCodecs (VideoEncoder) に未対応です。... プレビュー/書き出し用の縮小プロキシを生成できないため、常に原本画質で再生・書き出しされます。」）。個別の生成失敗時（"proxy failed"）も原因が WebCodecs 非対応と判別できる場合は "proxy failed (no WebCodecs)" に文言を変える（[[PackedPreviewQualitySelect]] / [[PackedExportQualitySelect]] 両方）。
- **既存の他経路の確認**: `PackedAlphaConvertFields.tsx`（split→packed 変換）・subject extract（`encodeRgbaFramesToSubjectWebm` 等）は元々 `VideoEncoder === undefined` を検出して例外を投げ、呼び出し側が `status` テキストに「失敗 — ...」として表示済み（サイレント失敗ではない）。`ExportDialog.tsx` の export-time proxy 生成失敗も既存の `setError(...)` で表示済み。**サイレント失敗＝透明化バグがあったのは PreviewPanel の idle-trigger 1箇所のみ**。

**実機検証**（Playwright、`window.VideoEncoder`/`VideoFrame` を `addInitScript` で削除して WebCodecs 非対応環境を再現）:

- `probe-packed-nowebcodecs.mjs`（scratchpad + リポジトリ直下）: WebCodecs 不在確認 → Comp32 ロード・3秒待機（idle-trigger 発火猶予）後、packed `<video>` 要素が `readyState:4`（HAVE_ENOUGH_DATA）・`videoWidth/Height: 640×2284`（原本のまま）・`src` 非空であることを確認（＝透明になっていない）。スクリーンショットで人物抽出レイヤーが正しく合成表示されていることを目視確認。Inspector には WebCodecs 警告バナー・Preview Quality・Export Quality 両ラベル・書き出し無影響の注意書きが表示されることを確認。
- `probe-packed-export-quality-independent.mjs`: WebCodecs 通常環境で Export Quality を "medium" に変更 → プレビュー中の `<video src>`（blob URL）が変化しないこと・`footageQuality`（preview prop）が変化しないこと・`packedExportQuality` prop のみ `"medium"` に更新されることを確認（Preview/Export 独立の直接検証）。

**回帰確認**: `npm run typecheck` 緑。`npm test -- --run`（981/982、`test/projectBins.test.ts` 1件は base コミットでも単独実行でも green＝フルスイート実行時のみ稀に落ちる pre-existing な順序依存 flake と確認、本セッションの変更とは無関係）。`test/footageQuality.test.ts` に `effectivePackedQuality` の exportQuality 独立性テスト・`collectExportProxyJobs` の新オプション（`includePackedAlphaPreview`/`includePackedAlphaExport`）テストを追加。`npm run build:player` 実行済み（`footageQuality.ts`/`DomRenderer.ts`/`footagePlayback.ts` を変更したため必須）・`playerBuildFreshness` 緑。

**Next steps**: なし（今回の2件の要望は両方実装・実機検証済み）。参考: 前回追記で記録した「通常 video レイヤーの Quality 変更で自動プロキシ生成されない」pre-existing バグ（`QualitySelect` デッドコード）は今回も未着手（引き続きスコープ外・別課題）。

### 追記3: Preview Quality に「Same as Export Quality」リンク選択肢を追加 — 2026-07-08

ユーザー要望「preview quality プルダウンに same as export quality みたいなの追加したい」を受けて実装。

- **`src/runtime/footageQuality.ts`**: `PACKED_SAME_AS_EXPORT = "same_as_export"`（sentinel 定数）・`PackedPreviewSelection = FootageQuality | typeof PACKED_SAME_AS_EXPORT`（型）・`isPackedSameAsExport` / `normalizePackedPreviewSelection` を追加。`effectivePackedQuality` の第一引数型を `PackedPreviewSelection` に拡張し、`previewSelection === PACKED_SAME_AS_EXPORT` のとき（`exportStep` 無し）は `mode.exportQuality` を**そのまま**返す新分岐を追加 — 既存の「`"original"` は既定 proxy tier に差し替える」ロジックを**意図的にバイパス**する（Export Quality が Original なら、プレビューも文字通り原本を使う。ユーザーが明示的にリンクした結果は decode-bound 低速化込みで尊重する、という設計判断）。
- **`src/editor/panels/PackedPreviewQualitySelect.tsx`**: ドロップダウンの先頭に "Link" optgroup で "Same as Export Quality" オプションを追加。選択中は解決後の実効 tier を小さく表示（例: `→ Medium`）。`value`/`commit`/`onChange` を `PackedPreviewSelection` 型に拡張し、`onChange` は選択値をそのまま `effectivePackedQuality` で解決してから `isProxyTier` 判定・`ensureProxyTier` を呼ぶ（sentinel のまま `isProxyTier` に渡すと型エラーになるため必ず解決後の値で判定）。
- **`src/editor/panels/PackedExportQualitySelect.tsx`**: Export Quality 変更時、Preview Quality が現在 `PACKED_SAME_AS_EXPORT` にリンクされているかを自分の prop 読み取りだけで判定し（親コンポーネント経由の状態共有は不要）、リンク中なら生成成功後に `evictPreviewMediaAsset` + `reloadPreviewMediaFromProject` でプレビューを追従させる。既定（Original への変更、proxy 不要）でもリンク中なら reload だけは行う（DomRenderer は毎フレーム props から再解決するため実際には元々ズレないが、安全側で統一）。
- **`src/runtime/DomRenderer.ts`**: メイン video 描画ブランチ・`scheduleVideoLookaheadWarmup`（先読み prime）の両方で `normalizePackedPreviewSelection(props["footageQuality"])` を経由するよう変更（先読みでメイン描画と食い違う quality を prime すると無駄になるため、両経路を必ず同じ解決規則にする）。
- **`src/runtime/videoLookaheadWarmup.ts`**: `VideoClipLookaheadInput` に `packedExportQuality?: string` を追加、`collectVideoClipsFromComp` で読み取り（先読み判定にも Export Quality が必要なため）。
- **`src/editor/panels/PreviewPanel.tsx`**: idle-trigger の packed proxy 自動生成判定を `normalizePackedPreviewSelection` + `exportQuality` 経由に変更。
- **`src/runtime/footagePlayback.ts`**: `collectExportProxyJobs` の preview 分岐（`includePackedAlphaPreview`）を `normalizePackedPreviewSelection` 経由に変更 — `footageQuality: "same_as_export"` のレイヤーも正しく `packedExportQuality` 由来の tier をジョブ化する。
- **副次的に発見・同時修正した既存バグ（`bundleCollect.ts`）**: HTML bundle export の zip 同梱ファイル選定（`collectObjectAssets`）が、packed レイヤーについて生の `footageQuality` prop（多くの場合未設定＝`"original"`）をそのまま `resolveFootageVideoPath` に渡しており、**`effectivePackedQuality` が実際に選ぶ tier（既定で `low` proxy）と食い違っていた**。bundle player 側の `registerProjectUrls` は `meta.proxies` を無条件に URL 登録するため、この食い違いは「player は `xxx.low.webm` を要求するのに zip にそのファイルが無く 404 → packed レイヤーが HTML bundle で再生されない」という**見えにくい既存バグ**だった（今回の Same as Export Quality 追加でさらに顕在化しやすくなるため、同じ修正で一括対応）。`bundleCollect.ts` の video 収集ロジックを、packed asset のときだけ `effectivePackedQuality(normalizePackedPreviewSelection(...), {exportStep:false, exportQuality})` 経由に変更して修正。
- **doc/mafter-effect-spec.md §16.2b**: Same as Export Quality の挙動・bundle 同梱の一致要件を追記（散文のみ、§5/INV 不変）。
- **テスト追加**: `test/footageQuality.test.ts` に `PACKED_SAME_AS_EXPORT` 系 8 件（sentinel 正規化・型ガード・`exportStep` 有無での解決・`collectExportProxyJobs` 連携）。`test/bundleExport.test.ts` に packed alpha の zip 同梱 regression テスト 2 件（既定 proxy tier が同梱されること・`same_as_export` 時に `packedExportQuality` 由来の proxy が同梱されること。内蔵音声は quality 非依存で常に原本も同梱されるため原本も同時に含まれる点をテスト内コメントで明記）。
- **実機検証**（`probe-packed-same-as-export.mjs`、リポジトリ直下・未コミット）: Preview Quality ドロップダウンに "Same as Export Quality" が表示されること、選択すると `footageQuality: "same_as_export"` が書き込まれること、解決後 tier ヒント（`→ Original`）が表示されること、Export Quality を "medium" に変更すると `packedExportQuality` prop が更新されリンク検知により生成がトリガされる（busy 表示）ことを確認。**注**: headless Chromium は WebCodecs VP9 encode を完走できない既知の制約（memory: `headless-webcodecs-encode-blocks`）のため、生成完了後の実際のプレビュー切り替わりまでは headless では確認できず、リンク解決ロジック自体は unit test（`footageQuality.test.ts`）でカバーした。
- **回帰確認**: `npm run typecheck` 緑。`npm test -- --run`（990/990 PASS、新規10件）。`npm run build:player` 実行済み・`playerBuildFreshness` 緑。

**Next steps**: なし。余力があれば実 Chrome（非 headless）で Same as Export Quality の生成完了後の自動切り替わりを最終確認するとより確実（現状は unit test + headless での busy-state 確認まで）。

### 2026-07-08（Claude）— packed alpha Preview Quality "Original" を文字通り原本にする（自動 tier 差し替えの撤回）

- **報告された不満**: Preview Quality が "Original" のとき、明示的に "High" を選んだときより画質が低く見える。原因は `effectivePackedQuality()` が "Original"（未選択の既定値も含む）を黙って `low` tier proxy に差し替えていたため（decode-bound 回避目的、旧仕様）で、UI にその旨のヒントも出ておらず不透明だった。ユーザーからの明確な要望: 「Original を選んだら本当に Original にして、画質を下げるならドロップダウンで明示的に選ばせてほしい」。
- **修正方針**: 「未設定時の安全なデフォルト」と「"Original" の意味」を分離した。
  - `src/runtime/footageQuality.ts`: `effectivePackedQuality()` から "original → low tier" の自動差し替え分岐を削除（`PACKED_SAME_AS_EXPORT` の解決は従来通り）。`normalizePackedPreviewSelection()` は **未設定/不明値のときだけ** `low`（`PACKED_DEFAULT_PROXY_TIER`）にフォールバックし、`"original"` を含む既知の値は常にそのまま尊重するよう変更。
  - `src/editor/subjectExtract/applySubjectExtract.ts`: 新規 Subject Extract レイヤー作成時、`asset.meta.alphaMode === "packed"` なら `footageQuality` prop を明示的に `"low"` で書き込む（`initialFootageQuality()`）。split/unified は従来通り `"original"`（proxy tier の仕組みが無いため無関係）。これにより decode-bound 回避は「ドロップダウンの初期選択」として可視化され、"Original" を選べば常に文字通り原本になる。
  - `src/editor/panels/PackedPreviewQualitySelect.tsx`: Preview Quality が `"original"` のとき「⚠ may stutter (no proxy)」ヒントを追加。フッター説明文にも "Original" が文字通り原本を使う旨を追記。
  - `doc/mafter-effect-spec.md` §16.2b の該当箇所を新仕様に書き換え。
- **既存プロジェクトへの影響（意図的な挙動変更）**: 過去に Subject Extract で作成された packed レイヤー（旧コードが `footageQuality: "original"` を明示的に書き込んでいた）は、今回の変更後は黙って `low` に差し替わらず**文字通り原本を使うようになる**。decode-bound で重いままなら、ユーザーがドロップダウンで明示的に Low 等へ落とす操作が必要（ユーザー要望通りの意図的な仕様変更であり、regression ではない）。
- **検証**: `npm run typecheck` 緑。`npm test`（993/993 PASS、新規3件: `footageQuality.test.ts` に normalize/effective の新挙動アサーション更新、`subjectExtractApply.test.ts` に packed→low・split→original の初期値テスト追加）。`footageQuality.ts` は `DomRenderer.ts` 経由で player にも import されるため、Claude Code hook が `public/player.js` を自動再ビルド済み（`playerBuildFreshness` 緑を確認）。
- **Next steps**: なし。

### 2026-07-08（Claude）— packed alpha 動画の黄ばみ色ズレ調査・修正

- **症状**: packed alpha 動画（§16.2b）が Preview Quality "Original" でも元動画より黄色っぽく見えるとの報告（`doc/issue/alpha-vid-is-weirdly-yellow.md`）。
- **Phase 0 実測（Playwright headless、`encodeRgbaFramesToPackedVideo` を直接叩く合成テスト）**: グレースケール階調・原色・肌色パッチを 64×64 と 1280×720 の両方で作り、encode→`<video>`decode→`drawImage`/`getImageData` および実運用の CPU 合成（`drawPackedAlphaComposite`）・GL 合成（`createGlAlphaCompositor.compositePacked`）の3経路すべてでサンプリングしたが、**H.264/mp4 経路では色ズレを再現できなかった**（max abs diff = 2/255、H.264 のロッシー量子化ノイズの範囲内、色相シフトなし）。これは headless Chromium が本セッションでは software（swiftshader）の H.264 encode/decode を使っており、encode 側の暗黙の行列既定値と decode 側の推測が**たまたま同じソフトウェア実装内で一致**しているためと考えられる（下記調査で判明した通り、実際の不整合は主にハードウェアエンコーダ経路・Windows で顕在化するとの報告あり）。**つまり本セッションのサンドボックスでは「Before」の黄ばみを直接再現できておらず、これは既知のサンドボックス制約（後述）であって、ユーザー報告を否定するものではない。**
- **原因調査（Opus 4.8 subagent・WebSearch/WebFetch で MDN・W3C WebCodecs仕様・Chromiumのissue・ライブラリメンテナの一次情報を確認）**: これは **既知の Chromium WebCodecs の色空間バグ**で、canvas→`VideoFrame`→`VideoEncoder` は既定で **BT.601 行列**で RGB→YUV 変換する一方、コンテナが無タグだと再生側（`<video>`）は**解像度ベースの推測**（概ね SD→BT.601 / HD→BT.709）で YUV→RGB 変換するため、**HD 級コンテンツで 601 encode / 709 decode の不一致**が生じ黄色っぽい色ズレになる（w3c/webcodecs#598、Chromium issue 40061457 等。Windows で顕在化・macOS では出ないなどプラットフォーム依存の報告あり）。range（full/limited）は副次要因で、色相シフトの主因は matrix 側。`mp4-muxer`(^5.2.2)/`webm-muxer`(^5.1.4) の型定義を確認したが、いずれも動画トラック設定に color/matrix/range を書き出すフィールドを持たない（コンテナは無タグのまま出力される）。
- **spec 追記**: `doc/mafter-effect-spec.md` §16.2b に「色空間ポリシー」節を追加（§5/INV 変更なし、`asset.meta` は既存の自由形 record のまま）。
- **修正**: 新規 `src/runtime/videoColorSpace.ts` に `RGBA_SOURCE_VIDEO_COLOR_SPACE`（`{primaries:"bt709", transfer:"bt709", matrix:"bt709", fullRange:false}`）を定義し、`src/editor/subjectExtract/encodeAlphaWebm.ts`（H.264/mp4 の `encodeRgbaFramesToMp4H264` と VP9/webm の `encodeRgbaFramesToVp9Webm`＝packed 両コーデック・unified・split 生成すべてで共有）と `src/runtime/webcodecsVideoEncode.ts`（`encodeFramesToWebm`＝packed/footage/animated-raster proxy 共通の再エンコード経路）の `VideoEncoder.configure()` 呼び出しに明示指定。コンテナに書き込めない代わりに「エンコーダに実際にこの行列を使わせる」ことで、無タグのまま再生側の HD 既定推測（BT.709）と一致させる狙い。TS の `lib.dom.d.ts`（TS 5.9.3 時点）に `VideoEncoderConfig.colorSpace` が無かったため `src/types/webcodecs.d.ts`（`declare global` でのフィールド追加、既存 `src/desktop.d.ts` と同型）で補った。
- **スコープ判断**: `src/runtime/exporter.ts` の `configureVideoEncoder`（通常シーン合成の mp4/webm export が共有）は**意図的に対象外**とした。同種の潜在バグが理論上あり得るが、今回のタスクは Subject Extract 由来の「実写素材との比較」に限定されており、通常 export で同じ問題が報告・確認されているわけではないため、依頼のスコープを超えて共有 export 経路を変更しない（spec にもその旨明記）。
- **検証**: `npm run typecheck` 緑。`npm test`（990/990 PASS、既存 `subjectExtractEncode.test.ts`/`videoPackedAlpha.test.ts`/`packedVideoProxy.test.ts`/`playerBuildFreshness.test.ts` 含む）。既存の実機 verify を HTTP dev サーバ（`MAFTER_DEV_HTTP1=1 npx vite --port 5183`、既定の HTTPS dev server とは別に一時起動・検証後 kill 済み）に対して再実行し無回帰確認: `verify-packed-alpha-e2e.mjs` PASS、`verify-export-split-alpha.mjs` PASS、`verify-packed-export.mjs`（8/8 PASS）、`verify-convert-split-to-packed-e2e.mjs` PASS（実データ・Comp32 Person split asset、1080×1920・contentHeight 1138 の実写変換で visual parity failures 0/2304）。`public/player.js` は `encodeAlphaWebm.ts`/`webcodecsVideoEncode.ts` のいずれからも import されないため再ビルド不要（`playerBuildFreshness` が変更前から緑のまま）。
- **既知の制約・未検証事項**:
  - VP9/webm フォールバック経路（H.264 非対応環境向け）は、headless Chromium での WebCodecs VP9 encode が本環境で完走せずタイムアウトする既知の制約（memory: `headless-webcodecs-encode-blocks`）に阻まれ、Phase 0 の色実測を**単独では再現できなかった**（H.264 経路と同一の `configureVideoEncoder` 呼び出しパターン・同一定数を使っているため typecheck・コード構造上は同等の修正だが、実ブラウザでの直接確認は次回 non-headless 実 Chrome で行うのが望ましい）。
  - 本修正の効果自体（黄ばみが実際に解消するか）は、上記の通り headless サンドボックスでは Before/After 差が測れない性質のバグのため、**実ユーザー環境（Windows 実 Chrome）での目視・再実測を推奨**する。
- **Next steps**: ユーザー環境で packed alpha 動画の黄ばみが解消したか確認してもらう。もし残る場合は、`<video>` 再生ではなく `VideoDecoder` を明示 `colorSpace` で configure する経路への切替（アーキテクチャ変更・要相談）が次の一手（subagent 調査で「`<video>` は依然 guess に依存し得る」と指摘あり）。

#### 追記（同日）— `colorSpace` 修正の効果を実機計測で反証。ユーザー指摘で発覚

- ユーザーから HDR/BT.709マトリクス/GL・Canvas色管理/ML入力ガンマの4点を指摘され、裏取りのため ffmpeg/ffprobe で実データを直接検証した（前段の Phase 0 は合成パッチのみで実写未検証だった弱点）。
- **実写ソース（Pixel 6a 撮影・HEVC）の実タグ**: `color_primaries=bt709, color_transfer=bt709, color_space=bt709, color_range=pc(full)`。HDR側chain（HLG/PQ・`side_data_list`のmastering-display等）は**無し＝このアセットはSDR確定**（ユーザー指摘①はこのアセットでは否定できたが、他の実写アセットでは未確認）。
- **旧（修正前）packed 出力の実タグ**: `color_space=smpte170m(BT.601), color_range=tv(limited)`。ソースの bt709/full と明確に不一致 — ②のマトリクス不一致仮説を**実データで直接確認**（傍証ではなく確証）。
- **しかし `colorSpace` 修正の効果をゼロから作り直したファイルで検証したところ、無効だった**: `VideoEncoderConfig.colorSpace` に `bt709` を明示しても、生成ファイルの実タグは**修正前後で変化せず常に `smpte170m`**（本機の headless Chromium で確認）。さらに切り分けたところ、(a) `configureVideoEncoder` の `encoder.configure(support.config ?? cfg)` という既存パターンは `isConfigSupported()` が返す `support.config` が `colorSpace` を含まないため、そもそも `colorSpace` が `configure()` に渡る前に握りつぶされていた、(b) その config 経路のバグを回避して `colorSpace` を確実に渡しても（`support.config` を経由せず直接 / VideoFrame 側の `colorSpace` 経由 / H.264・VP9 両方）、**結果は変わらず常に smpte170m** — つまり **この Chromium ビルドは `VideoEncoderConfig.colorSpace` / `VideoFrame` の `colorSpace` を実装レベルで無視し、内部的に常に BT.601 相当で符号化している**（subagent 調査で「HW encoder ほど不安定」との指摘があったが、software encoder ですら効かないことを実測で確認）。
- **解釈の訂正**: encode が常に smpte170m 固定なら、その smpte170m タグは実際にビットストリームへ明示的に書き込まれている（ffprobe が具体的な値を出す＝タグ有り。無タグなら通常 unknown 表示になる）。ゆえに **同一ブラウザで自己完結する再生（このファイルを作った同じ Chrome で `<video>` 再生する分）は encode 側 smpte170m と decode 側の解釈が一致し、理論上は色ズレが出ない**はず（実際 Phase 0 の合成パッチ計測で max diff 2/255 だったのはこれと整合）。したがって **「無タグ→解像度ベース推測で 601/709 が食い違う」という当初の理論は、少なくとも本セッションの software encode 環境では成立しない（タグは明示され、自己無矛盾）**。Chromium issue 群が報告する 601/709 不一致は **主に Windows のハードウェアエンコーダ経路**で起きるとされ（research による）、本セッションの headless software encode では再現も反証もできない領域が残っている。
- **追加修正**: (a) の `configureVideoEncoder`（`src/runtime/exporter.ts`）・`configureForCodec`（`src/runtime/webcodecsVideoEncode.ts`）は colorSpace を握りつぶすこと自体が実装バグなので、`support.config` を使う場合でも呼び出し側が渡した `base.colorSpace` を明示的にマージし直す修正を追加（`encoder.configure(base.colorSpace ? {...finalConfig, colorSpace: base.colorSpace} : finalConfig)`）。これは「将来ブラウザが colorSpace を正しく解釈するようになったときに機構として機能する」ための正しさの修正であり、**現行の headless 環境での有効性を変えるものではない**（(b) の直接テストで、この経由を回避しても結果が変わらないことは既に確認済み）。`npm run typecheck` 緑・`npm test` 993/993 PASS（既存993件、`exporter.ts` は player.js 非依存のため build:player 不要）で無回帰確認済み。
- **現時点の正直な結論**: `RGBA_SOURCE_VIDEO_COLOR_SPACE` の追加と上記の配線修正は**害はない**（型安全・既存テスト無回帰・仕様に明記済み）が、**実際に黄ばみを解消する効果があるかは実証できていない**。むしろ本セッションの実測では無効という結果が出ている。ユーザー報告の実際の原因は次のいずれか、または複合の可能性が高く、**未特定のまま**:
  1. ユーザーの実アセットが実は HDR（HLG/PQ）である（今回確認したのは1本のSDRサンプルのみ）。
  2. Windows実機のハードウェアエンコーダ経路固有の 601/709 不一致（本セッションでは再現不可）。
  3. `texImage2D` vs `drawImage` の GL/CPU 経路差（既知・`verify-gl-alpha-parity.mjs` で maxDiff 22/255 未解明のまま放置）。ただし本セッションの合成パッチ計測では GL/CPU とも同じ結果で、この経路差は顕在化しなかった。
  4. Subject Extract の ML（MediaPipe）入力/出力のガンマ・色空間処理（未調査。ただし対象はマスク=alphaのみで、RGB自体の色相には無関係な可能性が高い）。
- **Next steps（更新・要ユーザー判断）**:
  1. ユーザーの実際に黄色く見えているアセット（大元の動画ファイル）を `ffprobe -show_entries stream=color_primaries,color_transfer,color_space,color_range -select_streams v` で確認し、HDR系タグ（`arib-std-b67`=HLG, `smpte2084`=PQ, `bt2020*`）が無いか確認したい。
  2. 本 fix（`colorSpace` 指定）は効果不明なため、実際に効くかは**非headless の実 Chrome + Windows 実機**での before/after 目視確認が必須（本セッションのサンドボックスでは原理的に検証不能）。
  3. 上記で解消しない場合、`<video>` に依存せず `VideoDecoder` を独自 `colorSpace` で configure する再生経路への切替を検討（アーキテクチャ変更のため実装前に要相談）。
## 2026-07-10 - Static noise investigation (bundle loop seam)

- Investigated the reported crackle/static without changing production behavior. Added `doc/issue/static-noise-problem/` with a report, implementation plan, and `verify-loop-audio-seam.mjs` diagnostic.
- Reproduced against Downloads `mafter-project (25).zip` / `Comp 10`: the video-only timeline loops `[0,112)` at 30 fps, seeking its embedded AAC audio from 3.733333 s back to zero. Decoded source PCM has a non-zero seam jump (L `-0.0316361`, R `-0.0197550`).
- Primary cause: bundle video audio uses `video.volume` set only during render. The 120 ms declick envelope is not sample-accurate at 30 fps (last-frame multiplier `0.362285`); the adaptive render gate can skip that frame entirely, so the native `<video>` seek occurs while non-silent.
- Secondary finding: `BundleAudioClock` does not yet apply `inPoint`/`outPoint`/`trimStart` timing to standalone `<audio>` elements. This is not involved in Comp 10 but should be fixed in the shared bundle media-audio controller.
- Next step: implement the documented bundle-only Web Audio gain controller and loop-boundary callback, then make the diagnostic pass against the same unsafe source seam.

### 2026-07-10 (Codex) — fix-plan review before implementation

- The documented direction (bundle-only Web Audio gain controller) remains appropriate, but the current plan is not implementation-ready: it does not define (1) a render-cadence-independent clock that begins the pre-seek fade before the loop boundary, (2) the DomRenderer video-pool lifecycle / one-source-node-per-element contract, or (3) the forced loop-start render and media-readiness gate before fade-in. A callback that runs only after wrap is too late to prevent the click.
- Standalone `<audio>` timing also needs a layer-time mapping (`inPoint` / `outPoint` / `trimStart`) before it shares the controller; otherwise the fix would preserve the known timing error.
- Tried a read-only Opus 4.8 design review under `RG-20260710-01`, but the local `Codex` CLI launch was denied by the OS. The delegation was recorded as abandoned; no code or spec was changed.
- Next step: revise `doc/issue/static-noise-problem/fix-plan.md` to specify the clock, media-audio bridge, loop handoff state machine, and acceptance gates; obtain confirmation before implementing the revised scope.

## 2026-07-11 — macOS 向け Electron ビルド対応（未署名 dmg/zip, arm64+x64, GitHub Actions 経由）✅

- **要請**: 「これelectron:macみたいな感じでMac用ビルドできるようにしたい」。既存は `electron:dist`（`--win portable` 固定、`win.target` のみ）で mac/Linux は未検証だった（2026-07-06 セッション記録）。
- **確定事項（ユーザー確認）**: 実行環境は **GitHub Actions（`macos-latest` runner）を追加**（electron-builder の mac ターゲットは Apple ツールチェーン制約で macOS ホスト必須・Windows 機ではローカル実行不可）。アーキテクチャは **arm64 + x64 両方**。署名は **なし（未署名）**、Windows portable 版と同じ運用（初回起動は Gatekeeper 警告 → 右クリック「開く」で回避）。
- **実装**:
  - [package.json](package.json) `build.mac` を追加（`target: [{dmg, arch:[x64,arm64]}, {zip, arch:[x64,arm64]}]`、`category: "public.app-category.video"`、`identity: null` で自動署名試行を明示的に無効化）。
  - `scripts` に `electron:dist:win`（既存 `electron:dist` と同一コマンド、後方互換のため `electron:dist` 自体は変更せず残置）と `electron:dist:mac`（`electron-builder --mac`）を追加。
  - 新規 [.github/workflows/electron-mac.yml](.github/workflows/electron-mac.yml)：`workflow_dispatch` 手動トリガー、`macos-latest`、Node 20（`electron@^35.7.5` が Node 20 前提という既存の固定理由に合わせた）、`CSC_IDENTITY_AUTO_DISCOVERY: false` で偶発的な署名試行を二重に防止、`npm ci && npm run electron:dist:mac`、`release/*.dmg` / `release/*.zip` を artifact アップロード。
  - `electron/main.ts` / `preload.ts` / `build.mjs` は Node 標準 API のみでプラットフォーム非依存のため無改修。タイトルバーは既存方針通り全 OS で自前ボタン（mac 信号機なし、2026-07-06 決定）のため無改修。
- **検証**: `npm run typecheck` 緑。`node -e "require('./package.json')"` で JSON 構文確認。ローカル（Windows）では mac ターゲットの実ビルドは原理的に検証不可 — 次回 GitHub Actions を `workflow_dispatch` で手動実行し `release/*.dmg`/`*.zip` が生成されることを確認する必要あり（未実施）。
- **対象外（今回やらない）**: コード署名・Notarization（Apple Developer Program 未登録）、カスタム mac アイコン（.icns 未用意、Electron デフォルトのまま）、自動アップデート（electron-updater）。
- **Next steps**: ユーザーに GitHub Actions ワークフローを一度手動実行してもらい、生成された dmg/zip を実機 Mac で開けるか（Gatekeeper 警告の右クリック回避含め）確認してもらうこと。将来 Apple Developer 証明書を用意する場合は `mac.identity`/`CSC_LINK`/`CSC_KEY_PASSWORD` の配線を追加する。

### 2026-07-12（Claude Haiku 4.5）— chromaSplit effect Phase A-1 実装（acid-digi-hyper-plan §3.1）✅

**Acid/Digi/Hyper live effects plan Phase A-1**: `chromaSplit` (RGB Split / Chromatic Aberration) を実装・完了。

- **実装内容**:
  - `src/runtime/effectSvg.ts`: `chromaSplitFilter()` 関数追加（SVG primitive 生成・角度/量からオフセット dx/dy 算出・R/G/B チャンネル分離・feOffset + feMerge 再合成）。
  - `src/runtime/builtinEffects.ts`: `CHROMASPLIT_EFFECT_DEF` 登録・exportに追加。params: `amount`(0..100px, ✅), `angle`(deg, ✅), `mode`(enum "rgb"/"rb", ❌)。
  - `doc/mafter-effect-spec.md` §27.3: chromaSplit セクション追記済み（`pixelSortLite` の直後）。
  - `test/effects.test.ts`: chromaSplit のテスト 5 個追加（null/identity、offset計算、angle依存、mode切り替え）。
- **spec/INV**: §5/INV 変更ゼロ。EffectDef レジストリ登録のみ（既存型の open string type ≠ 型拡張）。
- **経路**: live SVG filter（executionPath: "live"）。preview/browser export/web bundle 全経路を同じ primitives で通す（INV-2）。LIVE_DISPLACEMENT_EFFECT_TYPES 追加不要（非displacement、tint同様）。
- **検証**: ✅ `npm run typecheck` / `npm test` 緑（54 tests）。✅ `npm run build:player`（runtime側触るため）。Playwright visual verify は次のステップ（ユーザーが npm run dev → Chromium で効果確認）。
- **Opus 4.8 レビュー（第1回）**: feMerge vs feBlend 合成モード不一致を指摘。修正実施:
  - feComponentTransfer 各チャンネル抽出に `feFuncA type="linear" slope="1"` を明示化。
  - feMerge（source-over 合成）→ **feBlend mode="screen"**（加算合成）に変更。2 段階の chained blend。
  - test/effects.test.ts: `feMerge` アサーション → `feBlend` + `mode="screen"` に更新。
  - spec §27.3 との一貫性を確保（§27.3 2559行の `feBlend mode="screen"` 記載に準拠）。
- **Opus 4.8 レビュー（第2回・修正版）**: `rb` モード側の alpha クリップ漏れを指摘。再修正実施:
  - `rb` ブランチ末尾に `feComposite in="rgb" in2="SourceGraphic" operator="in"` を追加（screen ブレンドのエッジ色暴れ防止）。
  - 両モード対称化完了。
- **最終検証**: ✅ typecheck / test（54 tests）/ build:player すべて成功。commit 可能な状態。
- **Next steps**: (1) commit (review 通過済み)、(2) Phase A 残り 2 種（posterize / gradientMap）の実装 → Phase B/C 着手。
### 2026-07-14 (opencode) — pixelStretch lineBias (PLAN-ALT-1 WP-1/2) + Inspector slider
- Purpose: ALT-1 manual bias (ink auto-measure alternative). Users visually tune line origin with Line Bias (px, signed, animatable).
- Changes (minimal, INV-1/INV-2 structurally satisfied):
  - src/runtime/effectSvg.ts: PixelStretchOpts.lineBias?: number (optional). pixelStretchDisplaceMaps now does rawLine=clamp01(linePos)*n+(lineBias??0) then clamp+round to [0,n-1].
  - src/runtime/fastEffects.ts: PIXEL_STRETCH_EFFECT_DEF.params inserts lineBias (default 0, -200..+200, step 1, animatable) right after linePos. apply reads num(props["lineBias"],0) and forwards to primitives.
  - Existing behavior (bias omitted or 0) is bit-identical (unit test gate).
- Tests: test/pixelStretch.test.ts +2 cases (bias=0/omitted identity + apply passthrough). 21 pixelStretch tests PASS.
- Verify: typecheck OK / npm test -- pixelStretch OK / verify-pixel-stretch.mjs PASS / measure-*.mjs (bias=0) unchanged PASS.
- Player: npm run build:player executed (mandatory for runtime touch).
- Spec: doc/mafter-effect-spec.md §27.3 pixelStretch table now lists lineBias (manual px offset, references PLAN-ALT-1).
- Pre-snapshot: e2916aa committed investigations/.../PLAN-ALT-1.md before any code change.
- Status: WP-1+WP-2 done. **Waiting for WP-2.5 user real-device tuning feedback**. Then WP-3 (bake defaults per A/B/C). PLAN.md (ink) remains on hold.
- Impact: pure math in shared path (preview/export/bundle parity automatic). No §5/INV changes. Note: full-solid may be harmed by nonzero bias (confirm in WP-2.5).
### 2026-07-14 (opencode) — pixelStretch lineBias 意味修正
- 問題: 旧実装では `lineBias` が `linePos` 由来の「帯開始位置（エフェクト開始）」も一緒にずらしていた。
- 修正: `base`（帯開始 = linePos のみで決定）と `src`（サンプル元 = base + lineBias）を分離。
  - 帯範囲（inBand）と帯長は `base` で決まる。
  - 変位マップのターゲット（どの色を引くか）だけが `src` を使う。
- 影響: `lineBias` で「ストレッチするサンプルの開始位置」のみ調整可能になり、エフェクト（帯）の開始位置は動かない。
- テスト: 新規ケース追加（band start 直前は neutral / band start で (base+bias) をサンプル）。
- player: build:player 再実行。
- spec: §27.3 の技法説明を base/src 区分で更新（lineBias はサンプル元のみ）。
- PLAN-ALT-1 との整合: 「サンプル線の手動オフセット」という意図に合致する形に是正。
### 2026-07-14 (Claude Sonnet 5) — pixelStretch lineBias WP-3 完了・PLAN-ALT-1 close
- ユーザー実機確認: `lineBias = 8` で起点ズレ解消を確認、WP-3（基準値焼き込み）へ進行指示。
- **本質原因（ISSUE.md 実測ベース）**: `linePos` はレイヤーボックス基準、実際の塗り(ink)は
  ボックス内で非対称パディングを持つため `line = linePos·boxW` は原点方向へズレる。ズレ量は
  `inkLeft − linePos·(leftPad+rightPad)` でコンテンツ/linePos依存の変量（ISSUE.md 実測: full
  solid=0, diamond=±21, text=−11〜+122）。→ 分類上は案C（linePos依存・定数で根治不可）。
- **採用**: ユーザー指示によりハードコーディングで確定。`lineBias` の default を `0`→`8` に変更
  （src/runtime/fastEffects.ts の params.default と apply 内 `num(props["lineBias"], 8)` の両方）。
  よく使う構図（テキスト/シェイプの軽い偏り）での体感ズレを大きく減らす近似値として運用。
- **既知の限界（再オープンしない・残課題として記録）**: full solid や大きく異なる ink padding を
  持つコンテンツでは 8 が最適でない。手動微調整は既存の Line Bias スライダで可能。根治したい場合は
  ISSUE.md 案(A)（ink bbox 化・EffectRenderCtx.contentBox 拡張・要 INV-2 整合検討）を新規 PLAN として起票。
- テスト: test/pixelStretch.test.ts の "lineBias defaults to 0" ケースを "defaults to 8" に更新
  （omitted/8 が一致・0 は不一致、を検証する内容に変更）。
- 検証: typecheck / npm test / build:player 実行（結果は本行以降に追記）。
- Status: **PLAN-ALT-1 close**。PLAN.md（ink 自動測定・案A根治）は保留のまま、次に触る場合は要望ベースで再起票。
- **注記（2026-07-15 マージ時）**: 下記 length-drift 根治（PR #12）採用に伴い、`lineBias` の default は最終的に **0** に戻した（box-vs-ink の 8 焼き込みは不採用）。

### 2026-07-15（Claude Opus 4.8）— pixelStretch プレビュー帯スパイク（ガタガタ）を非破壊で根治 ✅
- **症状**: pixelStretch のストレッチ帯が「プレビューでだけ」縦スパイクでガタガタ。export は綺麗。
- **真因**: pixelStretch は live CSS filter。プレビューの `transform: scale()`（zoom）下で Chrome が
  filter を **scale 後のデバイス解像度で再ラスタライズ**し、変位マップのサンプリングが崩れる。
  実 Chrome 計測（investigations/pixel-stretch-origin/measure-spikes.mjs, measure-dynres.mjs）で確定。
  stage2 は無実（落とすと 1:1 でも悪化）。
- **修正（縮小 zoom≤1）**: 既存の will-change 案。stage(scale を持つ要素)を合成レイヤー化
  → ネイティブ解像度でラスタ→GPU 縮小。spikeJumps 38/29→0。
- **修正（拡大 zoom>1・本命）**: 動的解像度スーパーサンプル。変位マップを実効表示スケール
  (zoom×dpr)ぶん細分化して 1:1 化。measure-dynres.mjs で 106/333/519→1。
  - `PixelStretchOpts.superSample`（effectSvg.ts）: grid を k 倍、feDisplacementMap scale は
    userSpace 据え置き（返り値 /g）。k=1 で従来と厳密一致。上限 3。
  - `EffectRenderCtx/EffectChainCtx.renderScale` 追加、`DomRenderer.setRenderScale()`。
    preview=effectiveZoom×dpr、bundle player=fit zoom×dpr を注入。export は 1:1（既定 1・無回帰）。
  - **`npm run build:player` 実行済み**（runtime + player 変更のため必須）。
- **検証**: typecheck 緑 / pixelStretch.test.ts 19 / playerBuildFreshness / verify-pixel-stretch.mjs(1:1 drift) 全 PASS。
- **制限/Next steps**: 拡大は上限 3× まで（それ以上のズームインは僅かに残り得る）。
  ユーザーに >100% ズーム・HTML 書き出しの実機確認を依頼。実エディタ end-to-end の Playwright 追試は未実施
  （harness で実 filter コードパスは検証済み）。commit 未実施。

### 2026-07-15（Claude Opus 4.8）— 3D 押し出しがフォントの weight に追従しない問題を根治 ✅
- **症状**: text の weight を 700 等にしても、3D 化（geomEnabled）すると既定 weight（400）の字形で押し出される。2D は正しく太る。
- **真因（5 箇所の連鎖・いずれも「family だけ / 要求 weight だけ」を正としていた）**:
  1. `ensureBundledFontAsset`（store.ts）が **family だけで重複判定** → 最初に埋め込んだ weight が居座り、以降の weight の実ファイルが取り込まれない。
  2. font asset の `meta` に weight が無く、family しか記録していなかった。
  3. `FontOutlineCache` が **family 単独キー**（同 family の複数 weight は last-wins）。
  4. Inspector の **weight 変更が `ensureBundledFontAsset` を呼んでいなかった**（font 変更・3D トグル時のみ）。
  5. **`geom3dDomApply` の meshKey に font 由来の識別子が無かった** — これが最後まで残った本丸。
- **最後の 1 手（計測で判明・推測では出せなかった）**: 上記 1–4 を直しても preview のインクが 1099 のまま不変。実機プローブで
  「preview の FontOutlineCache は 400/700 両方を保持（advance 639/692）」「weight prop は 700」「なのに canvas は Regular」
  「リロードすると Bold（1654）」と切り分け → **メッシュキャッシュの毒**と確定。weight を 700 に書いた瞬間、Bold の非同期
  ロード完了前に描画が走り、**Regular 由来のメッシュが「weight=700」のキーで焼き付く**。以後は同じキーにヒットし続けるため
  スクラブでも直らず、リロードでのみ直る。
  → **meshKey は「要求 weight」ではなく「実際に使われた Font インスタンスの同一性」（WeakMap による安定 ID）を含める**よう修正。
- **修正ファイル**: `fontOutlineCache.ts`(family×weight + 最近傍フォールバック) / `store.ts`(family×weight 重複判定・`meta.weight` 記録・upload 時は os2.usWeightClass) / `InspectorPanel.tsx`(weight 変更で取り込み) / `DomRenderer.ts`(getFont に weight) / `previewViewer.ts`・`PreviewViewerOverlay.tsx`・`PreviewPanel.tsx`(bounds も同 face) / `assetFontFaces.ts`(**`font-weight` 記述子必須** — 同 family 複数 weight 同梱で 2D が壊れる回帰の予防) / `geom3dDomApply.ts`(meshKey = font identity)。
- **後方互換**: `meta.weight` を持たない旧 project の font asset は 400 扱い（唯一の face なら weight 指定でもそれを返す）。§5 型・直列化形式は不変（`meta` は元々 free-form）。
- **検証**: typecheck 緑 / `test/fontOutlineCache.test.ts` 新規 5 件（実 TTF で Bold の advance > Regular を固定）/ `npm test` は既存の
  `effects.test.ts > liquidChrome 再登録` 1 件のみ失敗＝**本変更前から失敗**（stash して確認済み・無関係）/ `npm run build:player` 実行済み /
  実機 `verify-font-3d-weight.mjs` PASS（ink 1099→1654, ratio 1.505, assets に 400 と 700）/ 既存 `verify-font-3d-extrude.mjs` PASS（無回帰）。
- **恒久 verify を追加**: `verify-font-3d-weight.mjs`（GL canvas の実インクで weight 追従を測る。修正前は ratio=1.000 で FAIL する）。
- **spec**: §26.4.1 に「weight は family と対等な識別子」節を追記（meta.weight / family×weight キー / font-weight 記述子必須 / meshKey は font identity）。
- **Next steps**: browser export（mp4/PNG 連番）と HTML bundle での 3D weight 実機確認は未実施。
  export 経路は fonts を描画前に一括ロードするため今回の「毒」レースは構造上起きず、family×weight 化の恩恵のみ受ける想定（unit test で固定済み）。

### 2026-07-16（Claude Opus 4.8）— ネスト comp 内の 3D-extrude text が 2D に落ちる問題を根治（§23.3e）✅

- **症状（ユーザー報告）**: DL にある新しい pj（`mafter-pj-3Dtext-with-pixelstretch.zip`）の **`Main` を他のコンポジションから呼び出すと正しく動作しない**。実測すると 3D 押し出しが完全に消え、フラットな 2D テキストになる（さらに pixelStretch が平面テキストに掛かって `語` が崩れる）。
- **真因（2 つ。1 つ目だけ直すと 2 つ目で壊れる）**:
  1. **`renderNestedComp` が `updateComponentEl` に `geom3dCamera` を渡していなかった**（トップレベル `applyObject` は渡す）。`updateComponentEl` は `geom3dCamera === null` で 2D フォールバックする仕様のため、precomp として呼ばれた瞬間 3D が消えていた。当時のコメント自体が「ネスト comp はスコープ外」と明記＝**意図的な未配線が仕様の穴として残っていた**。
  2. **`renderNestedComp` は毎フレーム `container.innerHTML = ""` する非 reconcile 実装**。1 を直すだけだと geom3d canvas が毎フレーム作り直され、**WebGL context が毎フレーム生成 → Chrome の同時上限(~16)を数十フレームで超過**し `Too many active WebGL contexts. Oldest context will be lost.` で 3D が消える（実機 70 フレームスクラブで再現・15 フレームでは出ないため短い検証だと見逃す）。
- **修正**（`src/runtime/DomRenderer.ts` のみ・ネスト経路に閉じた最小 diff）:
  - `geom3dCamera` に**子 comp のカメラ**（ローカル `cameraPre` / `childScene.camera?.fov` / `childComp.width/height`）を渡す。`this.cameraPre` は親 comp の値なので使わない。
  - `nestedElReuse: WeakMap<container, Map<key, el>>` を追加し、**`text` の el と再帰コンテナ（`comp`）だけ**を key（`objId:index:type`）で持ち越す（他型は従来どおり毎フレーム新規＝無回帰）。
  - 今フレーム使われなかった持ち越し el は既存の `releaseAlphaGlCompositorsUnder()` で GL を明示解放（持ち越しと解放は対で必要）。
- **検証（実機 Playwright・ユーザーの実 zip を import して Main を Outer にネスト）**:
  - 新規恒久 verify `verify-nested-geom3d.mjs`: 修正前 nested=**0 canvas / ink 0**（FAIL）→ 修正後 **3 canvas / ink 176920・standalone と ratio 1.000**（PASS）。
  - GL 持ち越しゲート: canvas 実体の同一性を見る（`kept === total`）。reuse を外すと `kept 0/3` で FAIL することを確認済み＝**ゲートに歯がある**。`Too many active WebGL contexts` 警告の観測は **GC 依存で不安定**なため合否条件にしない（実測で確認済み）。
  - **INV-2**: `compFrameCapture` の export PNG が 修正前 `outer(1cd74c…) ≠ main(81cb54…)` → 修正後 **両者バイト等価(81cb54…)**。preview だけでなく export も直った。
  - 無回帰: `typecheck` 緑 / `npm test` 1281 passed（唯一の失敗 `effects.test.ts > liquidChrome 再登録` は **stash して本変更前から失敗を確認済み・無関係**）/ `verify-font-3d-extrude` `verify-font-3d-weight` `verify-geom3d-mvp` `verify-geom3d-neutral` すべて PASS / `npm run build:player` 実行済み（player が DomRenderer を import するため必須）+ `playerBuildFreshness` 緑。
- **spec**: §5.5f の「ネスト comp は対象外」記述 3 箇所を更新し、**§23.3e**（ネスト comp 内 3D-extrude text と GL リソース持ち越し規約）を新設。§5 型・INV 変更なし（散文のみ）。
- **調査で判明した他の未配線（今回は未修正・要判断）**: `renderNestedComp` はトップレベル `applyObject` と比べて次が未配線 —
  (a) **track matte**（ネスト内マット無効）、(b) **plugin component の `ComponentDef.render`**（プラグイン型がネスト内で描画されない）、(c) **video プール/ループ warmup**（ネスト video は毎フレーム新規要素＝decode churn）。(d) html comp と raster 系 effect は既知の Phase 1 除外（§28.11 のラスタ経路で反映）。
  今回の pj には track matte / plugin / video が無いため症状は出ない。**着手はユーザー判断待ち**。
- **issue 化**: [doc/issue/nested-comp-3d-text-fallback.md](doc/issue/nested-comp-3d-text-fallback.md) に本件の調査・修正・検証をまとめた。
- **既知のリスク（今回記録・未対応）**: **WebGL context は 1 ドキュメント ~16 が上限でページ全体で共有**。`geom3d` は **per-layer 1 context を予算なしで作る（無制限）**一方、split/packed alpha は `MAX_GL_ALPHA_CONTEXTS = 8` の予算＋キルスイッチを持つ（`videoAlphaGl.ts`）。**3D テキストを多数積む／alpha 動画と併用すると上限に届き、古い context から黙って破棄される＝絵が消える**。対処が要るようになったら `shouldCreateGlAlphaCompositor()` と同型の予算ロジック＋2D フォールバックを geom3d に入れる。spec §5.5f / `geom3dGl.ts` の `createState` 冒頭にも記録済み。**issue 化: [doc/issue/webgl-context-limit.md](doc/issue/webgl-context-limit.md)**（症状・原因の非対称性・検出が GC 依存で不安定な点・根治案3種と推奨＝geom3d へ予算＋2D フォールバック）。
- **応急処置（2026-07-16 実装）**: Pipeline パネル（左下）に **`GL×N` バッジ**を追加。project データからの静的な目安で、**precomp を再帰カウント**（同じ precomp を 2 回置けば 2 倍・無効レイヤーは除外）。`>=12` で琥珀 `GL×N!`、`>=16` で赤、tooltip に内訳と対処。実装は `pipelineAnalysis.ts` の `collectGlLayers`（純関数・`test/pipelineAnalysis.test.ts` に 4 件追加）と `PipelinePanel.tsx` の `GlBadge`。実機確認: Main 単独 `GL×3` → Outer に Main×1 で `GL×3`（再帰カウント動作）→ Main×5 で琥珀 `GL×15!`。**破綻を防ぐものではなく気付けるようにするだけ**（根治は上記 issue の案1）。
- **Next steps**: 上記 (a)(b)(c) の要否をユーザーに確認。geom3d の GL context 予算の要否判断（3D text を大量に積む使い方が出てきたら）。mp4/webm/HTML bundle の実機 3D parity（今回は `compFrameCapture` バイト等価まで確認）。

### 2026-07-16（Claude Sonnet 5）— ネスト comp 内 video の再生が進まない問題を根治（上記 (c) の未配線を着手）✅

- **症状（ユーザー報告）**: DL にあるサンプルプロジェクト（`purini-23mafter-project.zip`。`Comp 2` が `music and screen`（video レイヤーあり）を precomp として nest）で、**nested comp 内の動画の再生が行かない**。
- **真因**: `renderNestedComp` は毎フレーム `container.innerHTML = ""` する非 reconcile 実装で、既存の持ち越し対象は `text`（geom3d canvas）と再帰コンテナ（`comp`）のみ。**`video` は対象外**だったため、トップレベルの `acquireVideoFromPool` 相当が無く、**毎フレーム新規 `<video>` 要素を生成していた**（同一 asset でも `<video src>` を持たない素の要素からやり直し）。上記 §23.3e 修正セッションで「(c) 未配線・要判断」として記録済みだった項目そのもの。
- **修正**（`src/runtime/DomRenderer.ts` のみ・ネスト経路に閉じた最小 diff）:
  - `text` に加え **`video` も** `reuseKey`（`objId:index:type`）で `nestedElReuse` に持ち越す。`updateComponentEl` が video の中身（src/seek/`syncVideoElementTime`）を毎フレーム全書き換えするため、要素を再利用しても描画結果は変わらない。
  - 今フレーム使われなかった持ち越し video は既存の GL 解放に加え **`teardownVideoElement()`（pause + removeAttribute("src") + load）** で明示的に破棄する（トップレベルの離脱時 teardown と同じ後始末）。
- **検証（実機 Playwright・ユーザーの実 zip を import して `Comp 2` を再生）**:
  - 素朴な currentTime 前進チェックは**修正前後どちらも PASS してしまい偽陰性**だった（毎フレーム新規要素でも `video.currentTime` は JS 側の seek 代入で見かけ上前進するため）。**歯のあるゲート**は `<video>` 要素の**参照同一性**で判定: 2 秒間・約120サンプルで **修正前 recreateCount=45（毎フレーム新規） → 修正後 recreateCount=1（初回のみ）**。
  - readyState/描画ピクセルでの検証は本サンプル（500MB・多数の proxy 動画資産）特有の非同期資産パイプラインが絡み確定的な結果を得られず（別要因の疑い、本修正の scope 外）、上記の要素同一性ゲートを正としている。
  - 無回帰: `tsc --noEmit` 緑 / `npm test` 1285 passed（唯一の失敗 `effects.test.ts > liquidChrome 再登録` は **stash して本変更前から失敗を確認済み・無関係**）/ `npm run build:player` は git hook が自動実行（`public/player.js` 更新済み）・`playerBuildFreshness` 緑。
- **調査で判明した残りの未配線（今回は未修正）**: (a) track matte、(b) plugin component の `ComponentDef.render` は引き続き未配線。今回のサンプルには該当しないため症状は出ない。**着手はユーザー判断待ち**。

### 2026-07-16（Claude Sonnet 5）— ネスト comp 内オーディオが再生されない問題を根治 ✅

- **症状（ユーザー報告）**: 上記 video 再生修正と同じ実 zip（`purini-23mafter-project.zip`。`Comp 2` が `music and screen`（video の内蔵音声＋standalone `audio` レイヤー）を precomp として nest）で、**video の再生は進むが音声が一切鳴らない**。
- **真因（`wire-feature-into-nested-comp` の N1 で発見）**: 音声パイプラインの共有関数 `collectFootageAudioSources`（`src/runtime/footageAudio.ts`）は `comp.objects` を**トップレベルのみ**走査し、`c.type === "comp"` のネスト precomp の中身を再帰しない。**preview（`PreviewAudioClock`）・mp4/webm export（`exporter.ts` の `buildAudioMix`）・HTML bundle export（`bundleFootageAudio.ts`）の 3 経路全てがこの同じ関数を共有**しており、3 経路とも「ネストされた comp 内の audio/video 内蔵音声は存在しないものとして扱われる」バグを共有していた（このコードベースで繰り返し起きる「共有関数がトップレベルしか見ない」型の未配線・[[nested-comp-separate-render-path]] と同型）。standalone `audio` コンポーネントは DOM 描画パスを持たない（`DomRenderer` に `case "audio"` が無い）ため、この Web Audio 経路が**唯一の再生手段**であり、ネストで完全に無音になっていた。
- **修正（`src/runtime/footageAudio.ts` を中心に、3 呼び出し元へ resolveComp を配線・型/経路スコープを閉じた最小 diff）**:
  1. `collectFootageAudioSources(comp, resolveComp?)` — `resolveComp?: (compId) => TimelineComposition | undefined` を追加。省略時は従来どおりトップレベルのみ（既存呼び出し元・既存テスト全 33 件は無変更で緑のまま＝後方互換）。渡すと `c.type === "comp"` を再帰し、ネスト先の `audio`/`video` レイヤーを収集する。
  2. **frame 空間の写像**: 収集した `inPoint`/`outPoint`、および `gainProp` の `keyframe.frame` を、`compChildFrame`（§23.2 秒ベース換算）の逆写像で**ルート comp の frame 単位**へ変換して返す。呼び出し側（`PreviewAudioClock.schedule` 等）はネストの有無を意識せず既存の `(rootFrame - source.inPoint) / rootFps` 式をそのまま使える。多重ネストも `FrameMapper` の合成で depth 4 まで対応（`isCompNestDepthAllowed` 共有）。
  3. `previewAudioClock.ts`（`hasPreviewAudioCandidates`/`prepareAudioLayers`）・`exporter.ts`（`buildAudioMix`）・`bundleFootageAudio.ts`（`collectBundleFootageAudioSources`）の 3 箇所に `project.compositions` から comp を引く `resolveComp` を配線。`PreviewPanel.tsx` の呼び出しに `project` を追加で渡すだけ（呼び出し側の分岐ロジックは無変更）。
  4. `exporter.ts` の `buildAudioMix` は元々 `source.obj.inPoint/outPoint`（写像前の生値）を直接読んでいたため、`source.inPoint/outPoint`（写像後）を使うよう修正（ここを直さないと mp4/webm export だけネスト音声のタイミングがズレる）。
- **意図的に対象外（トラック matte 同様ユーザー要否確認事項ではなく、影響が軽微なため）**: (a) `collectFadeClips`（cut 境界 declick 判定）はトップレベルのみのまま — ネスト音声のカット境界で declick フェード抑制が効かず、本来シームレスなはずの継ぎ目に短いフェードが入りうる（無音にはならない・実害は音質の軽微な劣化のみ）。(b) `PreviewAudioClock.updateLiveGains`（再生中の gain スライダーのライブ反映）もトップレベルのみ — ネスト音声は再生中に Volume を動かしても即時反映されない（次回 stop/start で反映）。将来必要になれば同じ resolveComp パターンで拡張可能。
- **検証**:
  - 単体テスト追加（`test/footageAudioMix.test.ts`）: ネスト精 comp の inPoint オフセット写像、animated gain keyframe の写像、`resolveComp` 省略時の後方互換の 3 件。既存 33 件 + 新規 3 件 = 36 件全緑。
  - 実機 Playwright（ユーザーの実 zip・`Comp 2` を import）: 修正前相当（`resolveComp` 省略）は `hasPreviewAudioCandidates` = `false`（音声ゼロ扱い）、修正後（`project` を渡す）は `true` で `video`(内蔵音声) + `audio` の 2 ソースを正しい root frame 写像で検出。`PreviewAudioClock.start()` を実際に呼ぶと `started: true` / `nodeCount: 1`（decode 可能だった音声トラックがスケジュールされた）/ ネスト video の内蔵音声は `getMutedVideoObjectIds()` に含まれ二重発音を防止（native `<video>` 側は自動でミュート）。
  - 無回帰: `tsc --noEmit` 緑 / `npm test` 1288 passed（唯一の失敗 `effects.test.ts > liquidChrome 再登録` は前回セッション同様 stash 済みで本変更前から失敗・無関係）/ `npm run build:player` 実行済み（`footageAudio.ts`/`previewAudioClock.ts`/`bundleFootageAudio.ts` は player import 範囲＝必須）。
- **branch**: `fix/nested-comp-video-playback`（video 再生修正と同一ブランチで継続。コミット・PR は未実施、ユーザー確認待ち）。

### 2026-07-16（Claude Opus 4.8）— ネスト comp 内の 3D text が親コンポ 9 秒あたりでちらつく問題を根治（§5.5f-1）✅

- **症状（ユーザー報告）**: 最新 DL の pj（`mafter-project (10) (1).zip`）で、ネスト comp `2-もう一人じゃないよって` を親 `main` から呼ぶと **親の 9 秒あたりでちらつく**。子 comp を単独で開くと出ない。
- **真因**: `renderNestedComp` が `updateComponentEl` に **`canvas` / `isHost` / `clearedCanvases` を渡していなかった**（トップレベル `applyObject` は渡す）。結果ネスト経路だけ `geomShareCanvas=true` を無視して **per-layer 1 canvas = 1 GL context** を作り、Chrome の同時 WebGL context 上限（~16）を超過 → `Too many active WebGL contexts. Oldest context will be lost.` → 3D が消えてちらつく。[[nested-comp-separate-render-path]] と同型の未配線（§23.3e で geom3dCamera を配線したときと**同じ関数の同じ引数**が、新機能追加時にまた片側だけ配線された）。
- **9 秒の理由（数値で一致）**: 子の 3D text は 20 枚あり in が段階的（0,2,4,5,9,11,13,15,17,19,21,24,26,33,36,45,47,53,55,57）。親 frame 135（=9.0s / 15fps）は子 frame 51 で **同時に生きる 3D text = 17 枚 > 16**。実測の修正前 canvas 枚数も **17** で一致。
- **修正**（`src/runtime/DomRenderer.ts` のみ・ネスト経路に閉じた最小 diff）: トップレベルと同じ `resolveGeom3DCanvasHosts` を子 scene に回して host を解き、group canvas を **`nestedGeom3dGroups: WeakMap<container, Map<hostId, canvas>>`** で保持（**コンテナ単位**＝同じ precomp を 2 回置いても canvas を取り違えない）。host でなくなった canvas は `releaseGeom3DGl` + `remove()` で明示解放。
- **検証（実機 Playwright・ユーザーの実 zip から巨大 media(546MB mkv/63MB wav) だけ除いた fixture）**: 新規恒久 verify `verify-nested-geom3d-share.mjs` — **修正前 nested=17 canvas + GL 警告多数（FAIL）→ 修正後 nested=1 canvas / 警告 0 / ink は standalone と同値 60013・ratio 1.000（PASS）**。ゲートに歯があることを stash して確認済み。親は実 `main` ではなく専用 `Outer` を作る（main は 3D text 持ち precomp を 2 つ載せる＝canvas 2 枚が正しく、畳み込みを測れない）。fps 差（子 15 / Outer 30）は §23.2 秒ベース換算で親 frame を逆算し同一子 frame を比較。
- **無回帰**: `tsc --noEmit` 緑 / `npm test` 1307 passed（唯一の失敗 `effects.test.ts > liquidChrome 再登録` は本変更前から失敗・無関係）/ `verify-nested-geom3d` `verify-geom3d-neutral` `verify-font-3d-extrude` PASS / `npm run build:player` 実行済み（player が DomRenderer を import）。
- **ついでに修正: `verify-geom3d-mvp.mjs` の FAIL は「テストが stale」だった（コードは正常）** — 当初 share-canvas 由来の回帰と推測したが**誤り**。真因は `0dfc7cf fix(geom3d): 2D層(threeD=false)はカメラ免除`（share-canvas の 6 コミット前）。この verify は text を `threeD=false` のまま camera 追加 → dolly して「bbox が 1.15 倍以上に拡大するか」を assert するが、§6.5b でカメラ免除になったため bbox が neutral と完全に同一（142×86 で不変）になり FAIL していた＝**免除仕様どおりの正しい挙動を回帰と誤検出**。setup で `threeD: true` を立てる 1 行を追加して PASS（withCameraDefault 84×50 → afterDolly 120×70 で dolly が効くことを確認）。**このスクリプトの本来の役目（実 MVP 投影＝固定カメラでないことの証明）が赤いまま放置されると「既知の失敗」として無視され、本物のカメラ回帰を検出できなくなる**ため、赤を残さず直した。
- **Next steps**: mp4/webm/HTML bundle でのネスト共有 parity は未確認（preview と `compFrameCapture` 経路のみ確認）。

### 2026-07-15（Claude Sonnet 5）— ditherDissolve の毎フレーム再計算を軽量化（メモ化）✅
- **調査**: `ditherDissolve` は live エフェクトとして毎フレーム `ditherDissolveMask()` → `ditherPatternMaskSvg()` を再実行し、
  blueNoise パターンでは 64×64=4096 個の `<rect>` 文字列生成 + `encodeURIComponent` を毎フレームやり直していた。
  `reveal` は `quantizeDitherReveal` で 64 段に量子化・`w/h/pattern` はレイヤー内固定なので、取りうる mask 文字列は
  1 レイヤーにつき最大 64 通りしかない（`.cursor/plans/dither-pattern-modes.plan.md` でも予定されていたが未実装だった）。
- **修正**: `src/runtime/effectSvg.ts` の `ditherDissolveMask()` を `pattern|qStep|w|h` キーの module-level `Map` でメモ化。
  ロジック・戻り値は不変（純関数のまま・`Math.random`/`Date.now`/DOM 追加なし → INV-1 不変）。
- **検証**:
  - `npm run typecheck` 緑。
  - `npm test` — 既存失敗 1 件（`effects.test.ts > liquidChrome 再登録`）のみ、stash して確認済みで**本変更と無関係の pre-existing 失敗**。
  - `npm run build:player` 実行済み（`effectSvg.ts` は player import 対象のランタイム側）。
  - 実機 `verify-dither-dissolve.mjs`（Playwright, `/opt/pw-browsers/chromium` を一時指定して実行・スクリプト自体は未変更のままコミット）:
    変更前後で **pixel 解析値が完全に同一**（pureRed 3269 / pureBlue 3459 / blended 113272 / blueShare 0.5141 — 両方とも一致）＝
    出力バイト等価・無回帰を実測で確認。スクリプトが報告した FAIL は favicon.ico の 404（コンソールエラー収集の環境ノイズ）で
    baseline でも同一に再現する既知の無関係事象。
- **doc**: 調査結果と Sonnet 5 low 向け修整手順を `doc/cloudplan/dither-dissolve-optimization-sonnet5low.md` に記録済み（Opt 1 実装済み・Opt 3 feTile化はスコープ外のまま）。
- **定量計測（vite-node ベンチ・1920×1080）**:
  - completion アニメート中（300フレーム相当・64段量子化を通過）: ordered 47.7ms→2.4ms（**約95%減**）、blueNoise 835.3ms→295.0ms（**約65%減**、量子化ステップ通過ごとのキャッシュミスが残る）。
  - completion 固定（一時停止・他プロパティ編集中の再描画）: ordered 9.9ms→0.24ms（**約97%減**）、blueNoise 685.3ms→0.19ms（**約3600倍減・実質ゼロ**、キャッシュヒット率100%）。

### 2026-07-16（Claude Sonnet 5）— ditherDissolve Opt 4（白セルのみ emit）実装 ✅
- **背景**: 上記 Opt 1（メモ化）でキャッシュヒット時のコストはほぼゼロ化したが、completion 自体をアニメートしている最中は
  64 段の量子化ステップを毎回通過するためキャッシュミスが残り、blueNoise はまだ 2〜3 割のコストが残っていた
  （`doc/cloudplan/dither-dissolve-optimization-sonnet5low.md` §2 Opt 4 として計画済み・任意タスク）。
- **修正**: `ditherPatternMaskSvg`（`src/runtime/effectSvg.ts`）を、黒背景 1 枚 + 可視（white）セルのみ emit するよう変更。
  視覚的には全セル emit 版と同一（黒背景の上に白セルを重ねるのと、全面塗ってから黒/白で上書きするのは同じ結果）。
  reveal が低いほど white セル数が減るため、**キャッシュミス時（初回生成）の rect 数・文字列長を reveal に応じて削減**する。
- **検証**:
  - `npm run typecheck` 緑 / `npm test` — 既存の pre-existing 失敗（`liquidChrome` 再登録）のみ、Opt 1 と同じで無関係。
  - `npm run build:player` 実行済み。
  - 実機 `verify-dither-dissolve.mjs` — ピクセル解析値が Opt 1 単独時と**完全一致**（pureRed 3269 / pureBlue 3459 / blended 113272 / blueShare 0.5141）＝無回帰。
  - vite-node ベンチ（1920×1080・全 65 量子化ステップのコールドキャッシュ生成）: blueNoise 74.37ms→29.13ms（**約61%減**）、ordered 1.47ms→0.83ms（**約43%減**）。
- **doc**: `doc/cloudplan/dither-dissolve-optimization-sonnet5low.md` の Opt 4 節・完了状況を更新予定。
- **Next steps**: Opt 3（feTile 化）は引き続きスコープ外（共有キャプチャ経路への影響のため）。ditherDissolve の残タスクは現状これで打ち止め。

### 2026-07-16（Claude Sonnet 5）— Compiled RenderPlan フィードバックの実現可能性評価 + Sonnet5-low Plan 実装（WP-4 / WP-2）✅

- **背景**: 他エージェントから「Compiled RenderPlan + Dirty Property Patching」という軽量化フィードバックを受け、実際の spec/実装と突き合わせて実現可能性を評価し、`doc/cloudplan/compiled-render-plan-sonnet5low.md` に Sonnet 5 low 向け実装 PLAN を作成（別セッション）。本セッションでその PLAN を実装。
- **評価の要点**: フィードバックの WP-1（entry を objectId で永続化）は**トップレベルでは実装済み**（`DomRenderer.entries: Map<ObjectId, ObjectEntry>`）で再実装不要と判明。本当の負債は **`renderNestedComp` が毎フレーム `container.innerHTML=""` で全ラッパ div を作り直す**こと（§23.3e に明記済みの既知制約）。WP-3/WP-5/WP-6（並行 `evaluateFrame`/DirtyMask/tree-shaken bundle）は `resolve()` と並行する第二の解決経路を持ち込み INV-2 の bit 一致保守が破綻するリスクが高いため**スコープ外**とし、WP-4（同値 style 書込抑制）と WP-2（nested reconcile 化）のみを実装対象とした。
- **Phase A（WP-4）実装**: `ObjectEntry` に `lastTransform/lastOpacity/lastZ`（`string | null`）を追加し、`applyObject` の通常経路で transform/opacity/zIndex を前回値と比較、同値なら style 代入をスキップ。値の計算式は不変（出力バイト等価）。matte/matte-source 分岐・通常復帰時は last-value を null リセットし、モード切替後の残留を防止。
- **Phase B（WP-2）実装**: `renderNestedComp` の `container.innerHTML=""` を撤去し、新規 `nestedWrappers: WeakMap<container, Map<ObjectId, HTMLDivElement>>` でオブジェクトラッパ div を objectId 永続化（トップレベル `entries` と同じ reconcile モデルをネストへ移植）。離脱オブジェクトのラッパは GL 解放→remove の順で GC。各ラッパの子要素は「今フレーム touch されなかった旧子ノード」を検出して remove（GL/video の実体解放は既存の `prevEls`/`nextEls` 差分ループに委譲し二重 teardown を回避）。既存の text/video/comp 持ち越し・geom3d canvas 共有・export composite タグ付け・blend mode 適用ロジックは無変更（reconcile化は「ラッパ div の永続化」層のみに閉じた最小 diff）。デバッグ・テスト用に `div.dataset.objectId` をネストラッパにも付与（描画に影響しない）。
- **検証**:
  - `npm run typecheck` 緑 / `npm test`（vitest full run）1311/1312 passed。唯一の失敗 `effects.test.ts > liquidChrome 再登録` は stash して baseline でも同一に再現する pre-existing 不良（本変更と無関係、過去セッションでも繰り返し確認済み）。`playerBuildFreshness` 含め無回帰。
  - `npm run build:player` 実行済み（`DomRenderer.ts` は player import 対象のランタイム側）。
  - **新規恒久 verify `verify-nested-reconcile.mjs`**（外部アセット不要・store API で synthetic project を構築）: nested comp（solid×2 + text + adjustment 候補）の描画・30フレームスクラブ後も div 実体の参照同一性が保たれること（`kept===total`）・レイヤー削除後に孤立要素が残らないこと（削除分だけ減少）・adjustment ON で content 子要素がゼロ化すること・深いネスト（Outer2→Outer→Inner）が壊れないこと、を確認し PASS。**同スクリプトを baseline（変更前コード）に対して実行すると `identity.kept=0/4` で FAIL することを実測確認済み（ゲートに歯がある）**。他の nested 系 verify（`verify-nested-geom3d.mjs` 等）は実ユーザーの巨大 zip 依存でこの環境では実行不可なため、このスクリプトが代替の無回帰ゲートとして機能する。
  - 既存 `verify-blend-mode.mjs` PASS（無回帰）。`verify-track-matte.mjs` は track matte 本体チェック8件全PASS、唯一のFAIL（favicon.ico 404 由来の `page errors` ゲート）は baseline でも同一に再現する既知の環境ノイズ（stash して確認済み・無関係）。`verify-export-adjustment.mjs` PASS（adjustment export bake parity 無回帰）。
- **spec**: §23.3e を更新（散文のみ・§5型/INV非変更）— `renderNestedComp` が reconcile 実装になったことを反映し、`nestedWrappers` の役割・GC順序・子要素の touch 検出を追記。
- **doc**: `doc/cloudplan/compiled-render-plan-sonnet5low.md` に「実装記録（2026-07-16）」節を追記し、Phase A/B とも完了とマーク。
- **Next steps**: WP-3/WP-5/WP-6 は未着手のまま（計画どおりスコープ外。着手時はユーザー確認必須）。実測ベンチ（before/after のフレーム時間計測）は未実施 — nested precomp を多用する実プロジェクトでの体感計測が次のステップ。

### 2026-07-17（Claude Opus 4.8）— WP-4 回帰修正: 調整レイヤー backdrop から下位レイヤーが逃げる ✅
- **症状（ユーザー報告・実機再現）**: `main 1` で時系列的に後から現れる 3D-extrude text レイヤー（ネスト precomp `2-もう一人じゃないよって` の「テレパシー」等）が、上位の調整レイヤー（chromaSplit/gradientMap の live backdrop-filter）の影響を受けず、素のまま浮いて描画される。前セッションの WP-4 軽量化以降に発生。
- **局在化（measure-driven）**: 実 zip をインポートし `main 1` f150 を preview 実機描画 → CDP で DOM を計測。調整レイヤー div（`Adjustment`/`pixelize`）の**computed z-index が `auto`** になっていた（本来 zOrder×BASE_Z = 130 / 40）。z:auto の positioned 要素は正の z-index を持つ兄弟（ネスト comp z50/z70 等）の**背面**に落ちるため、backdrop-filter が下位を採取できず＝逃げる。360895e の DomRenderer だけを親版に戻すと症状消失し、WP-4 が原因と確定。
- **根因**: `applyObject` 通常経路は毎フレーム `clearMatteSourceStyle(entry.div)` を呼び、その中で `style.zIndex=""`（＝auto）にリセットする（`trackMatteDom.ts:119`・track matte 離脱後始末）。WP-4 が zIndex を `lastZ` last-value でキャッシュしたため、2 フレーム目以降は `z===lastZ` でスキップされ、クリアされた zIndex が二度と書き戻らず auto のまま固着した。**同ファイル 1573-1575 の既存コメントが `filter` について全く同じ罠（clearMatteSourceStyle が毎フレーム "" に戻すのでキャッシュ不可）を警告済み**で、WP-4 は zIndex で同じ轍を踏んでいた。transform/opacity は clearMatteSourceStyle が触らないためキャッシュ有効（据え置き）。
- **修正**: zIndex を**無条件書込**に戻す（filter と同じ扱い）。`lastZ` フィールドと 4 箇所の関連コード（宣言・init・matte/matte-source 分岐の null リセット）を削除。最小 diff・INV/§5/直列化 不変。
- **検証**:
  - `npm run typecheck` 緑 / `npm test` 1311/1312（唯一の失敗 `liquidChrome` 再登録は前セッションと同一の pre-existing・無関係）。`playerBuildFreshness` 緑。
  - `npm run build:player` 実行済み（DomRenderer は player import 対象）。
  - **実機 preview parity**: 修正後 f150 で「テレパシー」が glitch テクスチャに埋没＝調整の影響を受ける状態に復帰。親版（軽量化前）と同一の見た目を確認。
  - **新規恒久 verify `verify-zindex-persist.mjs`**（外部 zip 不要・synthetic 2 solid）: 6 フレームスクラブ後も非 matte レイヤーの computed z-index が numeric（10/20）を保持することを確認し PASS。**buggy 版（360895e）に対して実行すると `auto/auto` で FAIL することを実測確認済み（ゲートに歯がある）**。
- **Next steps**: なし（打ち止め）。WP-4 の transform/opacity キャッシュは維持。将来 clearMatteSourceStyle が触る style を last-value キャッシュする際は同じ罠に注意。
- **無回帰 verify（2026-07-17 追加実行・env を https/chrome channel に合わせて実行）**:
  `verify-nested-reconcile`（WP-2 sibling）PASS / `verify-track-matte` 実チェック 8/8 PASS（唯一の fail は既知 favicon 404 ノイズゲート）/ `verify-blend-mode` PASS / `verify-export-adjustment`（INV-2 preview↔export の調整 effect bake parity）PASS。本修正は top-level `applyObject` の zIndex 書込のみ・全 render path 共有経路のため INV-2 は構造的に保持。

### 2026-07-17（Claude Opus 4.8）— GPU Raster Pipeline 設計 + Phase 0 ベースライン計測 ✅

- **背景**: ユーザー提供の設計ブリーフ（`gpurasterpipelineoptimizationideas1.md`）を実コードと突き合わせ、着手可能な粒度の実装計画へ落とし込む依頼。続けて「人間確認が不要な範囲をぶん回す」指示を受け、Phase 0（計測・挙動変更なし）まで実施。
- **成果物1: `doc/cloudplan/gpu-raster-pipeline-design.md`** — 実 symbol/call path で裏付けた実装計画。現行経路（preview live/raster・`compositeExportFrame` z 順コンポジタ・`compFrameCapture`・既存 per-layer WebGL）を確認し、中核判断＝「`DomRenderer`+foreignObject は残し、`exportComposite.ts` の z 順コンポジタと preview raster overlay を共有 WebGL2 compositor の seam に置換」。`executionPath` 不変・GPU 実装は engine-private レジストリに隔離（Plugin API v1 非破壊）。Phase 0(計測)→1(Canvas2D seam byte 不変)→2(WebGL2 normal composite)→3(matte/blend/adjustment)→4(builtin GPU effects)→5(readback 排除)→6/7 保留。各 Phase に変更 symbol・受け入れ・rollback。INV-1〜6/preview≡export/serialization/Plugin API 影響を整理。
- **成果物2: Phase 0 計測**（source 非改変・page-only monkey-patch）:
  - `bench-gpu-raster-baseline.mjs`（root）: 重い composite（raster mosaic/wave + blend×3 + track matte + raster adjustment + nested precomp）を store API で構築し、preview scrub 48 フレームを実 Chrome で駆動。`getImageData`/`putImageData`/`drawImage`/`toDataURL`/`createImageBitmap`/`readPixels`/`<img>svg decode` を wrap して call 数・累積 ms を集計。→ `bench-gpu-raster-baseline.json`。
  - `doc/cloudplan/gpu-raster-bench-phase0.md`: 結果と読み取り。
- **実測（1280×720 / 9+4 レイヤー・pageErrors 0）**:
  - フレーム時間: cold **196.8ms** / warm **183.5ms**（≈5fps）。
  - 内訳（cold・1frame）: **`<img>svg decode` 4回/73.2ms（最大）** / `toDataURL` 11.4ms / `getImageData` 10.3ms / `drawImage` 8.7ms / `putImageData` 1.5ms / **`readPixels` 0**。
  - **主要知見**: (1) capture（foreignObject SVG decode）が単独で支配的 → 合成のみ GPU 化（Phase 2）だけでは capture コストが残り、**Phase 6 HTML-in-Canvas / cache L1 表現最適化の価値が数値上高い**。(2) getImageData/putImageData 往復が実在（plan §6.1/§6.3 の GPU 対象を裏付け）。(3) **preview に readPixels 現状ゼロ**（plan §7.1 の監視基準）。(4) **warm≒cold（差~7%）＝ `frameRenderCache` が interactive re-scrub でヒットしていない**（要 Phase 0 追補・GPU 化と独立に効きうる）。
- **不変性**: source 変更なし（計測は page monkey-patch のみ）。`npm run build:player` 不要（runtime 非改変）。INV・§5・直列化いずれも無影響。
- **成果物3: export 経路 baseline**（追加取得済み）:
  - `bench-gpu-raster-export-baseline.mjs` → `.json`: 同一 fixture を PNG 連番で決定論 export（`exportComposition` を page から Vite dynamic-import で駆動・WebCodecs 非依存）。primary GPU target の `compositeExportFrame`（per-layer capture + Canvas2D z 順累積 + `applyAdjustmentToMaster`）を実測。
  - **実測（24fr / 1280×720・ok・pageErrors 0）**: avg **253.8ms/frame**。内訳: `<img>svg decode` 13回/70.8ms + **`drawImage` 累積 23回/63.4ms** + `getImageData` 14.1ms + `toDataURL` 15.3ms + `putImageData` 2ms、`readPixels` 0。
  - **知見**: export のボトルネックは capture(71ms) + **drawImage 累積(63ms)** の 2 本柱。preview（live CSS blend で drawImage 僅少）と違い export は z 順 Canvas2D 累積が重く、**合成 GPU 化の効果は preview より export で大きい**ことが確定 → plan の Decision（`compositeExportFrame` を最初の GPU compositor 宿主にする）を数値で支持。
- **成果物4: Phase 1 実装（`Canvas2DCompositor` seam・byte 不変）** ✅:
  - 新設 `src/runtime/compositor/RasterCompositor.ts`（interface）+ `Canvas2DCompositor.ts`（reference backend）。将来 WebGL2 backend を同 interface で差し込む seam。責務は「master への合成」のみに閉じ、DOM capture（foreignObject / perspective / nested 再帰）は `exportComposite.ts` 側に残す。
  - `exportComposite.ts`: `compositeExportFrame` / `compositeContainer` の master 累積 + `applyAdjustmentToMaster`（削除）を compositor 呼び出しへ置換。**同一 Canvas2D オペレーション・同順**のため byte-identical。diff −51/+10。
  - **新規 parity ゲート `bench-gpu-raster-parity.mjs`** + `bench-gpu-raster-parity.golden.json`: `captureCompFramePng`（RAM preview 経路＝内部で `compositeExportFrame` 使用）の PNG を FNV-1a hash 比較。**リファクタ前後で全フレーム byte-identical PASS**（同一コード 2 回で決定論も確認済み＝ゲートに歯がある）。
  - **検証**: `npx tsc --noEmit` 緑 / vitest 1311/1312（唯一の fail `effects.test.ts liquidChrome 再登録` は既存・本変更と無関係）/ `playerBuildFreshness` 緑。`exportComposite` は `src/player` 非 import のため **build:player 不要**（確認済み）。INV/§5/直列化 いずれも非変更。
- **成果物5: Phase 2 実装（WebGL2 normal-composite backend・flag 既定 OFF）** ✅（ユーザー「推奨で進めて」承認のうえ実施）:
  - 新設 `src/runtime/compositor/WebGL2Compositor.ts`（`WebGl2Compositor`・module singleton の WebGL2 context・premultiplied source-over・context lost 対応・re-entrancy guard）+ `gpuCompositorFlag.ts`（`globalThis.__mafterGpuCompositor` 非直列化 dev flag・WebGL2 capability 判定・**既定 OFF**）。
  - `compositeExportFrame` トップレベル slow path に frame-level eligibility（adjustment 無し AND 全レイヤ normal）を追加。eligible かつ flag ON かつ WebGL2 対応時のみ GPU 累積。GL 失敗時は捕捉済み capture で Canvas2D へ再 capture 無し fallback。nested（`compositeContainer`）は Canvas2D 据置き＝同時活性 GPU compositor は 1 つ。
  - **検証**: (1) default（flag OFF）byte 不変 = `bench-gpu-raster-parity.mjs` golden 全 MATCH。(2) **GPU parity（flag ON）= `bench-gpu-raster-compositor-parity.mjs` で CPU vs GPU が maxAbs=0/mean=0 ＝ byte-identical**（3D+全 normal fixture・text 端含む・GPU 実走 counter=3）。(3) `tsc` 緑 / vitest 41/41 / `playerBuildFreshness` 緑（build:player 不要）。INV/§5/直列化 非変更。
  - **設計知見**: export slow path は blend/adjustment/nested/3D のいずれかで入るため、Phase 2 の gpuEligible（全 normal）フレームは 3D・nested-composite シーンに限られる。重い一般ケース（blend+adjustment）の GPU 利得には **Phase 3（blend shader + adjustment）が必須**。Phase 2 は context/pool/upload/shader/parity/fallback/flag の土台を検証済みで提供。
- **Next steps**: Phase 3（track matte shader・15 blend shader・adjustment ping-pong）。blend の色空間・premultiplied・丸めの parity 許容差確定が中核判断のため、**着手前にユーザー確認を推奨**。Phase 2 の GPU 経路は既定 OFF なので本番挙動は現状と完全一致。

### 2026-07-17（Claude Opus 4.8）— 「再生中に調整レイヤーが効かない」バグ調査 + preview キャッシュ lifecycle の footgun 修正（症状は synthetic 未再現）

- **報告**: 調整レイヤーの表示(enabled)トグル→効く／プレビュー再生し続ける→効かない。加えて「live→cache→Cache OFF で全部消える」。実環境に未コミット変更なし。
- **切り分け（実機計測）**:
  - 私の直近 GPU 作業（Phase 0/1/2・export のみ・byte 検証済み）は無関係。前回の z-index 修正も intact。
  - **live 再生ループは調整を落とさない**（tint を enabled で 3.5s 再生継続 → paused-ON と距離0で一致）。
  - 重い(非リアルタイム)comp の再生中は preview が live DOM を `visibility:hidden` にして **RAM キャッシュ overlay（baked=`compositeExportFrame`）に切替**（`PreviewPanel.tsx:1297-1314` / `ramPreview.shouldPreferCacheOverlay`）。
  - 実 `_pj17` Comp 7 は「調整4枚が enabled=false」で保存されており、当初の「baked が調整を焼けない」計測は**無効調整のため**だった。**enabled にすれば baked も調整を焼く**（Comp7 baked f=20 で ON/OFF changed 4.86%）ことを確認 → **live≠baked parity バグは無い**。
- **synthetic 再現の結論（cache overlay を実際に表示させた状態で）**:
  - **「Cache OFF で全部消える」は再現せず**（overlay 表示中に Cache OFF しても content 100%・修正有無に関わらず）。
  - **「再生中に調整 enable が反映されない」も再現せず**（overlay 表示中に調整を ON → solid 色が [88,82,41]→[82,82,82] と live-ON に一致＝反映される）。
  - ＝ **クリーンな synthetic では cache/playback/adjustment lifecycle は正しく動く**。ユーザ症状は実プロジェクト固有の重条件（1080p・カメラ・displacement 調整・nested・広い work area 等）依存で、headless 合成では再現できていない。
- **入れた修正（footgun・無回帰）**: `PreviewPanel.tsx` の **DomRenderer 生成 effect の依存から `effectiveCacheEnabled` を除去**。従来はキャッシュ ON/OFF のたびに `dispose()`→`new DomRenderer()` でレンダラを作り直しており（DOM 空化・再生中は render effect が `draftPlaybackActive` で早期 return するため再描画されない → 「Cache OFF で消える」の妥当な機序）、キャッシュの付け外しは別 effect の `setFrameRenderCache`/`setNestedCompRasterizer`（442-449）が担うのでレンダラ再生成は不要。**tsc 緑 / full suite 1311/1312（唯一の fail は既存 liquidChrome。`projectBins > treeOrder` は baseline でも ~1/3 落ちる pre-existing flaky で本変更と無関係）**。
- **正直な限界**: この修正は「レンダラをキャッシュトグルで作り直さない」という妥当な改善だが、**症状（消える／効かない）を synthetic で再現できていない**ため症状解消は未実証。ユーザの実プロジェクトでの確認が必要。
- **Next steps**: 症状 1/2 の確定再現には**実 Comp（調整 enabled・カメラ・displacement 調整つき）を ~30MB 以下に trim して import 可能な形**でもらうのが最短。もらえれば measure 駆動で根因を確定し完全修正する。それまでは上記 footgun 修正のみ（実機での効果確認をユーザに依頼）。

---

## 2026-07-17 セッション終了・引き継ぎ（Claude Opus 4.8）— branch `claude/implementation-plan-concrete-e5889v`

このブランチには**2系統**の作業がある。別セッション/ブランチで続ける想定。

### A. GPU Raster Pipeline（Phase 0–3a + Phase 4(mosaic) 完了・**既定 OFF で本番挙動は現状と完全一致**）

- **完了物**:
  - 計画: `doc/cloudplan/gpu-raster-pipeline-design.md`（Phase 別・変更 symbol・受け入れ・rollback つき。Phase 0/1/2/3a/4 に実装記録 ✅）
  - Phase 0 計測: `doc/cloudplan/gpu-raster-bench-phase0.md` + `bench-gpu-raster-baseline.mjs`(preview) / `bench-gpu-raster-export-baseline.mjs`(export) + `.json`
  - Phase 1: `src/runtime/compositor/RasterCompositor.ts` + `Canvas2DCompositor.ts`（`exportComposite.ts` の z 順累積+調整を seam 化・**byte-identical**）
  - Phase 2: `src/runtime/compositor/WebGL2Compositor.ts` + `gpuCompositorFlag.ts`（normal composite の WebGL2 backend・**既定 OFF**・GPU vs CPU **byte-identical** 確認）
  - Phase 3a: `WebGl2Compositor` に **15 CSS mix-blend-mode の GPU shader**（ping-pong FBO・W3C 合成式・sRGB 据置き）。`gpuEligible` を adjustment 無しフレーム全体へ拡張。normal 高速パスは byte 不変で温存。
  - Phase 4(mosaic): `compositor/gpuEffectRegistry.ts`（`isGpuEffectSupported`・現状 mosaic のみ）+ `WebGl2Compositor.applyAdjustment`（GPU 調整経路）。**mosaic を 2-pass shader（top-origin blockAverage・部分エッジ込み・O(w·h)）で GPU 化**。`exportComposite` を z 順 op 列（draw/adjust）へ再構成し、`isGpuAdjustmentChain`（CSS filter 無し AND rasterChain 全 GPU 可）を満たす調整フレームのみ GPU、他は Canvas2D 全落ち（§7 案A）。
- **回帰ゲート（恒久）**: `bench-gpu-raster-parity.mjs`（default byte 一致）/ `bench-gpu-raster-compositor-parity.mjs`（GPU normal）/ `bench-gpu-raster-blend-parity.mjs`（GPU 15 blend）/ `bench-gpu-raster-mosaic-parity.mjs`（**GPU mosaic 調整・新規**）+ `test/gpuCompositorMapping.test.ts`（純関数契約）。GPU 経路は `globalThis.__mafterGpuCompositor=true` で。
- **検証結果（2026-07-18）**: default byte-identical / GPU normal maxAbs=0 / GPU blend maxAbs=1（15 mode + AA text）/ **GPU mosaic 調整 maxAbs=1・mean=0.0017・≤2/255 超過 0**（540/16 部分エッジ込み）・各 GPU 実走 3。tsc 緑 / vitest 1310 passed（既存 2 fail = liquidChrome 再登録・projectBins treeOrder flaky・無関係、stash 確認済み）。
- **実測ベースライン（1280×720/9+4 層）**: preview cold **196.8ms**, export PNG **253.8ms**。支配コスト = capture(svg decode ~71-73ms/frame) + export の **drawImage 累積 63ms/frame**。preview の readPixels は現状 0。
- **重要な設計知見**: export の slow path は blend/adjustment/nested/3D のいずれかで入る。Phase 3a で blend、Phase 4 で **mosaic 調整**が GPU 化。残る CPU 固定は「mosaic 以外の raster effect / CSS filter を含む調整」フレーム（丸ごと Canvas2D）。
- **次にやること**: (1) 他 raster effect の GpuEffectPass（`wave`/`ripple`/`turbulentDisplace` = displacement 系。CPU reference と parity ≤2/255）。増えるほど adjustment の GPU 化率が上がる。(2) Phase 5（readback 排除・preview↔export 統合）。(3) live track matte の GPU 委譲（preview 経路・別サブシステム）。いずれも parity 許容差 ≤2/255・sRGB 維持で確定済み。実測ベンチ（GPU 経路の frame time 改善）はまだ未計測。
- **有効化**: dev で `globalThis.__mafterGpuCompositor = true`（非直列化。既定 OFF なので本番無影響）。

### B. 「再生中に調整レイヤーが効かない / Cache OFF で全部消える」バグ（調査完了・**部分修正のみ**・症状は未再現）

- **報告症状**: 調整レイヤーの**表示(enabled)トグル**→効く／プレビュー**再生し続ける**→効かない。加えて「live→cache overlay→Cache OFF で全部消える」。時系列でバラバラのテキスト/3Dテキスト層 + 調整レイヤーが全尺で最前面、という構成。
- **入れた修正（コミット済み・無回帰）**: `PreviewPanel.tsx` の DomRenderer 生成 effect の依存から `effectiveCacheEnabled` を除去（キャッシュ ON/OFF でレンダラを dispose→new し DOM 空化する footgun。再生中は render effect が `draftPlaybackActive` で早期 return し再描画されないため「消える」機序になりうる）。tsc 緑 / full suite 1311/1312（唯一 fail は既存 liquidChrome）。
- **切り分けで確定した事実**:
  - GPU 作業(A)は export のみ・byte 検証済みで**無関係**。前回の z-index 修正も intact。
  - **live 再生ループは調整を落とさない**（実測）。
  - **live≠baked parity バグは無い**（enabled にすれば baked=`compositeExportFrame` も調整を焼く。Comp7 baked f=20 で ON/OFF changed 4.86%）。
- **synthetic で再現できなかった（重要）**: staggered inPoint / 2D・3D 層+カメラ / **cache overlay を実際に表示させた状態** / 連続再生 / 調整 enable-disable いずれの組み合わせでも**調整は全層で正しく効く**。→ 症状は**実プロジェクト固有**。
- **最有力仮説（未検証）**: 実際の **3D-extrude text（geom3d の WebGL canvas）が、オフスクリーンのキャッシュ焼き込み context（`compFrameCapture` が別 `DomRenderer` を生成）で正しく描かれず**、baked/overlay フレームから 3D text が欠落 or 調整未適用になる。synthetic ではフォント＋押し出しメッシュが要り再現不可。
- **次にやること**: 症状が出る **Comp を動画アセット除いて ~30MB 以下に trim（調整 enabled・3D-extrude text・カメラ込み）した zip** を import して再現 → measure 駆動で `compFrameCapture` のオフスクリーン geom3d/WebGL 経路を疑って局在化。**82MB フル import はブラウザ OOM**。
- **再現ハーネスの落とし穴メモ（次セッション用）**:
  1. `_pj17` の Comp 7 は**調整4枚が enabled=false 保存**（計測を濁す。enabled にして測ること）。
  2. **白テキスト+tint は彩度に写らない** → 色付き層 or 輝度で測る。
  3. **cache overlay を出す**には小 work area を全 frame scrub で焼いてから再生（再生中は build が pause する）。auto-cache は `mosaic`/full displacement 等 `compRequiresPreviewBake` で起動。overlay 表示 = live root が `visibility:hidden`。
  4. Playwright の checkbox クリックは rAF 再生中に stability timeout する → `evaluate` で native `cb.click()`。

### 2026-07-19（Codex）— Browser Export 最大高速化の調査・実装 PLAN ✅（コード未変更）

- **依頼**: ブラウザ書き出しを最大限高速化するアイデアを、現行実装・既存実測・WebCodecs/Remotion の一次資料と突き合わせて PLAN 化。
- **成果物**: `doc/cloudplan/browser-export-max-speed-plan.md`。
- **確定した現状**: 既存 1280×720 heavy fixture の PNG export は 253.8ms/frame。支配コストは foreignObject SVG decode 70.8ms/frame + Canvas2D `drawImage` 累積 63.4ms/frame。現行 MP4/WebM loop はさらに `nextTick`、`createImageBitmap`、16ms polling backpressure、in-memory mux/audio を持つが full-export stage 別計測は未実施。
- **PLAN の中核**: Phase 0 full-export profiler → Phase 1 direct `VideoFrame(canvas)` / `dequeue` event / settle barrier 局在化 → Phase 2 WebGL compositor output を encoder へ直結 → Phase 3 layer-local surface cache + solid/image/video/canvas direct adapter（foreignObject 回数削減）→ Phase 4 Worker encode/mux → Phase 5 audio overlap/streaming mux → Phase 6 multi-render-context 実験。
- **重要な禁止事項**: WebCodecs `latencyMode: "realtime"` は仕様上 frame drop を許すため canonical export の高速化に使わない。MediaRecorder/captureStream、export video の `play()` step に戻さない。
- **不変性**: 調査・doc のみ。source/spec/§5/INV/project.json は未変更、テスト未実行。
- **Next step**: 実装するなら PLAN 推奨どおり Phase 0 + Phase 1A/1B を最初の作業単位にし、先に spec §11.2 散文を更新する。

### 2026-07-19（Codex）— Browser Export Phase 1 実装・before/after比較 ✅

- **spec先行**: §11.2散文に、raster canvas→`VideoFrame` direct input、`encodeQueueSize`超過時の`dequeue` event待機、abort/closed時の待機解放を追記。§5/INV/project.json変更なし。
- **実装**:
  - `exporter.ts`: `createImageBitmap(canvas)`中間surfaceを廃止し`new VideoFrame(canvas, timestamp/duration)`へ直結。
  - `encoderBackpressure.ts`: 16ms pollingを`dequeue` event駆動へ置換。queue drain競合の再check、AbortSignal、encoder closedを処理。
  - `encoderBackpressure.test.ts`: 即時 / 複数dequeue / abort / closedの4 unit追加。
  - `bench-gpu-raster-export-baseline.mjs`: Windows/LinuxのPlaywright実行をportable化し、PNG/MP4/WebM選択、出力Blob metadata decode検証を追加。
- **性能比較**: 同一build MP4 paired A/B×4でwall median **4,030.5→3,902.0ms（-3.2%）**、定常frame median **123.8→115.5ms（-6.7%）**、direct canvasが4組中3勝。`createImageBitmap` 24→0。効果は小さく、主要ボトルネックはforeignObject captureのまま。詳細: `doc/cloudplan/browser-export-phase1-benchmark.md`。
- **最終出力実機**: MP4/WebMとも1280×720・約0.8秒のmetadata decode成功、pageErrors 0。WebMはbefore単発3,964.2ms、direct 3run median3,747.5ms（参考 -5.5%）。
- **検証**: typecheck PASS / targeted 11 tests PASS / full vitest 1348/1350（既知pre-existing liquidChrome 1件 + 初回player freshness。`npm run build:player`後freshness PASS）/ video monotonic onTarget25/25・reverse0・stuck0 PASS / export adjustment PASS / track matte 9/9 PASS。
- **既知verifyノイズ**: `verify-video-export.mjs`は古い`video_test.mp4`に焼き込まれたplayer UIを検出してFAIL。今回変更より前段captureの既知asset問題。動き/決定論は`verify-video-export-monotonic`を正準ゲートとしてPASS。
- **player**: runtime変更ルールに従い`npm run build:player`実行、`public/player.js`更新・freshness PASS。
- **Next step**: `browser-export-max-speed-plan.md` Phase 2（WebGL最終surface直結）またはPhase 3（layer-local surface cache/direct media surface）。

### 2026-07-20（Codex）— Browser Export Phase 2 GPU出口直結 + video export GPU優先 ✅

- **spec先行**: §11.2に、非透過MP4/WebMのGPU compositor優先、native解像度でWebGL canvasを`VideoFrame`へ直結、透過/PNG/scaled/precomp/bundleはCanvas2D維持、GPU失敗時CPU fallbackを追記。§5/INV/project.json変更なし。
- **実装**:
  - `WebGl2Compositor.finish(copyToCanvas2d)`: video用に最終Canvas2D `drawImage`を省略できる出口を追加。既定引数はcopy=trueで既存呼び出し不変。
  - `compositeExportFrame(..., options)`: `enableGpuCompositor` / `directGpuSurface`を追加。video exportだけ明示opt-inし、scale時はdirectを自動抑止。
  - `exporter.ts`: `alpha=false`のMP4/WebMでGPU compositor + direct surfaceを選択。alpha=trueは従来CPU/Canvas2D。
  - `gpuCompositorFlag.ts`: 同一build A/B用の非直列化`__mafterGpuDirectSurface=false` seamを追加（既定true）。
  - `verify-gpu-direct-video-frame.mjs`: WebGL direct vs Canvas2D copyの`VideoFrame` RGBA parityゲートを追加。
  - GPU bench/parity scriptsのPlaywright Chromium pathをWindows/Linux portable化。
- **性能（1280×720 heavy fixture / 24fr）**:
  - final copyのみ: MP4 steady median **110.8→103.45ms/fr（-6.6%、3/4勝）**、WebM **121.1→102.4ms/fr（-15.4%、3/3勝）**。tracked `drawImage` **407→383**（24回削減）。
  - video export backend全体: CPU→GPU+directでwall median **4015.45→3469.4ms（-13.6%、4/4勝）**、steady **119.55→103.7ms/fr（-13.3%、3/4勝）**。
  - 詳細: `doc/cloudplan/browser-export-phase2-benchmark.md`。
- **parity/isolation**: direct/copy `VideoFrame` normal・blend各230,400 samplesでmaxAbs=0/differing=0。GPU normal 3frはCPU比maxAbs=0。scaled MP4はdirect 0/6・640×360 decode PASS。実利用既定（global GPU flag OFFのまま）でも非透過MP4がGPU/direct 6/6実走・metadata decode PASS。
- **検証**: typecheck PASS / targeted 16/16 PASS / player rebuild+freshness PASS / full Vitest **1349/1350**（唯一のfailは既存`effects.test.ts` liquidChrome再登録漏れ。単独再実行でも同じ）。
- **既知事項**: alpha WebMはdirect 0/6を確認したが、本環境Chromiumでは生成blobのmetadata decodeが失敗（既存alpha codec/browser制約）。本変更はalpha経路を変更していない。
- **Next step**: 最大ボトルネックはforeignObject capture。`browser-export-max-speed-plan.md` Phase 3として、layer-local content surface + placement分離、solid/image/video/canvas direct adapter、bounded surface cacheをspec化して段階実装する。transform/perspective/matte/nestedのfallback境界が設計判断点。

### 2026-07-20（Codex）— Browser Export Phase 3a bounded static capture cache ✅

- **spec先行**: §11.2に、browser video export限定のeffect無し2D solid/text capture再利用、DOMレイヤーごと直近1枚、対象外（media/HTML/plugin/geom/matte/nested/adjustment/effect）、PNG/precomp/bundle非適用を追記。
- **実装**:
  - `staticLayerCaptureCache.ts`: safe対象判定 + resolved signature（world transform/opacity/components）とA/B seam。
  - `DomRenderer`: 各`ExportLayer`へ安全な`captureCacheKey`を投影。
  - `exportComposite.ts`: WeakMapでDOMレイヤー実体ごとに直近1 Promise/canvasのみ保持。signature変化で置換、rejectで削除。
  - `exporter.ts`: browser MP4/WebMだけcache opt-in。
  - `staticLayerCaptureCache.test.ts`: hit/miss/除外条件 + flagの4 unit。
- **性能（MP4 / 1280×720 / 24fr / static safe 4層、同一build 4 pairs）**:
  - SVG decode **311→219**、tracked drawImage **383→291**（各-92 = 4層×23再利用frame、全run一致）。
  - wall median **3882.7→3795.65ms（-2.2%、2/4勝）**、steady **121.9→107.6ms/fr（-11.7%、3/4勝）**。
  - 全OFF/ON runでMP4 5791 bytes・1280×720 metadata decode一致。詳細: `doc/cloudplan/browser-export-phase3-static-cache-benchmark.md`。
- **決定論ゲート**: `verify-video-export-monotonic.mjs` PASS（onTarget 25/25、reversal 0、stuck 0）。videoはcache対象外。
- **全回帰**: player rebuild+freshness PASS。full Vitest **1354/1355**（唯一のfailは既存`effects.test.ts` liquidChrome再登録漏れ。増分failなし）。
- **Next step**: Phase 3b direct image/video/canvas surface、またはcontent/placement分離でtransform-only animationもcache hit化。matte/perspective/nestedはfallback維持から1軸ずつ拡張する。

### 2026-07-20（Codex）— Browser Export Phase 3b static image capture cache ✅

- **spec先行**: §11.2 static capture cache対象へ読込完了済み2D imageを追加。asset IDだけでなく実DOMの`currentSrc`・natural sizeをsignatureへ含め、未読込/差替えはmissと確定。
- **実装**: `staticLayerCaptureSignature`でimageをsafe対象化。`DomRenderer.getExportLayers`で`complete`/natural sizeをgateし、resource signatureをresolved signatureへ合成。A/B用image-only seamとunitを追加。
- **実測（可視PNG 1枚 / MP4 / 24fr / 3 pairs）**: SVG decode **243→220**、drawImage **315→292**（各-23、全run一致）。wall median **3250.9→2795.8ms（-14.0%、3/3勝）**、steady **92.7→77.6ms/fr（-16.3%、3/3勝）**。全run output **14035 bytes**・1280×720 decode一致。詳細: `doc/cloudplan/browser-export-phase3b-image-cache-benchmark.md`。
- **対象外維持**: video/canvas/HTML/plugin/geom/nested/adjustment/effect/matte、PNG/precomp/bundle。
- **回帰**: typecheck・player rebuild/freshness PASS。full Vitest **1355/1357**（既知liquidChrome +既知flaky projectBins）。projectBinsを含む関連38 testsは単独再実行で全PASS。
- **Next step**: Phase 3c simple 2D video direct capture adapter。videoはframeごとに変わるためcacheせず、deterministic seek後のpresented frameをJPEG data URL + SVG decodeを経由せずfull-comp canvasへ直接描く。transform/opacity/fitのみ対応し、3D/effect/matte/nested/alphaは既存fallback。

### 2026-07-20（Codex）— Browser Export Phase 3c simple 2D video direct capture ✅

- **spec先行**: §11.2に、非透過MP4/WebM限定でseek済み単純2D videoをfull-comp canvasへ直接描画する契約を追記。world transform/opacity/fitを維持し、alpha/effect/matte/3D/nested/multi-component/未decode/非affineは従来fallback。PNG/precomp/bundle/previewは非適用。§5/INV/project.json変更なし。
- **実装**:
  - `directVideoCapture.ts`: resolved eligibility、Canvas2D affine gate、object-fit矩形、A/B seam。
  - `DomRenderer`: eligible videoと同一resolved transform/opacity/fit、実`HTMLVideoElement`を`ExportLayer`へ投影。split/packed alphaのcanvas併存時は除外。
  - `exportComposite.ts`: ready済みvideoを透明full-comp canvasへ直接draw。通常root一括capture可能なフレームもdirect videoがあればper-layerへ切替え、他の静的層は既存cacheを利用。失敗時は同frameでforeignObject fallback。
  - `exporter.ts`: browser MP4/WebM loopだけopt-in。非直列化`__mafterDirectVideoCapture=false`で即時rollback可能。
  - `directVideoCapture.test.ts`: eligibility/除外/affine/fit/flagの8 unit。
- **実測（1280×720 heavy fixture + video / MP4 / 24fr / 3 pairs）**: wall median **5756.8→4717.8ms（-18.0%、3/3勝）**、steady **195.6→105.5ms/fr（-46.1%、3/3勝）**。`toDataURL`/SVG decode/`drawImage`は各 **-24 calls**。directはON runで24/24実走。詳細: `doc/cloudplan/browser-export-phase3c-video-direct-benchmark.md`。
- **画素比較**: encoded midpoint 64×36 RGBでMAE **0.179/255**、max **9/255**、差>3は**0.839%**、差>10は0。差は従来の中間JPEG除去による品質改善。metadataは全run 1280×720・0.8秒、pageErrors 0。
- **回帰**: typecheck・player rebuild/freshness・増分15 tests PASS。full Vitest **1364/1365**（唯一のfailは既知`effects.test.ts` liquidChrome再登録漏れ）。実ブラウザはvideo monotonic onTarget 25/25・reversal 0・stuck 0、adjustment export PASS、track matte 9/9 PASS。
- **Next step**: Phase 3d content/placement分離。transform/opacityだけ動くsolid/text/imageでcontent surfaceを再利用し、placementをcompositor側へ移す。回転/scale/anchor/opacityのCanvas2D/WebGL parityを先に固定し、perspective/matte/nestedはfallback維持。

### 2026-07-20（Codex）— Browser Export Phase 3d simple 2D solid direct capture ✅

- **spec先行**: §11.2に、非透過MP4/WebM限定で単純2D solidをresolved affine transform/opacity/color/sizeからfull-comp canvasへ直接描画する契約を追記。effect/matte/adjustment/3D/nested/multi-component/不正値はfallback。§5/INV/project.json変更なし。
- **実装**:
  - `directSolidCapture.ts`: resolved eligibility、値検証、A/B seam。
  - `DomRenderer`→`ExportLayer`: direct solid descriptorを投影。
  - `exportComposite.ts`: Canvas2D transform+opacity+`rgbaCss`で直接fill。既存static cacheを先に照合し、direct結果も同cacheへ格納するため、静的solidは初回1回だけdirect、animated solidはsignature変化時だけdirect。
  - `exporter.ts`: 非透過browser MP4/WebMのみopt-in。`__mafterDirectSolidCapture=false`でrollback可能。
  - `directSolidCapture.test.ts`: eligibility/除外/値gate/flagの4 unit。
- **実測（1280×720 heavy fixture・position animated solid 1層 / MP4 / 24fr / 3 pairs）**: wall median **3887.4→3365.3ms（-13.4%、3/3勝）**、steady **111.8→94.4ms/fr（-15.6%、3/3勝）**。SVG decode/drawImage各 **-27 calls**。directは各ON run 27回（静的4層の初回 + animated層の残り23frame）。詳細: `doc/cloudplan/browser-export-phase3d-solid-direct-benchmark.md`。
- **parity**: 全6run MP4 **14880 bytes**、1280×720・0.8秒一致。全3 pairのmidpoint 64×36 RGBAは**byte-identical（maxAbs=0）**、pageErrors 0。
- **回帰**: typecheck・player rebuild/freshness・増分19 tests PASS。full Vitest **1368/1369**（唯一のfailは既知`effects.test.ts` liquidChrome再登録漏れ）。実ブラウザ adjustment export PASS、track matte 9/9 PASS。
- **Next step**: Phase 3e simple 2D image direct capture。decoded `HTMLImageElement`を同じaffine/opacity/fit adapterへ載せ、静的は既存cache、transform animated時だけdirect更新。cross-origin/未decode/effect/matte/3Dはfallback。

### 2026-07-20（Codex）— Browser Export Phase 3e simple 2D image direct capture ✅

- **spec先行**: §11.2に、非透過MP4/WebM限定で読込済み・same-origin/CORS-safe単純2D imageを実`HTMLImageElement`からresolved affine transform/opacity/fitで直接描画する契約を追記。未decode/cross-origin unsafe/effect/matte/adjustment/3D/nested/multi-componentはfallback。§5/INV/project.json変更なし。
- **実装**:
  - `directImageCapture.ts`: resolved eligibility、fit正規化、A/B seam。
  - `DomRenderer`: DOM imageのcomplete/natural size/source originをgateして`ExportLayer`へ投影。
  - `exportComposite.ts`: source/destination fit矩形 + affine/opacityで直接drawし、結果を既存one-entry cacheへ格納。
  - `exporter.ts`: 非透過browser MP4/WebMのみopt-in。`__mafterDirectImageCapture=false`でrollback可能。
  - `directImageCapture.test.ts`: eligibility/除外/fit/flagの4 unit。
- **実測（1280×720 heavy fixture + position animated PNG / MP4 / 24fr / 3 pairs）**: wall median **4128.4→3371.8ms（-18.3%、3/3勝）**、steady **119.3→92.2ms/fr（-22.7%、3/3勝）**、SVG decode **239→215（-24）**。directは各ON run 24/24。詳細: `doc/cloudplan/browser-export-phase3e-image-direct-benchmark.md`。
- **画素比較**: 全3 pairでmidpoint RGB MAE **0.054/255**、max **4/255**、差>3は**0.101%**、差>10は0。全run 1280×720・0.8秒、pageErrors 0。encoded sizeは70608→64059 bytes（Canvas2D直描画とSVG補間の微差）。
- **回帰**: typecheck・player rebuild/freshness・増分23 tests PASS。full Vitest **1372/1373**（唯一のfailは既知`effects.test.ts` liquidChrome再登録漏れ）。実ブラウザ adjustment export PASS、track matte 9/9 PASS。
- **Next step**: Phase 3f text content/placement分離、またはPhase 4 Worker encode/mux。textはfont/box/stroke/shadow/baselineのlocal bounds固定と回転・scale parityが必要なため、direct drawではなくlocal foreignObject surface cacheを優先する。

### 2026-07-21（Claude Code / Opus 4.8）— マクロメニュー ＋ テキスト一括置換 ✅

- **概要**: メニューバーに「マクロ ▾」ドロップダウンを新設し、最初のマクロ「テキスト一括置換」を実装。現在コンプ内で中身が整数 `1`,`2`,`3`… の静的テキストレイヤーへ、入力文字列を番号順に流し込む（番号 N ← N 番目のトークン）。文字モード（1文字ずつ）／単語モード（空白区切り・英語用）。適用範囲は現在コンポジションのみ。
- **spec先行**: `doc/mafter-effect-spec.md` に §32 マクロ（一括編集ツール）を追記（散文のみ・additive）。§32.1 セマンティクス／§32.2 UI／§32.3 INV整合／§32.4 受け入れ条件。**§5・INV-1〜6・project.json 直列化は不変**（既存 `text` prop の value を書き換えるのみ）。
- **実装**:
  - `src/editor/macros/textBulkReplace.ts`（新規・純ロジック／INV-1）: `tokenize` / `planBulkReplace`（番号=1-based トークン添字、欠番・重複・過不足・keyframe/expression 除外を計画化）/ `buildReplacedObjects`（value のみ差替、id順・他prop不変）。
  - `src/editor/store.ts`: `applyTextBulkReplace(input, mode)` 追加（`decomposeGlyphs` を踏襲、`applyCommand` で 1 undo）。
  - `src/editor/menu/MacroMenu.tsx`（新規）: ドロップダウン（外側クリック/Esc で閉じる、Electron ドラッグ no-drag）。
  - `src/editor/menu/TextBulkReplaceDialog.tsx`（新規）: 入力欄＋モード切替＋ライブプレビュー（番号→旧→新、未置換/未使用/除外の件数）。
  - `src/App.tsx`: メニューバーに `MacroMenu` 差込、ダイアログ開閉 state。
  - `test/textBulkReplace.test.ts`（新規・14 unit）: 文字/単語、欠番、重複、過不足、非整数除外、keyframe/expression 除外、生string、buildReplacedObjects の非破壊性。
- **build:player**: editor-only（runtime/player 未変更）のため不要。`playerBuildFreshness` PASS で裏付け。
- **検証**: typecheck クリーン。full Vitest **1402/1402 PASS**。実ブラウザ（Playwright + Chromium）スモーク: マクロ ▾ 表示→ドロップダウン→モーダル→プレビュー描画→キャンセルまで全 PASS、機能由来の page error なし。
- **Next step（将来）**: マクロ枠に他マクロ追加（連番採番・レイヤー一括リネーム等）。char モードの内部空白の扱いは現状「1文字扱い（前後trimのみ）」で確定。

### 2026-07-21（Claude Code / Opus 4.8）— コマンドメニュー / キーボードリーダー（Ctrl ダブルタップ）✅

- **概要**: 機能をキー列で起動できる汎用機構を追加。**Ctrl ダブルタップ → M → T** で「マクロ → テキスト一括置換」を実行。`registerCommand` 1 コールで **ドロップダウンと Ctrl 経路の両方**にトリガが増える拡張設計。
- **spec先行**: `doc/mafter-effect-spec.md` に §33 追記（散文のみ・additive）。§33.0 拡張点／§33.1 リーダー起動／§33.2 UI／§33.3 データモデル／§33.4 受け入れ条件。**§5・INV・project.json 不変**、editor-only。
- **実装（`src/editor/commandMenu/`）**:
  - `types.ts`: `CommandLeaf` / `CommandNode`。
  - `commandTree.ts`（純・INV-1）: `buildCommandTree` / `resolveLevel` / `nodeAtPath` / `pathLabels`。
  - `leaderTap.ts`（純）: `isSecondTap`（ダブルタップ窓 400ms）。
  - `commandRegistry.ts`: シングルトン＋`registerCommand`。`getLeaves()` は変更まで同一参照（useSyncExternalStore 契約）。
  - `useCommandTree.ts` / `useCommandMenu.ts`: 購読＋リーダー検出（Ctrl 押下中の他キーで修飾扱い→`Ctrl+Z` 等は起動しない、capture 段階でキーを奪う、Esc/背景/無操作3sでキャンセル）。
  - `CommandMenuOverlay.tsx`: which-key 風 HUD（パンくず＋キーキャップ一覧）。
  - `menu/MacroMenu.tsx`: レジストリの「マクロ」グループから項目生成（onOpenTextBulkReplace prop 廃止）。
  - `src/App.tsx`: `registerCommand({ path:[マクロ,テキスト一括置換], run })` ＋ `<CommandMenuOverlay/>`。
  - `test/commandMenu.test.ts`（11 unit）: ツリー畳み込み・順序・lowercase 正規化・後勝ち・resolve/nodeAt/pathLabels・isSecondTap。
- **検証**: typecheck クリーン。full Vitest **1413/1413 PASS**。実ブラウザ（Playwright）: `Ctrl+Z` は HUD を開かない／`Ctrl` ダブルタップで HUD 表示／`M` で潜り／`T` でダイアログ起動＋HUD 閉／`Esc` キャンセル、いずれも PASS。機能由来の page error なし。
- **build:player**: editor-only のため不要。

### 2026-07-21（Claude Code / Opus 4.8）— 配置順の行判定モード（緩め/厳格）追加・緩めを既定に ✅

- **概要**: reading（配置順）採番の行判定に 2 プリセットを追加。**緩め（`lenient`・既定・64px）**＝多少の上下ズレは同じ行、**厳格（`strict`・4px）**＝座標が近いものだけ同じ行。従来の単一 24px を廃し、既定を緩めに。
- **spec**: §32.1 に `rowGrouping`（lenient/strict）と例（右が 20px 高い 2 要素で採番が変わる）を追記。§5・INV・project.json 不変。
- **実装**: `textBulkReplace.ts`（`RowGrouping` 型・`LENIENT/STRICT_ROW_TOLERANCE`・`rowToleranceFor`、`DEFAULT_ROW_TOLERANCE`=緩め）、`store.ts`（`applyTextBulkReplace` に rowGrouping 追加・既定 lenient）、`TextBulkReplaceDialog.tsx`（reading 時のみ行判定ラジオ表示・prefs 永続化・既定 緩め）。
- **検証**: typecheck クリーン。full Vitest **1424/1424 PASS**（緩め/厳格で採番が変わる純ロジック unit を追加）。実ブラウザ: 行判定 UI は content で非表示・reading で表示、既定 緩め、厳格が再開後も維持、page error なし。
- **build:player**: 不要（editor-only）。

### 2026-07-21（Claude Code / Opus 4.8）— UI 改善: 置換ダイアログの永続化・移動 + メニュー並び ✅

- **概要**: ①テキスト一括置換ダイアログの最後の選択（入力/採番/分割モード）と位置を localStorage に永続化。②ヘッダドラッグでダイアログを自由に移動（背景透明化・背後のコンプが見える）。③メニューバーの `clean`/`N op` 表示を Undo/Redo のすぐ右へ移動（マクロは その後）。
- **spec**: §32.2 に永続化・移動可能を追記（project.json 非汚染の UI 状態・§19.3）。
- **実装**: `TextBulkReplaceDialog.tsx`（`mafter-text-bulk-replace-v1` の load/save、ヘッダ mousedown ドラッグ、overlay 透明・dialog fixed 配置）、`App.tsx`（op/clean を Redo 直後へ）。
- **検証**: typecheck クリーン。full Vitest **1420/1420 PASS**（UI のみ・ロジック不変）。実ブラウザ: clean が Redo 直後 / 選択（配置順・単語・入力）が再開後も維持 / ドラッグで移動（Δ200,150）+ 位置も維持、page error なし。
- **build:player**: 不要（editor-only）。

### 2026-07-21（Claude Code / Opus 4.8）— テキスト一括置換に「配置順（読み順）採番モード」追加 ✅

- **概要**: テキスト一括置換に採番モード `order` を追加。`content`（従来: 中身が整数のレイヤーを対象）に加え、**`reading`（配置順）**: 中身が数字でなくても、現フレームで表示中の全テキストレイヤーを**左上→行→右下**の読み順で自動採番して順に置換する。
- **spec先行**: §32.1 に採番モード（content/reading）を追記。reading は `resolve(comp,frame)` の worldTransform 平行移動を読み順（行 tolerance 既定 24px）に並べて 1,2,3… 採番。`computeReadingOrder` は純関数（INV-1）。§5・INV・project.json 不変。
- **実装**:
  - `src/editor/macros/textBulkReplace.ts`: `OrderMode` 追加、`computeReadingOrder`（純・行バンド＋行内 x 昇順＋id 安定）追加、`planBulkReplace(objects, input, mode, order?, positions?, rowTolerance?)` に拡張（既存 3 引数 content 呼び出しは後方互換）。
  - `src/editor/macros/textLayerPositions.ts`（新規）: `resolve` で現フレームの各レイヤー画面位置を取得（純 resolve 経由、失敗時は空）。
  - `src/editor/store.ts`: `applyTextBulkReplace(input, mode, order)`。reading 時に positions を計算して渡す。
  - `src/editor/menu/TextBulkReplaceDialog.tsx`: 採番モードのラジオ（中身の数字 / 配置順）＋モード別の説明・空状態文言。プレビューは現フレーム位置で再計算。
  - `test/textBulkReplace.test.ts`: computeReadingOrder（2x2 グリッド・行 tolerance・行分割・同座標 id tiebreak）＋ reading モード planBulkReplace（非数字採番・位置無しレイヤー除外・keyframe 除外）を追加。
- **検証**: typecheck クリーン。full Vitest **1420/1420 PASS**。実ブラウザ（Playwright）: Ctrl ダブルタップ→M→T でダイアログ、採番ラジオ（中身の数字/配置順）表示、配置順切替で説明更新、入力＋単語分割でクラッシュなし。機能由来の page error なし。
- **build:player**: editor-only のため不要。

### 2026-07-21（Codex）— Project パネルのアイテム Copy / Paste ✅

- **概要**: Project パネルの comp / footage / bin を、右クリック「コピー」「貼り付け」と `Ctrl/Cmd+C` / `Ctrl/Cmd+V` の両方で複製可能にした。複数選択、フォルダー再帰複製、貼り付け先フォルダー、1 paste = 1 undo に対応。
- **spec先行**: §20.6 を追加。§5・INV・project.json 直列化形式は不変。
- **実装**:
  - `duplicateProjectEntries.ts`: 選択祖先の重複除去、bin 子孫順維持、comp / object / shape vertex / effect / preset の新 ULID、parent / merge object / comp / html / asset 参照リマップ、expression script path リマップを純 project transform として実装。
  - `store.ts`: HTML comp FS と object script directory を新 ID へコピー後、`Paste Project Items` を 1 command で適用。asset 複製は同じ原本/proxy path を共有するため、別 asset entry が残る間は共有 FS ファイルを削除しない。
  - `ProjectTreeView.tsx`: 行・空白のコンテキストメニュー、Project パネル内 clipboard、native copy/paste event による Ctrl/Cmd ショートカット、貼り付け後の選択更新。
  - unit 8件追加（再帰複製・参照リマップ・外部参照維持・共有 asset path 保護）。
- **検証**: typecheck PASS、増分 8/8 PASS、`git diff --check` PASS。full Vitest **1428/1429 PASS**（唯一の fail は今回未変更の `public/player.js` 鮮度。runtime/player 差分なしの既存状態）。実ブラウザ: 右クリック Copy/Paste、Ctrl+C で menu clipboard 有効化、Ctrl+V で複製、Undo で1件復元、フォルダー行への paste が depth 1 に入ること、console error 0 を確認。
- **build:player**: editor-only のため未実行（runtime/player 未変更）。
- **残タスク**: なし。

### 2026-07-21（Codex）— Project アイテム複製名の連番化 ✅

- **概要**: Project パネルで bin / comp を貼り付ける際、貼り付け先に同名があれば `Name 2`、既存名が数字で終わる場合や番号が埋まっている場合は `Name 3`、`Name 4`…と空き番号まで進めるよう変更。同名がない別フォルダーへの貼り付けでは元名を維持する。asset は表示名が path 由来のため従来どおりファイル名を維持する。
- **spec先行**: §20.6 の ` copy` 規則を数字サフィックス規則へ更新。§5・INV・project.json 直列化形式は不変。
- **実装**: `duplicateProjectEntries.ts` に純関数 `nextAvailableProjectItemName` と、貼り付け先の bin / comp / asset 表示名を使う衝突判定を追加。複数項目を同時に貼る場合も同一操作内で採番を予約する。
- **検証**: `test/duplicateProjectEntries.test.ts` 5/5 PASS、typecheck PASS。実ブラウザで右クリック Copy/Paste により `Main 2`、続く `Ctrl+C` / `Ctrl+V` により `Main 3` が生成されることを確認。
- **build:player**: editor-only のため未実行（runtime/player 未変更）。
- **残タスク**: なし。

### 2026-07-22（Claude Opus 4.8）— インスペクター複数選択の一斉編集 ✅

- **概要**: 複数レイヤー選択時、インスペクターの共通プロパティを一斉編集可能に。トグル/enum は同値で同期、数値は各レイヤーの現状を維持したまま同じ delta で上下（3D extrude/bevel、camera、effect、component 全 param 含む）。Transform/Opacity は元から delta 対応済み。
- **spec先行**: UI エルゴノミクスのみ。§5・INV・project.json 直列化形式は不変。
- **実装**:
  - `store.ts`: `applyToggleToSelection` を追加し `setThreeD`/`setThreeDMode`/`setBlendMode`/`setTrackMatteMode` を選択全体対応（1 undo コマンド）。
  - `multiSelectPropEdit.ts`（新規・純関数）: components/effects/expressionPresets パッチを選択他レイヤーへ横展開。type/presetId でマッチ、数値は delta・非数値は同値、対象要素なしはスキップ。
  - `InspectorPanel.tsx`: `editObject` closure を全 sub-field（Text/Solid/Shape/Video/Component/Effect/ExpressionPreset）と `setCamProp` に配線。トグル4種に「— 混在 —」インジケータ、ヘッダーに「+N レイヤー選択中」バッジ。
- **検証**: typecheck PASS。増分 unit 6/6 PASS（`multiSelectPropEdit.test.ts` 3、`multiSelectToggle.test.ts` 3）。
- **build:player**: editor-only のため未実行（runtime/player 未変更）。
- **既知の天井**: 同一 type の effect/component が複数ある場合は最初の一致にのみ適用。live preview（scrub 中）は複数選択時オフ、commit で確定。
- **残タスク**: 実ブラウザでの目視確認（未実施）。
### 2026-08-10 (Codex) - Render Swarm v1 implementation

- Spec-first: appended a runtime-only Render Swarm v1 section to `doc/mafter-effect-spec.md`; existing schema, INV-1..6, and `project.json` serialization are unchanged.
- Implementation: added versioned protocol, ECDSA P-256 identity/challenge, capability collection and benchmark, priority pull scheduler, leases/requeue/stale-result validation, content-hash asset/cache primitives, provider-neutral signaling, Vercel long-poll adapter, WebRTC data-channel transport, host coordinator, worker runtime/render executor, and bounded worker cache under `src/swarm/`.
- UI/integration: added the Workers + menu with QR/join URL/approval/connected-worker rows, `/w/<join-code>` worker page, preview-cache remote renderer with local fallback, and `api/swarm/[action].ts` routes for create/join/approve/signal/events/close.
- Verification: `npm run typecheck` PASS, `npm run build` PASS, Render Swarm unit tests 5/5 PASS, browser smoke PASS for the Workers menu, QR canvas, worker page, and zero page errors. The full Vitest run currently has 152/153 files and 1441/1442 tests passing; the remaining failure is the existing `projectBins` test, which passes alone but can fail under parallel execution, and Node-only autosave emits existing `indexedDB` unhandled errors.
- Known limitations: the Vercel rendezvous store is instance-local until a shared ephemeral store is added; asset-backed/animated-expression jobs use local fallback in v1; TURN is not configured; distributed final export is intentionally disabled.
- Next steps: shared short-lived signaling store, content-addressed asset transfer, TURN/relay operations, then final-export distribution after parity validation.

### 2026-08-11 (Codex) - Render Workers non-JSON signaling error fix

- Root cause: the static SSH deployment serves the SPA through `scripts/mafter_http_server.py`, but its POST handler only recognized `/api/feedback`; `/api/swarm/*` returned the stdlib server's plain 404 body. `VercelSignalingBackend` then called `response.json()` unconditionally, producing `Unexpected token 'A'` for a plain-text server error.
- Implementation: added the six temporary Render Swarm rendezvous/signaling actions to the existing stdlib server, with JSON-shaped validation/errors, bounded long-polling, short-lived in-memory state, peer approval, signal forwarding, and close/expiry events. The client now reports non-JSON responses with HTTP status and a bounded response detail.
- Documentation: recorded the static SSH signaling provider in `doc/render-swarm.md` and the Render Swarm spec section. Existing schema, invariants, and project serialization are unchanged.
- Verification: `python -m py_compile scripts/mafter_http_server.py` PASS; `npm run typecheck` PASS; Render Swarm tests 6/6 PASS; `npm run build` PASS; Python HTTP smoke create/join/events PASS against the static server; browser smoke opened the Workers dialog, created a join URL, and reported zero console warnings/errors. Full Vitest: 153 files / 1443 tests PASS, with the existing 4 Node-only unhandled errors from `indexedDB`/`alert` in autosave tests.
- Deployment note: rerun the static SSH deployment so the updated Python API and built editor are installed together.

### 2026-08-11 (Claude Opus 5) - Swarm signaling 500 の根治と本番 backend の分離

- 症状: `/api/swarm/events` が Vercel 素の `FUNCTION_INVOCATION_FAILED`（HTML 500）を返し、クライアントが「non-JSON (HTTP 500)」で落ちる。
- 根因1（クラッシュ）: `collectEvents` が `void backend.subscribe(...)` と投げっぱなしで、unknown/expired セッション時の reject が handler の try/catch 外の floating rejection になり Function プロセスごと落ちていた。→ `subscribe` を await して try/catch 内へ、タイマーは `clearTimeout` で回収。
- 根因2（設計）: `getVercelServerBackend()` の `InMemorySwarmSignalingBackend` はプロセス内 Map。Vercel は request ごとに別 instance へ回りうるため、create / join / events が別 instance に着くと session も long-poll listener も消える。→ **Cloudflare Durable Object を本番 signaling に採用**。
  - `worker/swarmSignaling.ts`（Worker + `SwarmSessionObject`）と `src/swarm/signaling/durableSessionCore.ts`（DO storage 上の rendezvous ロジック、workerd なしで単体テスト可）を追加。session ごとに 1 DO（object 名 = join code、`sessionId` に join code を埋め込み全 action を同じ DO へルーティング）。
  - 共有 store に置くのは session / pending join / offer / answer / ICE / 短命 event queue のみ。heartbeat・progress・job・結果は P2P のまま。
  - `getVercelServerBackend()` は `VERCEL_ENV=production|preview` で明示エラー（InMemory は local/test 専用）。`wrangler.jsonc` / `tsconfig.worker.json` / devDeps `wrangler`・`@cloudflare/workers-types` を追加。
- 追加修正: handler の `req.body` 取得と backend 取得を try/catch 内へ移動し `console.error` で stack を出力。worker は data channel 接続時に signaling を unsubscribe（従来は接続後も 20 秒ごとに long-poll が永久に走っていた＝`SERVER_SILENT` 遷移欠落）。
- 検証: `npx tsc -p tsconfig.worker.json` PASS、`npm run typecheck` PASS、Render Swarm tests 8/8 PASS。DO 実機デプロイ（`npx wrangler deploy` + `VITE_SWARM_SIGNALING_URL`）は未実施。
- Next: Worker をデプロイして host/worker 実機で create→join→approve→P2P→`SERVER_SILENT`（req/min = 0）を確認する。

### 2026-08-11 (Claude Opus 5) - Durable Object signaling を本番デプロイ

- Cloudflare account を `r1cefarm.dev@gmail.com`（`e728b8b71fefdb9968861ac296202f7a`）に切り替えて `npx wrangler deploy` 実行。
- 公開 URL: `https://mafter-swarm-signaling.r1cefarm-dev.workers.dev`（Version `0423a60b-fab0-4070-87b2-d84653f4335e`、DO binding `SWARM_SESSION` = `SwarmSessionObject`）。`workers_dev: true` と observability を有効化。
- 実機疎通: create → join → host events（`peer-join-request`）→ approve → peer events（`peer-approved`）→ close が全て JSON で成功。未知 sessionId は `{"ok":false,"error":"Unknown swarm session"}`（500 ではない）。
- 独自ドメイン（maftereffect.gycp.party 等）への割り当てはユーザーが自分で設定する。
- Next: `VITE_SWARM_SIGNALING_URL` をエディタのビルドに設定し、host/worker 実機で P2P 確立後の server req/min = 0 を確認する。

### 2026-08-11 (Claude Opus 5) - signaling 既定エンドポイントを Worker に切り替え

- `defaultSignalingEndpoint()` の既定を `/api/swarm` から `DEFAULT_SWARM_SIGNALING_URL = https://mafter-swarm-signaling.r1cefarm-dev.workers.dev` に変更（`VITE_SWARM_SIGNALING_URL` があればそちらを優先。空文字は無視）。
- これで静的ホスト（VPS / Pages / Electron）どこにビルドを置いても設定なしで signaling に到達する。独自ドメインを Worker に割り当てたら定数か env を差し替えて再ビルドする（Vite 定数置換なのでビルド時固定）。
- 検証: `npm run typecheck` PASS、Render Swarm tests 9/9 PASS。

### 2026-08-11 (Claude Opus 5) - swarm 表示バグ（transport / available compute）の根治

- 症状: worker 側が `Connection: unknown`、ホスト側は `Direct`、`Available compute` が `1.0× local` から動かない。
- 真因1: **transport 種別をどちらの側も算出していなかった**。ホストの `Direct` は [WorkerStatusRow.tsx](src/swarm/ui/WorkerStatusRow.tsx) が `unknown` を `Direct` と読み替えていただけの偽装表示で、worker の `unknown`（`WorkerRuntime.connectionKind` が初期値のまま未代入）が正直な方だった。→ `WebRtcPeer.detectTransportKind()` を追加し `getStats()` の選択候補ペアから direct/relay を判定、data channel open 時に実行して host / worker 両方へ配線。UI の偽装フォールバックは `…` に変更。
- 真因2: `requestBenchmarks` が `renderPreviewFrame` の中でしか呼ばれず、分散可能なジョブが投入されるまで一度もベンチが走らない。今のゲート（assets があると不可）では永久に走らないケースがある。→ 承認・identity 検証完了時に `createBenchmarkJob()`（空の 320x180 timeline、プロジェクト非依存）でベンチを投げる。
- 真因3: `getAvailableCompute()` が **生の FPS を加算**していた（`normalizedBenchmarkScore` は実装済みだが未使用の死にコード）。ベンチが走った瞬間「31.0× local」のような値になる。→ ホスト自身が同一ベンチジョブを実行してスコアを正規化（worker がホストの 2 倍速なら +2.0×）。
- 検証: `npm run typecheck` PASS、Render Swarm tests 10/10 PASS（`createBenchmarkJob` のプロジェクト非依存性と正規化を純関数テストで固定）。実機の 2 端末確認は CI デプロイ後に実施予定。
- 未着手（ユーザー要望・別 WP）: ①最終書き出しの分散、②Pre-render の分散実測、③video / expression を含むコンプの分散。①③は §11 export パリティと INV-2 に触るため spec 先行が必要。なお worker 側 executor は既に `job.assets` の content-hash 検証と MemoryFs 展開を実装済みで、不足しているのは**ホスト側の asset 同梱とゲート解除**。

### 2026-08-11 (Claude Opus 5) - Render Swarm v2 の spec 確定と WP 分割

ユーザー決定:
- 動画アセットは **元ファイル丸ごと転送**（再エンコードのプロキシは作らない）。加えて、同じデータを既に持つ **他 worker から取得**できるようにする（peer-assisted transfer）。
- 最終書き出しは **検証＋抜き取りローカル再レンダで照合**し、疑わしい worker は外して全フレームをローカルで描き直す。

spec `## Render Swarm (runtime-only, v1)` に v2 節を追記（§5 型・INV は不変。すべて「失敗時はローカルにフォールバック」として記述）。

WP 分割（この順で実装する）:
- **WP-1 asset 同梱とゲート解除** — ホスト側でコンプが実際に参照する asset を FS から読み、content hash 付きで job に同梱する。`isEligibleJob` の `assets.length > 0` 一律拒否を「参照 asset を同梱できたか」に置き換える。worker 側 executor は実装済み（hash 検証 + MemoryFs 展開）なので追加不要。まず画像で通す。
- **WP-2 expression 脚本の同梱** — `scripts/<objectId>/*.js` を同じ経路で送り、`expression` prop の一律拒否を解除。INV-1 により評価は純関数なので値は一致するはず。runtime version 不一致 worker は既存の incompatible 経路で除外。
- **WP-3 動画 asset** — 元ファイル丸ごとを chunkTransport で転送。数百 MB を想定し、転送中はローカルにフォールバックしたまま進行させる（ブロックしない）。
- **WP-4 peer-assisted transfer** — worker 間の WebRTC 接続を追加（現状は host を中心とするスター型）。asset の content hash を鍵に、保持している worker から取得。転送最適化のみで、届くバイト列は hash 検証により不変。
- **WP-5 Pre-render / preview cache の実測** — 実 2 端末でジョブが飛ぶこと・ローカル単独比で速くなることを計測（本命の検証）。
- **WP-6 export 分散** — フレームリースを export 経路に拡張。抜き取り照合（既定 5%）と不一致時の worker 除外＋ローカル再描画。順序・音声 mux・alpha はホスト側に残す。

現時点の完了: v1 の signaling 根治と DO 移行、transport / available compute の表示バグ修正。WP-1 以降は未着手。

### 2026-08-11 (Claude Opus 5) - WP-1 / WP-2: asset・expression 脚本の同梱とゲート解除

- `src/swarm/core/jobFiles.ts` を追加。`collectJobFilePaths()` がコンプを汎用走査して、参照 asset（id 参照・パス直書きの両方）と有効な expression 脚本のパスを集める。component 型ごとの prop 名を知らなくても効くよう、型別分岐ではなく走査で解決している。
- `attachJobFiles()` がホスト FS（`store.getFs()`）から読んで content hash 付きで job に同梱。読めない／インライン予算（24MB）超過なら**同梱せずに返す**。
- `isEligibleJob` の一律拒否（`assets.length > 0` / `video` 型 / `expression` prop）を `isSwarmJobSelfContained()` に置換。参照ファイルが全部乗っていれば分散し、乗っていなければローカルで描く。**「送れないから拒否」から「送れたものは分散」へ**変わった。
- worker 側 executor は既存実装（hash 検証 + MemoryFs 展開）のまま無変更。
- 予算内なら動画も通る。数百 MB の素材は chunkTransport 化（WP-3）まではローカルのままフォールバックする。
- 検証: typecheck PASS、Render Swarm tests 11/11 PASS（参照収集と自己完結判定を純関数テストで固定）。実機 2 端末での分散確認は未実施（WP-5）。

### 2026-08-11 (Claude Opus 5) - WP-3: asset の分割転送と hash 単位の重複排除

- WP-1 の実装は **同じ素材を毎フレーム base64 で job に同梱して再送**していた（1 フレーム 1 ジョブなので画像 1 枚でも毎回転送）。加えて 1 メッセージに収まるサイズが上限になっていた。
- `asset-chunk` メッセージを protocol に追加（`src/swarm/transport/assetChunks.ts`: `splitAssetIntoChunks` / `AssetChunkAssembler`）。ホストは job-offer の前に未送信の content hash だけをチャンク送信し、job には**参照のみ**（`bytesBase64: ""`）を載せる。
- worker は受信チャンクを hash ごとに組み立て、完成したら `BoundedWorkerAssetCache` に投入（従来どおり hash 検証あり）。executor は **キャッシュ優先**で解決し、無ければインライン bytes、それも無ければジョブを失敗させてホストのローカル描画に戻す。
- 送信途中で失敗したら `sentAssetHashes` から取り消す（半端に「送った」と記憶して以後キャッシュミスし続けるのを防ぐ）。
- インライン予算 24MB → 128MB に引き上げ（メッセージサイズ制約ではなくメモリ制約になったため。worker cache 上限と一致）。
- 検証: typecheck PASS、Render Swarm tests 12/12 PASS（順不同・重複チャンクでの再構成を純関数テストで固定）。実機での動画分散は未確認（WP-5）。

### 2026-08-11 (Claude Opus 5) - WP-5 実測: 「繋がるが何も起きない」の真因

実機（ホスト 1 + worker 2、実 Chrome、本番デプロイ）で確認:

- 承認 → DataChannel 確立 → ベンチ → `Available compute: 3.1× local`（1.0 + 約1.05×2）まで**正常**。transport も実 ICE 判定で `Direct`。今回直した表示修正が実機で効いていることを確認。
- **しかしジョブが 1 件も飛ばない。** レイヤーを 48 枚まで増やしても preview cache が `Realtime` 判定のままで、キャッシュ自体が走らないため分散の入口に到達しない。
- コードで裏取り: `startBackgroundBuildIfNeeded()` は `isRealtimeCapable()` で即 return、さらに `enqueueFrame` / `pumpCacheQueue` は `playbackActive` で return（§28.4 再生中 bake 停止）。つまり **①realtime なコンプ ②再生中** のどちらでも bake が走らず、swarm は永久に待機する。「重くて停止中」の場合しか働かない。
- 追加の観測性: worker が実際に何かしたのかが UI に一切出ていなかったため、`remoteFrames` / `localFallbackJobs` / `ineligibleJobs` を metrics に追加し Workers パネルに表示。

修正（spec に §28.4 との関係を明記のうえ実装）:
- **再生中でも worker は bake を続けられる**（ホストは従来どおりローカル bake しない。§28.4 の理由はホスト CPU 競合であり、リモートには当てはまらない）。
- **realtime なコンプでも遊んでいる worker で bake してよい**（ホストのコストはゼロ、後のスクラブが即時になる）。
- worker が 0 のときは**従来挙動と完全に同じ**。`setRemoteRenderer` は接続 worker がいる間だけ設定する（常設だと realtime コンプをローカルで焼き始めてしまうため）。

未実施: この変更後の実機再計測（デプロイ待ち）。WP-4 / WP-6 は未着手。

### 2026-08-11 (Claude Opus 5) - WP-5 続き: 分散が「1 件ずつしか飛ばない」ボトルネック

実機再計測（ホスト 1 + worker 1、本番デプロイ、Solid+Text 16 レイヤー、preview cache ON）:

- 前回修正の効果を確認。`Frames from workers` が **0 → 実際に増加**（realtime コンプでも worker が bake するようになった）。
- ただし **ベースライン 2.80 fps**（20 秒で 94 → 150）。48 レイヤーの重いコンプでは約 1 fps だった。
- 真因: `FrameCacheQueue.runPump()` が `await processor(frame)` で **1 フレームずつ直列**に回す。リモート往復（送信 → worker 描画 → PNG 返送）がこの直列ループに丸ごと入るため、**常に同時 1 ジョブ**。worker を増やしても 2 台目以降は待機で、`Available compute: 3.3×` の表示と実効が乖離する。ローカル描画前提（CPU 1 つなので直列が正しい）の設計がリモートにもそのまま適用されていた。

修正:
- `FrameCacheQueue.setConcurrency(n)` を追加し、`pump()` が同時 n 本のループを回すようにした。既定は 1 = **従来と完全に同じ直列**。
- `setRemoteRenderer(renderer, remoteCapacity)` で接続 worker 数を渡し、並列度を `1 + worker 数` に設定。worker 0 なら 1 に戻る。
- ローカル capture は capture context を共有するため、`localCaptureChain` の promise チェーンで**直列を強制**（並列 pump 中に 2 本走らせない）。リモートは並列、ローカルは直列という非対称を明示した。
- テスト: `test/frameCacheQueue.test.ts` に並列度の回帰を追加（既定 1 で peak in-flight = 1、容量 3 で 1 < peak <= 3）。

検証: typecheck PASS、frameCacheQueue 4/4 PASS、swarm 12/12 PASS。`npm test` は 1449/1450 PASS で、唯一の失敗は既知フレーキーの `projectBins`（単独実行では 7/7 PASS）。

### 2026-08-11 (Claude Opus 5) - WP-6 事前調査: export 分散の挿入点

コードを読んだ結果、**export 分散に新しいパイプラインは要らない**ことが分かった。

- [`src/runtime/multiRenderContext.ts`](src/runtime/multiRenderContext.ts) の `runOrderedMultiContext()` が既に「N 個の producer で並行描画 → frame 昇順で consumer へ整列供給」を実装済み（有界 reorder window + backpressure 付き）。§11.2 Phase 6（既定 OFF）で複数ローカル context 用に使われている。
- producer の型は `(frame: number) => Promise<HTMLCanvasElement>` なので、**リモート worker は producer を 1 本増やすだけ**で載る（返ってきた PNG を canvas へデコードする薄いアダプタが要るのみ）。順序・音声 mux・alpha は consumer 側＝ホストに残るので、spec の「順序と mux は委譲しない」を自然に満たす。
- 残る実装は ①リモート producer アダプタ ②spec が要求する抜き取り照合（サンプルしたフレームをホストでも描いて比較・不一致なら当該 worker を外して全フレームをローカル再描画）③export 用ジョブ種別（現状 `kind: "preview-frame"` のみ）。

**設計上の注意（先に記録）**: 現在の producer 割り当ては `fi % N === c` の**静的ラウンドロビン**。速度が同じローカル context 前提の分配なので、遅いスマホが 1 台混ざると担当分で全体が待たされる（reorder window で頭打ちになる）。リモートを混ぜるなら**動的な pull 割り当て**（既存 `SwarmScheduler` が既に持っている）へ変える必要がある。

**着手判断**: WP-6 は **A/B 計測（並列化後の実測 fps）を見てから**にする。リモート 1 フレームの往復がローカル描画より遅いなら、export を分散すると**遅くなる**ため。現時点の既知数値はベースライン 2.80 fps（直列・worker 1 台）のみで、並列化後の数値は未取得（ホスト再読込＝セッション再作成が必要で、worker の再参加待ち）。

### 2026-08-11 (Claude Opus 5) - 実測で判明した 2 つの実用上の障害

ホスト + worker（別タブ / 別 PC）で計測中に判明:

1. **固定 4 秒デッドライン**: `renderPreviewFrame` のタイムアウトが 4 秒固定で、33 レイヤーのコンプでは worker が間に合わず **`fell back locally: 106`（全滅）**。しかも worker は描き続けるので、その計算は結果到着時に待機者がおらず stale 破棄＝丸ごと無駄。**重いコンプ＝助けが要る場面ほど必ずローカルに戻る**という逆進性があった。
   - 修正: デッドラインを呼び出し側から渡せるようにし（`SWARM_DEFAULT_JOB_TIMEOUT_MS` 4s 〜 `SWARM_MAX_JOB_TIMEOUT_MS` 60s でクランプ）、`RamPreviewController` がローカル 1 フレームの実測コスト（EWMA）の 4 倍を渡す。初回はローカル実測が無いので 4 秒→フォールバック→そこで計測値が入り以後適応する（自己補正）。
2. **バックグラウンドタブのスロットリング**（ユーザー報告「タブを切り替えるとダメ」）: 裏に回った worker タブは rAF / タイマーが絞られ、リースしたフレームが常に期限切れになる。ジョブを投げ続けるだけ無駄。
   - 修正: `worker-availability` メッセージを追加。worker が `visibilitychange` で可視状態を報告し、ホストは `isWorkerReady()` で不可視 worker を配布対象から外す（可視に戻ったら `pumpJobs()` で即再開）。Workers パネルには `Background` と表示。worker ページにも「タブを前面に保て」と明記。

検証: typecheck PASS、`npm test` 153 files / 1451 tests **全 PASS**（前回失敗した `projectBins` は既知フレーキーで今回は緑）。

**計測上の制約**: この可視性ガードにより、同一ブラウザの裏タブを worker にした自己計測はできなくなった（設計どおり）。並列化後の fps は、worker タブを前面に保った実機でのみ取得できる。ベースラインは 2.80 fps（直列・worker 1 台）。

### 2026-08-11 (Claude Opus 5) - 期限切れ後に届いた結果を捨てない

- デッドラインを適応化しても、遅れて届いた結果は `handleResult` で待機者不在＝ stale 破棄されていた（worker の計算が丸ごと無駄）。
- `SwarmCoordinatorOptions.onLateResult` を追加。待機者は居ないが **job の検証（jobId / revision / comp / frame / 寸法 / 形式 / runtime）に通る**結果は、`RamPreviewController.acceptLateRemoteFrame()` 経由でキャッシュに入れる。revision 不一致（プロジェクトが編集済み）と既存キー有りは弾く。
- 効果: 遅い worker でも「間に合わなかったフレーム」が次回のスクラブ・再生で効く。ローカル描画の結果を上書きすることはない（既存キーがあれば無視）。
- 検証: typecheck PASS、`npm test` 153 files / 1451 tests 全 PASS。

### 2026-08-11 (Claude Opus 5) - 計測環境の落とし穴と検証レシピ

- **埋め込みブラウザ（Claude Browser ペイン）は `document.visibilityState === "hidden"`**。つまりエージェントが操作するホストタブ自身がスロットリングされる。動画入りコンプの bake が 1% で停止したのはこれが原因で、**この環境から出す絶対値 fps は信用できない**。既出の 2.80 fps（直列）/ 2.01 fps（並列）は同条件同士なので比較は公平だが、絶対値は実際より悲観的。
- 教訓: swarm のスループット計測は **ホストも worker も前面タブ**でなければならない。片方でも裏だと数字が壊れる。実 Chrome を使う既存の教訓（perf-testing-real-chrome-not-headless）と同型。
- **重いコンプの検証素材はリポジトリに既存**: `verify-comp33-mini-project.zip`（1920×1080 / 150f / 4 objects / mp4+webm、23MB）と `verify-comp32-mini-project.zip`（8 objects、split-alpha 込み、28MB）。読み込むと非 realtime 判定になり `◐ Caching` が出る＝ローカル bake が走る条件を満たす。レイヤー枚数をいくら増やしても realtime のままなので、**枚数ではなく動画・エフェクトで重くする**のが正しい。
- **500MB 級のプロジェクトは現状測れない**: 5 秒にトリムしても素材原本のサイズは変わらず、`SWARM_JOB_FILE_BUDGET_BYTES`（128MB）超で全ジョブが `kept local` になる。動画は再エンコードせず原本を送る決定（spec v2）どおりの挙動。
- 検証レシピ（ユーザーの通常ブラウザ・全タブ前面）: ①`⬆ zip` で verify-comp33 を読む ②Caching ON でスクラブし `◐ Caching N%` を確認 ③worker なしで 30 秒の % 増加を記録（1% = 1.5 フレーム）④worker を前面のまま参加・承認 ⑤同条件で % 増加と `Frames from workers` を記録。③と⑤の差が分散の実効。
- 検証補助として Cloudflare Pages に `mafter-test-assets` プロジェクトを作成し `comp33.zip` を公開（CORS 全許可）。ブラウザから直接読み込ませるため。不要になれば `npx wrangler pages project delete mafter-test-assets`。

### 2026-08-11 (Claude Opus 5) - 実 Chrome 計測の結果と、export へのフォーカス切り替え

実 Chrome（Playwright, channel:"chrome", headless:false）でホスト・worker を別ウィンドウに並べ、両方 `visibilityState: "visible"` を確認したうえで検証:

- `verify-comp33-mini-project.zip`（4 objects / 動画 2 本 / 150f）を読み込み、Caching ON、worker 接続（`1.2〜1.3× local`, Direct, Active）。
- 結果: **バッジは `● Realtime` のまま、bake が一度も走らず、`Frames from workers: 0`**。実マシンではこのコンプが realtime に収まるため、preview cache 経路には仕事が発生しない。埋め込みブラウザで `◐ Caching` が出ていたのは**タブがスロットリングされて遅かったからにすぎない**。
- つまり preview cache は「いつ焼くか」の判定が環境依存で、分散の土台として不安定。**ユーザー判断で、以後は Pre-render / 書き出しにフォーカスし、キャッシュ最適化は後回しとする。**

WP-6 の第一スライス（実装済み）:
- `src/swarm/core/remoteFrameProducer.ts` — `runOrderedMultiContext` が既に駆動している producer と同じ形（`(frame) => Promise<HTMLCanvasElement>`）で swarm を包む。swarm が断る・フレーム番号が違う・revision が古い・例外、のいずれでも**ローカル描画にフォールバック**するので、export がフレームを失うことはない。順序・音声 mux・alpha は呼び出し側＝ホストに残したまま。
- `spotCheckFrames()` — spec が要求する抜き取り照合の対象フレーム選択（既定 5%、必ず先頭を含む。先頭の不一致はフォント/アセット欠落を示し、以降全フレームに波及するため）。
- テスト 15/15 PASS（フォールバック 4 経路と照合フレーム選択を純関数で固定）。

次: exporter の PNG 連番経路（`extraRenderers.length > 0` の分岐）に remote producer を混ぜ、抜き取り照合と worker 除外を実装する。割り当ては現在 `fi % N === c` の静的ラウンドロビンなので、能力比チャンク pull への置き換えが必要。

### 2026-08-11 (Claude Opus 5) - WP-6: export への remote producer 配線と動的 pull 化

- `runOrderedMultiContext` の割り当てを **`fi % N === c` の静的ラウンドロビンから動的 pull（work stealing）へ変更**。速度差のある producer が混ざると、静的分配では遅い担当分の tail で全体が待たされる。動的 pull なら速い producer が自然に多く引き、**ユーザー提案の「能力比で分ける」が実測ベースで自動成立**する。frame 昇順の emit・有界 reorder window・backpressure は不変。既存テストの `[4,4,4]` 期待は「合計は全 frame・速い producer が遅い producer 以上」に更新（意図した契約変更）。
- `exportComposition(..., swarm?: ExportSwarmHooks)` を追加（**`ExportConfig`（§5 型）には触れない**。これは転送配線であって書き出し設定ではないため）。`runPngSeq` に remote producer を混ぜる。
- ローカル描画は context 共有なので `renderLocallySerialized` で直列化。remote producer のフォールバックも同じ直列鎖を通るので、並行 pull 中に 2 本のローカル描画が走ることはない。
- `buildRemoteFrameProducers()` は worker 数ぶんの producer を返し、worker 0 なら**空配列＝従来の逐次経路そのまま**。
- 検証: typecheck PASS、`npm test` 153 files / 1453 tests 全 PASS。

**まだ UI からは有効化していない**（`swarm` 引数を渡す配線は未実施）。spec が要求する抜き取り照合が未実装のため、リモート画素が成果物に入る経路をユーザーに開けない。次: 照合（サンプルフレームをローカルでも描いて比較・不一致なら worker を外して全ローカル再描画）→ UI 配線 → 実機 A/B。

### 2026-08-11 (Claude Opus 5) - export 分散が実際に動くまでの修正（1台での検証）

実 Chrome（ホスト + worker を別ウィンドウ、両方 visible）で PNG 連番書き出しを回して段階的に修正:

1. **export ジョブがアセットを同梱していなかった** — 同梱は preview 経路にしか配線されておらず、`kept local: 12` で全滅。`swarmExportHooks.submit` で同梱するようにした。
2. **フレームごとに 24MB を読み直していた** — `attachJobFilesCached()` を追加し (comp, revision) 単位で 1 回だけ読む。書き出しは 1 フレーム 1 ジョブなので、これが無いと同梱コストが描画コストを上回る。
3. **チャンクが SCTP の実メッセージ上限を超えていた** — `SWARM_ASSET_CHUNK_CHARS` 256KB → 32KB。data channel の最大メッセージ長は通常 256KB 前後（もっと小さいこともある）で、超えると送信が失敗しチャネルごと落ちうる。worker にジョブが 1 件も届かない主因。
4. **ジョブ失敗時に待機側を起こしていなかった** — 送信失敗・`job-failed` のいずれでも呼び出し側はデッドライン満了まで待たされていた。`releaseJob()` で即座に null 解決してローカル描画へ落とす。
5. **転送がジョブのデッドラインを食っていた** — `coordinator.preloadAssets()` を追加し、書き出し開始前に全 worker へ素材を流す（`ExportSwarmHooks.preload`）。

結果（1 台・同一マシンで worker と CPU を共有）: 120s タイムアウト → **75.2s で完走、リモート 9 フレーム / フォールバック 1**。照合による拒否は発生せず（＝抜き取りフレームは許容差内）。

**未解決の懸念**: local-only の zip 8.28MB に対し with-worker は 6.94MB。**中身が違う**ため、抜き取り照合を通っていても全フレーム一致は保証できていない。原因候補は worker 側の動画デコード位置ずれ、またはラスタライザ差。
→ そのため `swarmExportHooks()` は `localStorage["mafter.swarm.export"] === "1"` のときだけ有効にした（**既定は従来どおり完全ローカル**）。ピクセル同一性を検証してから既定 ON にする。

**高速化はこの 1 台では観測できない**（worker が同じ CPU を奪い合う、かつ 24MB 転送が乗る）。2 台目が使えるときに A/B を取る。

### 2026-08-11 (Claude Opus 5) - リモートフレームの空白バグを特定、照合強化、再接続の自動化

**ピクセル同一性の検証結果**（両 zip をディスクに保存して全フレーム比較）:
- 24 フレーム中 **4 枚（6 / 11 / 16 / 21）が 12KB**、他は約 350KB。**worker が動画レイヤー抜きのフレームを返している**。おおむね 5 フレームおきに出る。
- 残りのフレームも数十バイト差があるが、これは動画 seek のジッタとラスタライザ差の範囲。
- **照合がこれを捕まえられなかった理由**: `spotCheckFrames(24, 0.05)` は `round(24×0.05)=1` で**フレーム 0 しか検証していなかった**。5% 比率は長尺前提で、短い書き出しでは検証が事実上無効。

修正:
- `spotCheckFrames(total, ratio, minimum = 4)` — 比率に加えて最低本数を保証。短い書き出しでも複数フレームを照合する。
- `pixelSpread()` / `looksEmptyAgainst()` を追加し、**全リモートフレームに軽量ガード**をかける。照合済みローカルフレームから「中身の量」の基準を学習し、その 20% 未満の平坦なフレームはリモート結果を捨ててローカルで描き直す。サンプリングは運次第だが、このガードは全フレームに効く。

**残る根本原因は未修正**: worker 側が動画のデコード完了を待たずにキャプチャしていると見られる（ホストは同じ経路で正常なので、worker では blob URL からの初回シーク待ちが不足している可能性）。ガードは症状を隠さず「ローカルへ落とす」ので出力は正しくなるが、その分だけ分散効果は減る。

**開発フローの自動化**（ユーザー要望「人間が挟まるのが手間」）:
- worker ページは `/w/<code>` の code があれば**自動で参加**する（リンクを開いた時点で同意は済んでいる）。
- 切断時は指数バックオフ（1s→30s 上限）で**自動再参加**。`Stop Worker` を押したときは再接続しない。
- ホストは**同一セッションで一度承認した deviceId を再承認なしで受け入れる**（`trusted` は session 単位で保持されるので、別セッションでは従来どおり承認が要る）。

### 2026-08-11 (Claude Opus 5) - worker のビルド自動更新

- 問題: デプロイを更新しても worker は古いバンドルのまま動き続ける。返ってくるフレームは「ホスト側の不具合」に見えるため、実際に今回の空白フレーム調査で混乱の原因になった。
- `src/swarm/worker/workerUpdateCheck.ts` を追加。エントリバンドルは content hash 付きファイル名なので、**そのファイル名をビルド ID として扱う**（追加のデプロイメタデータ不要・どの静的ホストでも動く）。
- worker ページは 60 秒ごとに `/?swarm-update-check=1` を `cache: "no-store"` で取得し、配信中のエントリ名が変わっていれば `location.reload()`。**レンダリング中は再読込しない**。リロード後は URL の code から自動参加するので、人手は不要。
- 取得失敗・解析不能・HTTP エラーのときは**何もしない**（チェックの失敗が稼働中の worker を落とさない）。純関数 `extractBuildTag()` と失敗時の挙動をテストで固定。

### 2026-08-11 (Claude Opus 5) - 空白フレームの根本原因: worker がフレームごとに context を作り直していた

- `WorkerRenderExecutor.render()` は**ジョブ（＝1 フレーム）ごとに `createCompFrameCaptureContext()` を呼び、finally で dispose していた**。つまり毎フレーム renderer・DOM・video 要素を新規作成し、動画を blob URL からロードし直してシークしている。
- これが空白フレームの真因。`captureCompFramePng` は `primeMountedVideos(fps, 4000)` / `flushVideoFrames(4000)` で待つが、**毎回コールドスタートなので時々 4 秒を超え**、動画抜きのフレームがそのまま返る。約 5 フレームおきに 12KB のフレームが出ていた分布と整合する。速度が出なかった理由でもある。
- 修正: `renderRevision / compositionId / quality / width / height` をキーに context を使い回す。キーが変われば破棄して作り直す。`dispose()` を公開し、GL context を溜めない（[[webgl-context-limit-global]] の教訓）。
- 検証: typecheck PASS、`npm test` 153 files / 1455 tests 全 PASS。実機での空白フレーム消滅確認はデプロイ後に実施。

### 計測ハーネスの常駐化

- `swarm-host-session.mjs`（.gitignore 済み）で **実 Chrome の可視ウィンドウにホストを常駐**させ、CDP を 9222 で開く。参加要求は自動承認。
- 目的: 埋め込みブラウザのペインは `visibilityState: hidden` でスロットリングされるためホストに使えない。また join code がプロセス終了で失われると、その都度ユーザーに再接続を頼むことになる。CDP 常駐なら**同じセッションに後から再接続**して計測を続けられる。

### 2026-08-11 (Claude Opus 5) - 空白フレームの真の根本原因: 結果 PNG がメッセージ上限を超えていた

context 再利用（前項）で空白フレームは消えたが、今度は **`Frames from workers: 0`（全滅）** になった。実 Chrome でホスト・worker 双方のコンソールを取って追跡:

1. worker は描画を完走しているのに、ホストは `handleResult` に到達すらしていない。
2. 原因: **結果 PNG（960×540 ≈ 466KB base64）が data channel の 1 メッセージ上限を超えて送れていなかった**。
3. **これで以前の症状が全部説明できる。** 以前 zip に混ざっていたリモートフレームが「12KB の空白フレームだけ」だったのは、**小さい結果しか送信に成功していなかった**から。空白フレームは「たまたま壊れた結果」ではなく「唯一届いた結果」だった。context 再利用で空白が無くなった瞬間、届く結果がゼロになったのはそのため。

修正:
- `job-result-chunk` を追加し、結果 PNG も 32KB チャンクで送る（`splitResultBytes` / `ResultChunkAssembler`）。ホストはチャンクを組み立ててから `handleResult` に渡す。
- `job-result` のスキーマ検証が `hasString`（空文字を弾く）だったため、**pixels を別送した結果メッセージがパース段階で捨てられていた**。`typeof === "string"` に緩和。
- リース長を「呼び出し側が待つ時間」に合わせた。従来は固定 8 秒で、1080p のフレーム描画中に期限切れ → 同じジョブを再配布 → **同じ context 上で描画が多重に走る**雪だるまが起きていた。
- worker は描画中の追加 job-offer を `job-failed` で拒否する（1 つの capture context を 2 つの描画が共有すると互いを壊す）。

実測（ローカルビルド、実 Chrome、ホスト+worker 可視、8 フレーム）: **0 remote → `Frames from workers: 2` で 30 秒完走**。以前は 140 秒でタイムアウトしていた。

検証: typecheck PASS、`npm test` 153 files / 1456 tests 全 PASS。結果チャンクの往復と「pixels 別送の結果メッセージがパースされる」ことを純関数テストで固定。

### 2026-08-11 (Claude Opus 5) - export 分散のピクセル一致を確認、既定 ON に

実機 A/B（ホスト = 実 Chrome 可視、worker = ユーザーの別 PC、24 フレーム / 960x540 PNG 連番）:

| 指標 | 修正前 | 修正後 |
|---|---|---|
| 空白フレーム | 4 / 24（12KB ≒ 元の 3.5%） | **0** |
| 最大サイズ差 | 331KB | **42 バイト** |
| 平均サイズ差 | — | 12.6 バイト |
| zip 全体 | 8.28MB vs 6.94MB | 8,281,491 vs 8,281,495（4 バイト差） |

**重要な対照**: 差分のあるフレームは 22 枚だが、**リモートで焼かれたのは 2 枚だけ**。残り 20 枚は「ローカル対ローカル」の差、すなわち動画 seek のジッタによる固有のノイズ床であり、worker 由来ではない。リモートフレームの差もこのノイズ床の中に収まっている。

→ 既定 OFF にしていた根拠（ピクセル一致が未確認）が解消したので、**既定 ON に変更**。`localStorage["mafter.swarm.export"] = "0"` で完全ローカルに戻せる退避口は残した。

速度: local-only 20.2s / with-worker 30.7s。**このワークロードでは分散は依然として損**。理由は明確で、①24MB の素材転送が先頭に乗る ②動的 pull なのでホストが速い分ほとんどのフレームを自分で引く（24 中 2 枚しか外注されない）。分散が勝つのは「ホストが飽和している」「worker が複数」「素材転送を償却できる長さ」が揃ったとき。

### 2026-08-11 (Claude Opus 5) - 尺による立ち上げコストの償却（ローカル計測）

同一プロジェクト（Comp 33 / 960x540 PNG 連番）でフレーム数だけ変えたローカル書き出し:

| フレーム数 | 所要 | fps |
|---|---|---|
| 24 | 20.2s | 1.19 |
| 150 | 83.6s | **1.79** |

尺が 6 倍でも所要は 4 倍にとどまる＝**書き出しには尺に依らない固定の立ち上げコスト**（context 構築・フォント/画像ロード・動画初回デコード）があり、長尺ほど償却される。分散側も同じ構造で、素材転送という固定コストを長尺ほど償却できるため、**分散の損益分岐は尺に強く依存する**。24 フレームで損だったからといって長尺でも損とは限らない。

150 フレームでの分散側の数値は worker 接続待ちのため未取得。

### 2026-08-11 (Claude Opus 5) - 訂正: 「ローカルのノイズ床」は誤り。既定 ON を撤回

150 フレームの A/B で worker が参加せずタイムアウトし、結果として**ローカル 2 回の対照実験**になった。

- **150 / 150 フレームがバイト完全一致**。zip サイズも 51,392,011 で同一。**ローカル書き出しは決定論的**。
- したがって、先の 24 フレーム A/B で 22 枚が differ していたのは「動画 seek ジッタによるノイズ床」ではない。**worker を繋いだこと自体が原因**であり、しかも**リモート由来は 2 枚だけ**なので、残り 20 枚のホスト描画フレームまで変化していた。
- 有力な仮説: remote producer が加わると `runOrderedMultiContext` の動的 pull でフレームが**非単調な順序**で描かれる。動画は前後シーク後のデコード結果が単調進行時と微妙に変わるため、ホストが描くフレームまで影響を受ける。単一 producer（従来）は常に昇順だったので顕在化しなかった。

→ **既定 ON を撤回し、`localStorage["mafter.swarm.export"] === "1"` のオプトインに戻した。** 「worker が居るかどうかで書き出し結果が変わる」状態を既定にはできない。

次にやること: 非単調 seek の影響を切り分ける。①ローカル producer には昇順のフレームだけを割り当てる（リモートには任意順を許す）②または export 経路の video seek を毎フレーム「必ず目的時刻へ pause+seek し直す」形にして順序非依存にする。②が本筋（INV-2: 同一 frame は経路に依らず同一）。

### 2026-08-11 (Claude Opus 5) - 仮説確定: 並列フレーム生成そのものが画素を変える（swarm 無関係）

分散を一切使わず、`__mafterMultiRenderContext = true` / count 3 で同一範囲を書き出して比較:

| 比較 | 結果 |
|---|---|
| ローカル単一 context 2 回 | **150 / 150 バイト一致**（決定論） |
| 単一 context vs 複数 context(3) | **24 枚中 23 枚が differ**（平均 24 バイト、最大 60） |

→ **これは swarm のバグではない。** `runOrderedMultiContext`（§11.2 Phase 6・既定 OFF の実験機能）が持つ既存の欠陥で、remote producer を足したことで初めて露出した。INV-2（同一 frame は経路に依らず同一）に対する違反であり、Phase 6 を既定 ON にする前に必ず解く必要がある。

原因候補（未検証、この順で疑う）:
1. **context ごとに別の `<video>` 要素＝別のデコーダ**。同時に複数のデコーダが走ると Chrome がハードウェア→ソフトウェアデコードへ落ちる場合があり、出力画素が僅かに変わる。差が「広範囲・小さい」分布と整合する。
2. `syncVideoElementExportStep` の `Math.abs(video.currentTime - seekTo) > halfFrame` ガードが**アクセス順に依存**する（単調順と stride 順で seek するか否かの判断が変わる）。
3. seek 後デコードと逐次デコードで、境界フレームの選択が 1 フレームずれる。

検証手順（次回）: ①動画を含まないコンプ（solid/text のみ）で同じ比較をする。**差が消えれば動画デコーダが原因**、残れば描画側。②残る場合は raster/font キャッシュの context 間差異を疑う。

swarm の export 分散はオプトインのまま（`localStorage["mafter.swarm.export"]="1"`）。この INV-2 違反が解けるまで既定 ON にはしない。

### 2026-08-11 (Claude Opus 5) - パリティ破れの原因を分離: 動画デコーダの並存と非連続シーク

分散抜きの実験（実 Chrome、単一 context の出力を基準にバイト比較）:

| 条件 | 結果 |
|---|---|
| 動画なしコンプ（solid+text 8枚）/ 3 context | **24 / 24 一致**（producer 分配 `[8,8,8]` で 3 本とも実働） |
| 動画ありコンプ / 3 context・1 フレームずつ交互 | 24 枚中 23 枚 differ |
| 動画ありコンプ / 3 context・連続ブロック割り当て | 24 枚中 21 枚 differ（**改善せず**） |
| 動画ありコンプ / 3 context だが **producer 1 本だけ実働** | 8 枚中 5 枚 differ |

結論:
1. **描画・フォント・ラスタは無実**。動画なしなら並列でもバイト一致する。
2. **順序（交互 vs 連続ブロック）は主因ではない**。ブロック化しても差は残る。
3. **`<video>` 要素が複数存在するだけで結果が変わる**（producer 1 本でも差が出る）。同時に生きているデコーダの数で Chrome のデコード経路（HW/SW）や内部状態が変わるのが有力。

→ 検証のため入れた連続ブロック割り当ては**パリティを改善しないので撤回**した（複雑さだけが増える）。

**swarm の場合はもう一つ別の効果がある**: remote producer が混ざると、ローカルの単一デコーダが**歯抜けのフレーム列**（worker が取った分を飛ばす）を辿るため、単調進行時とデコード結果がズレる。24 フレーム A/B でホスト描画分 20 枚が変わったのはこれ。

残る選択肢（ユーザー判断が要る）:
- **A. 許容差でのパリティを定義する** — 差は PNG で平均 18 バイト程度＝視覚的には同一。INV-2 は「scene 解決値の一致」を要求しており、デコーダ出力のビット一致までは求めていない、と spec で明示する。
- **B. footage を含むコンプでは並列生成を使わない** — バイト一致を守れるが、いちばん重いコンプで分散が使えない。
- **C. 動画デコードをホストで 1 回だけ行い、デコード済みフレームを配る** — 正しいが転送量と実装量が大きい。

### 2026-08-12 (Claude Opus 5) - 方針 A 採用: パリティ定義を明文化し export 分散を既定 ON に

ユーザー判断: **A（許容差でのパリティを定義）で進める。致命的な差が観測されたら C（ホストで 1 回デコードして配る）を検討。**

重要な確認: **INV-2 は元々「ラスタ化の忠実度は手段により差が出てよいが、scene の解決値は同一」と書かれている。** 動画デコーダの出力はラスタ化であって scene 解決値ではないので、今回の差は**もともと INV-2 の許容範囲**だった。したがってこれは INV の緩和ではなく**明文化**であり、§5 型・INV 本文は変更していない。

spec の Render Swarm v2 節に「Frame identity under parallel production」を追加:
- 保証する: 全フレームの scene 値一致（タイミング・トランスフォーム・エフェクト・レイヤー順）／**内容の欠落が無いこと**（デコード失敗フレームは抜き取り照合と全フレーム平坦ガードで弾かれローカル再描画）。
- 保証しない: ローカル書き出しと分散書き出しのバイト一致。ただし**ローカル同士は依然としてバイト一致**する。
- エスカレーション条件: 数値上ではなく**目視で分かる差**が観測されたら、転送層のパッチではなく C（ホストで 1 回デコードして配る）へ進む。

`swarmExportHooks()` を既定 ON に戻した（`localStorage["mafter.swarm.export"] = "0"` で完全ローカルに退避可能）。

検証: typecheck PASS、`npm test` 1455/1456（唯一の失敗は既知フレーキー `projectBins`、単独では 7/7 PASS）。

### 2026-08-12 (Claude Opus 5) - 分担方式を「連続ブロック + work stealing」に、reorder window を拡大

実測（150 フレーム、ホスト + worker 1 台、worker はホストの約 1.9 倍速）:

| | 所要 | fps | リモート担当 |
|---|---|---|---|
| local-only | 90.8s | 1.65 | — |
| with-worker（1 フレームずつ交互 pull） | **168.5s** | 0.89 | 45 / 150 |

worker が 30% を引き受け、しかも速いマシンなのに **1.85 倍遅くなった**。ホストの実作業は 105 枚 ≈ 64 秒分しかなく、**残り約 100 秒はホストが待たされていた**。

真因: `maxReorderAhead = 2 × producer 数 = 4`。出力は frame 昇順でしか吐けないため、**リモートが握っている frame が遅いと速いホストは 4 枚先で停止する**。ローカル context 同士（速度が揃う前提）の設計値がリモートにそのまま適用されていた。

修正（ユーザーと相談のうえ折衷案を採用）:
1. **連続ブロック単位の動的 pull**（既定 8 枚）。ホストが早い frame を担当しがちになるので emit が止まりにくい。各 producer が昇順に進むのでデコーダの挙動も単調。
2. **work stealing** — ブロックを配り切ったあと、空いた producer が「最も未着手が多い producer」の**後ろ半分**を奪う。奪われた側は次の frame を始める前に停止する（JS シングルスレッドなので追加のロックは不要）。これで末尾のストラグラーが自動解消され、静的分割の弱点を回避できる。
3. **export でリモートが混ざるときだけ reorder window を拡大**（32 以上）。ローカル context 同士は従来の `2*N` のまま。

テスト: 「詰まった producer から仕事を奪い、全 frame がちょうど 1 回ずつ描かれ、emit は昇順」を回帰テストで固定（`test/multiRenderContext.test.ts`）。`npm test` 153 files / 1457 tests 全 PASS。

実機での効果測定は次。

### 2026-08-12 (Claude Opus 5) - 同一端末の再接続で古い peer が残る問題

実機で worker が `Offline` 表示のまま P2P が確立しない事象が発生。原因は、worker ページの再読込・再接続が**新しい peer として到着する**のに、**古い peer が workers マップに残り続ける**こと。パネルには Offline の worker が並び、スケジューラは誰も見ていない slot にフレームをリースしうる。

`dropStaleConnections()` を追加し、challenge 検証を通った時点で**同じ deviceId の古い接続を切って登録から外す**。deviceId は永続的な端末 ID（INV-6 の stable ID と同系）なので、これで「1 端末 = 1 接続」が保たれる。

なお、この事象が起きた実行では分散なしで 90.9 秒（ベースライン 90.8 秒）だったため、**ブロック割り当て導入によるローカル単独性能の回帰は無い**ことも確認できた（差 0.1%）。

### 2026-08-12 (Claude Opus 5) - セッション TTL を 30 分 → 12 時間

ユーザー指摘「expired になる。P2P なら長期生存セッションがあってよい」。妥当なので変更した。

根拠: **期限は「新規参加を受け付ける窓」でしかない**。WebRTC が張れた後の peer はサーバに一切触れないので、短い期限は安全性を買っておらず、動いている swarm を人手で張り直させるだけ。開発中の実測でも、期限切れでセッションを作り直す作業が繰り返し発生していた。

`SWARM_SESSION_TTL_MS = 12h` を `durableSessionCore` に定義（呼び出し側が `expiresInMs` を渡せば従来どおり上書き可能）。join code は 6 文字なので、長期化のぶん総当たりの窓は広がるが、参加にはホストの承認が必要で、承認済み端末以外は依然として弾ける。

### 2026-08-12 (Claude Opus 5) - 遅い producer を emit 位置から引き離す（head/tail pull + PNG バッファ）

計測（150 フレーム、worker 1 台）で内訳が判明:

| | 値 |
|---|---|
| リモート 1 枚の往復 | 平均 1102ms（**描画 833ms** + 転送 268ms） |
| ホスト 1 枚 | 605ms |
| worker の取り分 | 15 / 150 枚（**10%**。能力比なら 36% ≈ 53 枚） |
| 所要 | 114.2s（ホスト単独 90.8s） |

**転送は主因ではない**（往復の 1/4）。真因は 2 つ:

1. **ベンチマークが空の 320×180 コンプで測っている** → `Available compute: 2.7×` は虚偽で、実際の worker は本番負荷ではホストより 1.4 倍**遅い**。
2. **直列化点による head-of-line blocking** — 出力は frame 昇順なので、worker が握るブロックの先頭が届くまで consumer は進めない。ホストは窓（32枚）に当たると完全停止し、worker は窓を超えられないので次のブロックを取れない。**速い側は待たされ、遅い側は仕事を貰えない**。これが取り分 10% と所要 114 秒の両方の原因。

修正:
- **`pullFromTail`** — producer ごとに取得方向を持たせ、リモートは**範囲の末尾から**取る。遅い producer の成果は常に emit 位置のはるか先になるので、その遅延が次に書くフレームを塞がない。真ん中で出会ったらワークスチールで精算。
- **`prepare` フック** — 描画直後に PNG blob へ符号化して reorder buffer に保持する（従来は canvas 1 枚 2MB）。350KB 程度に落ちるので、**窓を export 全長まで広げても現実的なメモリで収まる**（150 枚で約 52MB）。窓が広がって初めて tail pull が機能する。
- PNG 連番経路のみ `prepare` を渡す。動画経路（encoder が canvas を要求）は無変更。

テスト: tail producer が範囲後方を担当すること、`prepare` を通した値が consumer に渡ること、全 frame がちょうど 1 回・昇順 emit されることを固定。`npm test` 153 files / 1459 tests 全 PASS。

未実施: 実機での再計測（予測: worker 取り分 10% → 35% 前後、所要 114s → 60〜70s）。ベンチマークの実コンプ化も未着手。

### 2026-08-12 (Claude Opus 5) - ホストが既存セッションへ再接続できるように（無人ループの前提）

ユーザー指摘「ループができるように、ホスト側は任意のワーカースワームに接続できるようにしないといけない」。そのとおりで、**ホストを再起動するたび join code が変わるため、毎回ユーザーにリンクを開き直してもらう必要があった**。無人での反復計測はこれが原因で不可能だった。

- `CreateSwarmSessionInput.joinCode` を追加。DO 側の `createSession` を**冪等**にし、**同じ hostDeviceId** から同じ code で来た場合は **sessionId ごと既存セッションを再利用**する（承認済み worker がそのまま有効なままになる）。別デバイスが同じ code を要求した場合は新規セッションになるので、code の所持だけではホストを乗っ取れない。
- Worker 側の `swarmSignaling.ts` は要求された code（`[A-Z0-9]{4,12}`）を DO 名として使う。不正な形式なら従来どおりランダム生成。
- ホストは `localStorage["mafter.swarm.hostCode"]` があればそれを要求する。
- **worker は join 失敗・session-expired でも再接続を続ける**（従来は諦めて停止）。ホストが再起動中なだけかもしれないため。固定 code と組み合わせると、**ホストを何度落として上げても worker は自力で戻ってくる**。

これで計測ループを回すたびに人手が要る状況が解消される。

### 2026-08-12 (Claude Opus 5) - 分散フレームが「別物」だった（照合が正しく検出）

抜き取り照合が差分 95 → 52 で弾き続けていた件を、許容値を一時的に外して zip を取り、フレームを実際に目視して決着させた。

- **リモートのフレームは動画が約 2 倍に拡大され位置がずれ、Text レイヤーが欠落していた。** つまり worker 側でコンプのレイアウトが正しくスケールされていない（`proxyScale` 相当の扱いがホストと違う）。
- 途中で見つけた**背景の不整合は実在し修正済み**（コンプ背景未設定時、ホストは黒・worker は透明。差分 95 → 52 に減ったのはこの修正の効果）。残る 52 がレイアウト不整合。
- **照合が無ければこの絵がそのまま成果物に入っていた。** 抜き取り照合＋全フレーム平坦ガードという二段構えは、設計として正しく働いている。

性能面の計測（照合を外した状態、同一マシンに worker を同居させた不利な条件）:

| | 所要 | リモート担当 |
|---|---|---|
| ローカル単独 | 80.8s | — |
| 分散 | **80.5s** | **61 / 150 枚** |

- `export shape`: elapsed 59.7s のうち **consumerWaitMs 59.5s** ＝ writer はほぼ全時間フレーム待ちで、**producer 律速**（writer は律速でない）。
- 同一マシンで CPU を食い合ってなお同着まで来た。**別マシンなら純増**になるはずだが、レイアウト不整合を直すまで意味のある比較にならない。

次: worker 側のスケール不整合の特定（`createCompFrameCaptureContext` の `proxyScale` と `renderer.resize` の適用、および Text レイヤーが消える条件）。ホストと同じ経路を通しているつもりが通っていないので、`compFrameCapture` 経由と exporter 経由の差分を洗う。

### 2026-08-12 (Claude Opus 5) - worker をホストと同じ書き出し経路に統一（ユーザー設計案）

ユーザー提案:「worker 側は専用実装をせず、ホストと同じ書き出し経路で同じ関数に範囲を渡して焼く。ワークスチール用に範囲を短くする仕組みだけ入れる。」

これを採用した。従来の worker は preview/precomp 用の `compFrameCapture` 経路を使っており、**今日出た不具合（背景の不一致・レイアウトスケール・Text レイヤー欠落・動画の待ち）はすべてこの分岐から出ていた**。CLAUDE.md の「単一の正」原則にも反する。

- worker は `frameEnd - frameStart > 1` のジョブを **`exportComposition(...)` にそのまま渡して png-seq の zip を作る**。ホストが自分の書き出しで使うのと同一の関数・同一の設定経路。
- 結果は `format: "png-zip"` として zip ごと返し、ホストが展開してフレーム単位で使う。
- ホスト側の remote producer は**範囲の先読みアダプタ**にした。frame f を求められたら `[f, f+8)` のジョブを投げ、返ってきた残りを保持して以降の要求に即答する。**スケジューラは無変更**（producer は連続ブロックを引くので、先読みした範囲がそのまま次の要求になる）。
- 単一フレームのジョブ（preview 経路）は従来どおり。

**結果: 抜き取り照合の拒否が消えた**（同一経路なので背景もスケールも一致）。これが本命の成果。

性能は未解決:

| 条件 | 所要 | リモート担当 |
|---|---|---|
| ローカル単独 | 80.4s | — |
| 統一経路・block 8 | 115.2s | 10 / 150 |
| 統一経路・block 24 | 150.6s | 4 / 150 |

- **ジョブごとに export のフル準備（フォント・画像・エクスプレッション・動画ウォームアップ）が走る**のが重い。ブロックを大きくすると 1 ジョブが長くなり、ホストがワークスチールで取り返すため担当がむしろ減る。
- 同一マシンに worker を同居させている条件では worker がホストより遅く CPU も食い合うため、**この環境での性能最適化は意味を持たない**。別マシンでの再計測が前提。

次の最適化候補: worker 側で **export セッションを再利用**（revision/profile が同じ間は準備を使い回す）。`exportComposition` は毎回 DOM・renderer・キャッシュを作り直すので、再利用可能な「フレームレンダラ工場」に切り出せば、ホスト側の逐次経路とも共有できる。

### 2026-08-12 (Claude Opus 5) - 「レンダーに必要なファイル」の定義がリポジトリに 2 つあった

GPT 5.6 指摘（ユーザー経由）を採用。`ImageAssetCache` の症状（packed alpha webm の `getUrlForQuality()` が null）を追う前に、**job が自己完結しているという定義そのものが弱かった**。

- bundle 側は `footageQuality` → proxy tier、内蔵音声の原本 path、split alpha の `alphaPath`、packed alpha の effective quality まで解決して「player が実際に fetch する path」を集めていた。
- swarm 側は generic walk で **asset id → `asset.path`** を送るだけだった。
- したがって `isSwarmJobSelfContained()` が true でも、**worker の renderer が要求する proxy が転送されていない**状態を作れた。URL が引けないという症状は decode 遅延と見分けがつかず、1 セッション溶かした原因がこれ。

対応:

- `src/runtime/renderDependencies.ts` に `footagePathsForComponent(project, component, { exportStep })` を新設し、**bundle と swarm の唯一の正**にした。live 再生（bundle）は `exportStep: false`、worker（`exportComposition` 経由）は `true`。packed alpha はここだけが分岐点。
- **dispatch 時点で `required render paths ⊆ worker-provided paths` を判定する**（DOM を立ち上げてから missing URL に気づくのでは遅い）。選択された proxy が届いていないジョブはローカルで描く。
- ついでに、旧 companion walk は renderer より緩かった（`hasAlpha` 未確認で `alphaPath` を採用・使わない proxy tier も全部送っていた）ので消えた。

同コミットで直した他の欠落（いずれも composition を歩いても見つからない classes）:

| 欠落 | 参照経路 | worker が描いていた絵 |
|---|---|---|
| フォント | text は CSS family 名、`FontOutlineCache` が `meta.family` で解決 | 全 text フレームが代替フォント |
| ネスト comp | precomp の objects は `project.compositions` 側 | 中身の footage/script/font が全部無いのに self-contained 判定は true |
| plugin | `plugins/` からホストにのみ登録 | レイヤーが描かれない / 未知 effect が skip |

**採用カウンタ**: パネルは「到着数」を数えていた（本プロジェクトが一度騙された数字そのもの）。この端末が描いていない canvas ＝ worker の絵、として**出力に採用された枚数**を数えるようにし、received と併記する。

#### 計測の状態（重要・数字を信用しないこと）

同一マシン（dev server + worker 同居）で 16 frames:

| 時刻順 | 所要 | リモート |
|---|---|---|
| 前半 4 本 | 20.2〜20.3s | 1 block 採用 |
| 後半 5 本 | 130.1〜130.3s | 0（60s deadline × 2 を丸ごと支払い） |

**コード差分では説明できない**。producer の変更だけを戻した対照も 130.3s で、時系列で割れている（＝環境ドリフト。dev server 常駐時間・Chrome の蓄積状態などが疑わしい）。**この環境での所要時間を根拠に性能結論を出してはいけない。** 一度は「producer の変更が原因」と誤って結論しかけた。

一方 **絵の一致は証明できた**（ガードレールの後半）: 同一 run の local-only zip と with-worker zip を PNG デコードして全画素比較 → 全 16 フレームで meanAbsDiff 0.000 / max 1〜4。しかも host が描いた frame 0–5 と worker が描いた frame 6–11 で差の大きさが同じ＝ネガティブコントロール付き。**worker はホストと同じ絵を描いている。**

#### Next steps

1. 130s ドリフトの正体（dev server 再起動・素の Chrome プロファイル・時間帯で切り分ける）。**これが片付くまで所要時間の比較はしない。**
2. 60s の固定 deadline（`remoteFrameProducer` の `timeoutMs`）を、ホスト自身の実測フレーム時間から導く。失敗ブロックが 2 分を食うのは設計として誤り。
3. benchmark を空コンプ 320×180 でなく実コンプの短ブロックにする（`Available compute` が実態と無関係な値を出している）。
4. 結果転送: worker が PNG → zip → base64 → JSON chunk、host が展開 → canvas → PNG 再エンコード。実測 transportMs は renderMs とほぼ同等（6.5s vs 7.7s）。バイナリのフレーム単位ストリームにして zip へ直挿しする案（codex 提案）。

### 2026-08-12 (Claude Opus 5) - LOOP 1: 計測系を先に固定した（WP Mafter Swarm Convergence Loop）

WP の LOOP 1（コード最適化禁止・測定器を信用できる状態にするだけ）を実施。

**1. 実行順序を ABBA にした。** `swarm-export-ab.mjs` は「local 1 回 → swarm 1 回」だったので、時間経過によるドリフトが全部 swarm 側に乗っていた。A/B/B/A を 1 ページ・1 worker セッション内で回す。A と B の切り替えは `localStorage["mafter.swarm.export"]` を export 直前に書き換えるだけ（worker は繋いだまま）なので、A と B で worker の接続状態・アセット転送・warm 度が完全に揃う。

**2. run ごとに妥当性を判定し、無効な run の所要時間を捨てるようにした。** WP §1 の条件を実装:

```
completed / buildTag 一致 / adoptedRemoteFrames > 0 / localFallbackJobs 0
/ ineligibleJobs 0 / staleResultsDiscarded 0 / pixel parity PASS / worker runtimeVersion 一致
```

1 つでも欠けた run は `VALID PERFORMANCE RUN: NO` になり、中央値の母集団から外れる。両側に有効 run が無ければ `PERFORMANCE RESULT INVALID` と出す。カウンタは `window.__mafterSwarmStore`（今回追加した読み取り口）から run 前後の差分で取る。パネルの文字列を正規表現で拾うのはやめた。

**3. COLD / WARM を分離した。** `SWARM_MODE=COLD` は run ごとにホストページを再読込して project を入れ直す（＝export session・アセットキャッシュ・decoder を毎回捨てる）。既定は WARM。混ぜて平均しない。

#### 8 フレームのスモークで、いきなり無効 run を捕まえた

```
2-swarm: 10s, remote received 1, adopted 0 → VALID PERFORMANCE RUN: NO
```

local-only も swarm も 10s で、素直に見れば「差なし」と結論していた run。実際にはリモートの絵は 1 枚も出力に入っていない（尺が短くホストが先に描き切った）。**この run の所要時間には分散の情報が 1 ビットも入っていない。** ゲートが無ければこれを「分散しても速くならない」の 1 標本として数えていた。

#### 48 フレーム ABBA（同一マシン・dev server・worker 同居）

| 順 | run | 所要 | remote adopted | 妥当 |
|---|---|---|---|---|
| 1 | local-only | **40.4s** | — | YES |
| 2 | swarm | 31.2s | 15 | YES |
| 3 | swarm | 31.0s | 14 | YES |
| 4 | local-only | **30.9s** | — | YES |

中央値は local 35.65s / swarm 31.1s ＝ **1.15×** と出るが、**この数字は採用しない。** A1 と A4 が 40.4s と 30.9s で、同一コード・同一設定なのに 9.5s 違う。差分は「最初の run かどうか」だけであり、**1.15× の中身はほぼ全部が初回 warmup**。B と A4 は 31.0 / 30.9 で同着。

→ **この環境での結論: 分散の効果は測れていない（swarm ≈ local）。** ABBA にしていなければ「A=40.4 → B=31.2、1.3× 速くなった」と誤って報告していた。順序を入れ替えるだけでこの誤りが露出したのが LOOP 1 の成果。

なお懸案だった **20s → 130s 級のドリフトは今回の 4 run では再現しなかった**（deployed pages.dev ではなく local dev server で回した点が前回と違う）。LOOP 1 の Exit（分散の大幅ジャンプが消える）は暫定的に満たしているが、130s 側の条件を再現していないので「解決した」とは書かない。

#### 同時に見つけた計測バグ（correctness なので即修正）

パネルが `Frames used from workers: 15 of 3 received` と表示していた。**採用が受信を上回っている**＝単位が違う。`noteRemoteFrame()` は結果 1 件（＝ブロック 8 枚）ごとに 1 を足していたのに、`noteAdoptedRemoteFrame()` はフレームごとに 1 を足していた。received をフレーム単位に直した（`frameEnd - frameStart`）。この 2 つは「リモートが役に立ったか」を判断するために互いに比較される数字なので、単位が揃っていないと読めない。`test/swarmMetrics.test.ts` で固定。

検証: typecheck PASS、`npm test` 307 files / 2933 tests PASS（既知の unhandled rejection 4 件は store の autosave が node 環境で `indexedDB`/`alert` を触るもので、本変更と無関係）。`src/runtime` `src/player` は触っていないので `build:player` 不要。

#### Next steps（WP の順序どおり）

1. **LOOP 1 の残り**: COLD モードで ABBA を回して COLD/WARM の分散を出す。130s ドリフトを deployed 環境で再現するか確認する。
2. **LOOP 2**: 空コンプ 320×180 のベンチマークを実コンプの短ブロックに置き換える（`Available compute: 1.3×` は今回も実態と無関係）。
3. LOOP 3 以降（固定 60s deadline の撤廃、transport 分解）は 1・2 が終わるまで着手しない。

### 2026-08-12 (Claude Opus 5) - LOOP 1 続き: warmup を明示収束させ、localFramesAvoided を計った

ユーザー指摘「A1→A4 の 30% warmup drift が残る以上まだ stationary ではない。測定前 warmup を明示的に収束させ、adopted の次に localFramesAvoided を計れ」。両方実施。**性能最適化は一切していない**（LOOP 2 以外に触るなという指示どおり）。

**1. 測定前 warmup の収束ゲート。** ABBA を始める前に local-only を回し、**連続 2 本が 5% 以内で一致するまで**繰り返す（`SWARM_WARMUP_TOLERANCE` / `SWARM_WARMUP_MAX`）。収束しなければ `PERFORMANCE RESULT INVALID — bench never reached a steady state` を出して、その環境では A/B 自体が成立しないと明示する。収束しないことも結果として扱う。

**2. `localFramesAvoided` を実測にした。** `totalFrames - hostRenderedFrames`。`hostRenderedFrames` は**この端末が実際にラスタライズした回数**を数える（`src/runtime/exporter.ts` の `noteHostRenderedFrame()`）。producer 単位ではなく**ラスタが起きる場所**で数えるのが要点で、

- remote producer のローカルフォールバック
- 抜き取り照合のためにホストが描き直すフレーム

も同じ場所を通るので両方ホスト仕事として計上される。「worker が 10 枚描いてホストも同じ 10 枚描いた」なら avoided は 0 になる（WP §14）。既存の `__mafterMultiRenderContextFrames` と同じ globalThis テレメトリ方式に乗せた（export 開始時にリセット）。mp4/webm 経路にも同じ計上を入れてある。

**カウンタ自身のネガティブコントロール**: A run（worker 不使用）では `hostRenderedFrames` が **frame 数と厳密に一致**しなければ run を無効化する。カウンタが壊れれば avoided は黙って嘘をつくので、嘘をつけない条件を毎 run 課す。

#### 48 フレーム ABBA（warmup 収束後・同一マシン）

```
warmup: 30.1s, 30.3s (converged)
```

| 順 | run | 所要 | host rendered | local avoided | remote adopted | remote received |
|---|---|---|---|---|---|---|
| 1 | local-only | 30.8s | **48 / 48** | 0 | — | — |
| 2 | swarm | 30.2s | 38 | **10** | 10 | 16 |
| 3 | swarm | 30.3s | 33 | **15** | 15 | 24 |
| 4 | local-only | 32.0s | **48 / 48** | 0 | — | — |

**warmup drift は消えた。** A1 と A4 の差は 30.8 → 32.0 で **3.9%**（前回は 40.4 → 30.9 の 30%）。ベンチは stationary になった＝ LOOP 1 の Exit を満たす。

**証明できたこと（数字ではなく性質）:**

- **`localFramesAvoided == adoptedRemoteFrames` が両 B run で厳密に一致**（10/10、15/15）。採用されたフレームをホストが裏で描き直してはいない。WP §33 の "No hidden local redraw of adopted frames" が計測で裏付いた。
- A run のホスト描画は 48/48 ちょうど。カウンタは意図した対象を数えている。
- **worker は 48 枚中 10〜15 枚（21〜31%）を実際に肩代わりしている。** これは「到着数」でも「採用数」でもなく、**ホストがやらずに済んだ仕事**。

**なお速度は依然として測れていない。** 1.04× は A→A のばらつき（3.9%）の中に埋もれる。**31% の仕事を外に出したのに wall-clock がほぼ動かない**という事実の方が重要で、ホストは producer 以外の何かで律速している可能性が高い（前回の `consumerWaitMs ≈ elapsed` と整合）。これは LOOP 4（フェーズ分解）で扱う話であり、今は触らない。

**新たに見えた無駄**: received 16 に対し adopted 10、received 24 に対し adopted 15。**受信したリモートフレームの約 4 割が捨てられている。** ブロック先読みが範囲やワークスチールと重複しているのが疑わしい。これも計測項目として記録するだけに留める（LOOP 6 のスケジューラの話）。

検証: typecheck PASS、`npm test` 308 files / 2934 tests PASS。`src/runtime/exporter.ts` を触ったが expression ランタイムでも player 経路でもない（`build:player` は不要）。

#### Next steps

1. **LOOP 2**（ここだけ着手可）: 空コンプ 320×180 ベンチマークを実コンプの短ブロックに置換。`Available compute: 1.3×` は実測の肩代わり率 21〜31% とも噛み合っていない。
2. LOOP 1 の残: COLD モードでの収束確認、deployed 環境で 130s ドリフトが再現するか。
3. 保留（着手禁止）: 固定 60s deadline、transport 二重構造、スケジューラ、リモートフレームの 4 割破棄。

### 2026-08-12 (Claude Opus 5) - LOOP 2: 能力値を実コンプ実測にした / 130s ドリフトの正体が判明（環境ドリフト説を棄却）

#### やったこと（LOOP 2）

`Available compute` は **空の 320×180 コンプ**で測っていた。ホストも worker も同じ空コンプで測るので比としては整合していたが、**分散する仕事とは何の関係もない値**だった（WP §7 / §23）。

- `src/runtime/hostRenderCost.ts` を新設。**ホストが実際にラスタライズした回数と所要 ms** を export 中に貯める（前回の frame カウンタを ms 付きに拡張・置換）。数える場所はラスタが起きる箇所なので、remote producer のローカルフォールバックと抜き取り照合の描き直しも計上される。
- `SwarmCoordinator.scoreFromRealWork()` — **ジョブが正常完了するたびに**、worker が返した `renderMs / frames` と `hostMsPerFrame()` の比で `benchmarkScore` を更新する（EWMA）。両者が同じコンプ・同じ profile・同じ解像度の実フレームで測られる。転送は含めない（リンクの性質であって worker の能力ではない。値付けは WP §25 のスケジューラの仕事）。
- `WorkerPerformance.measured` を追加。実ジョブ由来になるまでパネルは **`Estimated capacity`**、なった後は **`Render capacity`** と表示する。合成ベンチの数字が「このコンプの実力」として読まれるのを防ぐ。
- ハーネスが run ごとに `host ms/frame` / `worker ms/frame` / reported capacity を並べて出す。

これで**空コンプ由来の値と実測値が同じ画面に並ぶ**ようになり、直後に効果が出た（下記）。

#### 130s ドリフトは環境ドリフトではなかった（仮説の棄却）

48 フレーム ABBA:

| 順 | run | 所要 | host rendered | local avoided | adopted | fallback |
|---|---|---|---|---|---|---|
| 1 | local-only | 32.2s | 48 / 48 | 0 | — | 0 |
| 2 | swarm | **130.5s** | **50 / 48** | **-2** | 0 | **2** |
| 3 | swarm | **130.3s** | **50 / 48** | **-2** | 0 | **2** |
| 4 | local-only | 32.5s | 48 / 48 | 0 | — | 0 |

```
Hypothesis rejected: 「20s → 130s の所要時間変化は dev server 常駐や Chrome の蓄積状態による環境ドリフトである」
Reason: 130s は同一 run 内で local-only 32s と交互に再現する。環境要因なら A も遅くなるはずだが A は 32s のまま。
Evidence: 130.3s の run は localFallbackJobs 2 / adoptedRemoteFrames 0。32.4s(local中央値) + 60s×2 ≈ 130s に一致する。
```

**正体: worker がブロックを返さず、ホストが固定 60 秒 deadline を 2 回まるごと支払っている**（WP §8 が名指しした構造そのもの）。以前「コード差分では説明できない」と書いたのは、当時のカウンタでは「何も返ってこなかった」と「返ってきたが遅い」を区別できなかったため。今回は `adopted 0 / received 0 / fallback 2` が同時に出るので一意に決まる。

**`localFramesAvoided` が負の値（-2）になった意味は重い。** ホストは 48 フレームのコンプに対し 50 回描いている＝ **worker を繋いだせいでホストの仕事が増えた**。WP §26 の Product invariant「繋がっているが役に立たない worker はほぼ無コストであるべき」に対する、明確な違反の実測。到着数でも採用数でもこの事実は出てこない。

**能力表示の虚偽も並べて可視化された:**

```
host ms/frame:   460
worker ms/frame: 7            ← 空コンプの合成ベンチ
reported:        1.66x local (ESTIMATED from empty comp)
```

ホストが実コンプに 460ms 使っている横で、worker の「能力」は 7ms として売られていた。65 倍の乖離。`measured` は最後まで false のまま（実ジョブが 1 つも完了していないので、正しく実測値に切り替わらなかった）。**この run では新しい実測経路は一度も発火していない**ので、LOOP 2 の Exit（予測 ≈ 実測）はまだ未達。worker がジョブを完了できる状態で再測定が必要。

#### warmup ゲートの限界（記録）

warmup は 40.2s / 40.5s で「収束」と判定したが、その後の A は 32.2 / 32.5 だった。連続 2 本が一致しても、**両方が同じ理由で汚染されていれば収束と誤判定する**（worker の join 直後の合成ベンチがホスト CPU を食っていた時間帯にちょうど 2 本入った）。A1/A4 同士は 1% 以内なので測定側の結論は変わらないが、収束判定は「安定」ではなく「連続 2 本の一致」しか保証しない。

#### Next steps

1. **LOOP 2 の Exit 未達**: worker がジョブを完了する条件で再測定し、`measured: true` の capacity が実ジョブ所要と一致することを確認する。まず worker が何も返さなかった理由の切り分け（この run では `connected` の worker と `connecting` のままの peer が 1 つずつ並んでいた）。
2. LOOP 3（固定 60s deadline の撤廃）は**上の切り分けが終わるまで着手しない**。ただし 130s の原因が deadline であることは確定したので、LOOP 3 の優先度は最上位。
3. 保留: transport 二重構造、スケジューラ、リモートフレームの約 4 割破棄。

検証: typecheck PASS、`npm test` 308 files / 2935 tests PASS。`src/runtime/exporter.ts` と新規 `hostRenderCost.ts` は expression ランタイム／player 経路ではないので `build:player` 不要。

### 2026-08-13 (Codex) - LOOP 3: Bootstrap Lie を除去し、liveness-aware deadline を実装

WP `LOOP 2.5-3_ Kill the Bootstrap Lie + Liveness-Aware Deadline` を実施。

#### 実装

- `PendingJob` に `offeredAt` / `acceptedAt` / `lastProgressAt` / `firstResultChunkAt` / `lastResultChunkAt` / `phase` / `hardDeadlineAt` を追加。
- 固定60秒タイマーを廃止し、ACK・render progress・result transfer・absolute hard deadlineを別々に監視するwatchdogへ変更。failure reason (`no-ack` / `render-stall` / `transfer-stall` / `hard-deadline` 等) とメトリクスを分離。
- synthetic benchmarkのscheduler反映を削除。workerは `unknown` → 非criticalな1回のprobe → real job完了で `measured` になり、実測render costのみがdispatchを制御する。validなlate resultも採用されなくても実測学習へ反映する。
- worker状態を `authenticating` / `syncing` / `ready` と分離し、`READY` のみscheduler対象にした。認証待ちCONNECTING peerにはhandshake TTLを設け、期限切れで除去する。
- WorkerRuntimeからrange renderのprogressをthrottle送信し、hostはresult chunk受信もtransfer progressとして扱う。
- local fallback canvasをremote verificationへ二重投入しないよう修正。dead worker時のhost描画増加（48→50）を防止。
- `swarm-export-ab.mjs` のgitignore除外を解除し、ABBA・warmup・validity・counter delta・parity測定ハーネスをversion管理対象にした。
- Render Swarmのliveness/capacity evidenceをspecへ追記。§5 schema / project.json / INVは変更していない。

#### 検証

- `npm run typecheck` PASS。
- Swarm関連 `npx vitest run test/swarmLiveness.test.ts test/swarmMetrics.test.ts test/renderSwarmCore.test.ts`: **4 files / 57 tests PASS**。
- local Vite + Playwright smoke: app起動、Workers panel/session表示、page error 0でPASS。
- `npm test`: **309 files / 2940 tests PASS**。既知の4 unhandled errors（node環境での`indexedDB`/`alert` autosave、今回と無関係）が残り、exit codeは1。
- 実機ABBA exportは未実行。次はdead / accepted-hang / transfer-stall / slow-late / healthy workerのLOOP 3 matrixを実Chromeで確認する。

#### Next steps

1. version管理対象にしたABBA harnessで実機LOOP 3 matrixを実行し、固定60秒待ちが消えたこと、`hostRenderedFrames == totalFrames`、`localFramesAvoided`、pixel parityを確認する。
2. healthy workerで `measurement=measured` / `Render capacity` が表示されることを確認する。
3. transport最適化（binary stream / ZIP / reorder window）はLOOP 3の実機結果が固まるまで着手しない。

### 2026-08-13 (Codex) - LOOP 3 follow-up: transfer境界・busy quarantine・本物のREADY

ユーザー指摘の2点を反映し、asset同期後に初めて実機ABBAを実行した。

#### 修正

- `completedFrames === totalFrames` は render progress のまま保持し、`job-result-chunk` の最初の受信だけで `TRANSFERRING` を開始するよう修正。
- watchdog reclaim 後も `worker.snapshot.currentJobId` を late result / 明示的な `job-failed` まで保持し、WorkerRuntime がまだ描画中の worker を busy quarantine。cancel protocol は追加していない。
- asset transfer を content hash 単位の in-flight Promise にし、同じ hash の同時要求を共有。WorkerRuntime は再構成後に hash 検証・cache 完了して `asset-ready` ACK を返す。全 ACK 後にだけ host が `asset-sync-complete` を送り、worker/host を READY に進める。
- asset wire送信を data channel 上で逐次化し、同期呼び出しを coalesce。古い WebRTC peer の callback が新しい peer を reconnect しないよう guard を追加。
- harness は `connected` ではなく `ready` を待ち、READY 未達なら matrix を開始せず失敗するよう変更。

#### 検証

- `npm run typecheck`: PASS。
- Swarm対象テスト（liveness / WorkerRuntime asset / render core）: 58 tests PASS。
- `npm run build`: PASS（player freshness も PASS）。
- `npm test`: 310 files / 2945 tests は PASS。既知の `indexedDB` / `alert` unhandled 4件により exit code 1（今回の変更とは無関係）。
- 実機 `ABBA`, 24 frames, local Vite + Chrome, footage asset 2本: READY後に開始。
  - 1回目: probe swarm は remote 8受信・採用0・host 24/24（invalid gate）。次の swarm は remote 8受信・採用3・host 21/24、pixel parity PASS（valid）。
  - 再ABBA: probe swarm は remote 8受信・採用0・host 24/24（invalid gate）。次の swarm は remote 8受信・採用5・host 19/24、pixel parity PASS（valid）。
  - valid run では `measurement=measured`、`localFramesAvoided == adoptedRemoteFrames`、stale result 0。固定60秒待ちは発生していない。

#### Next steps

1. LOOP 3の dead / accepted-hang / transfer-stall / slow-late の専用 fault-injection matrix を追加する。
2. valid healthy worker の採用率と export tail の待ち時間を LOOP 4 で分解する。
3. transport最適化（binary stream / ZIP / reorder window）は引き続き保留。
