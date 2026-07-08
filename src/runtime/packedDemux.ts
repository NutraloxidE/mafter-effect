/**
 * videoDecoder-compiled-leaf plan Phase 1 — packed alpha 動画（mp4/webm、いずれも本アプリ自身の
 * エンコーダ — `src/editor/subjectExtract/encodeAlphaWebm.ts` / `src/runtime/webcodecsVideoEncode.ts` —
 * が生成したもの）のバイト列を、`VideoDecoder` に渡せる `EncodedVideoChunk` 列へ変換する層。
 * レンダリング・resolve() には一切関与しない（バイト列 → 構造化データの変換のみ、DOM/network なし）。
 *
 * 対象は自前生成の packed alpha 資産のみに限定してよい（任意の第三者 mp4/webm を汎用 demux する
 * 汎用ライブラリではない）。そのため webm 側はコーデックが常に "V_VP9"、mp4 側は mp4box の
 * `track.codec` が既存 avcCodecString() の出力をそのまま反映する、という自前エンコーダの前提に
 * 依存してよい。
 */

import { createFile, DataStream, Endianness, MP4BoxBuffer } from "mp4box";
import type { ISOFile, Movie, Sample, Track } from "mp4box";

export interface PackedEncodedChunk {
  /**
   * マイクロ秒。webm 経路は muxer が ms 丸め（TimestampScale=1e6ns）してから書き出すため、
   * この値は情報用途にとどめる。VideoDecoder への実際の再投入時刻は `packedFrameDecoder.ts` が
   * chunk の配列 index（decode 順・エンコード時の frame index と 1:1）から再構成する
   * （§ INV-2 の錨は index 基準・timestamp 文字列の往復精度に依存しない）。
   */
  timestamp: number;
  duration: number;
  keyFrame: boolean;
  data: Uint8Array;
}

export interface PackedEncodedStream {
  /** WebCodecs `VideoDecoderConfig.codec`。 */
  codec: string;
  /** H.264 の avcC（AVCDecoderConfigurationRecord）。VP9 は undefined。 */
  description?: Uint8Array;
  /** packed 動画の総幅（px）。 */
  codedWidth: number;
  /** packed 動画の総高さ（px、`2*contentHeight+gutterPx` 相当）。 */
  codedHeight: number;
  frameCount: number;
  /** decode 順（= encode 時の frame index 順）に並んだ chunk 列。 */
  chunks: PackedEncodedChunk[];
}

export async function demuxPackedVideo(bytes: Uint8Array, mime: string): Promise<PackedEncodedStream> {
  if (mime.includes("webm")) return demuxPackedWebm(bytes);
  if (mime.includes("mp4")) return demuxPackedMp4(bytes);
  throw new Error(`packedDemux: unsupported mime "${mime}"`);
}

// ============================================================================
// mp4 (H.264/avc) — mp4box.js
// ============================================================================

interface AvcCBoxLike {
  write(stream: DataStream): void;
}

function hasAvcC(description: unknown): description is { avcC: AvcCBoxLike } {
  return typeof description === "object" && description !== null && "avcC" in description;
}

/**
 * mp4box の SampleEntry から avcC の AVCDecoderConfigurationRecord（box header 抜き）を取り出す。
 * Chrome の WebCodecs サンプル（video-decode-display）と同一手法: 一度 box を DataStream に
 * 書き戻し、先頭 8 バイト（size(4)+fourcc(4)のbox header）を捨てる。
 */
function extractAvcDescription(description: Sample["description"]): Uint8Array | undefined {
  if (!hasAvcC(description)) return undefined;
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  description.avcC.write(stream);
  return new Uint8Array(stream.buffer, 8);
}

function buildPackedStreamFromMp4(track: Track, samples: Sample[]): PackedEncodedStream {
  const ordered = samples.slice().sort((a, b) => a.number - b.number);
  const first = ordered[0];
  if (!first) throw new Error("packedDemux(mp4): video track has no samples");
  const description = extractAvcDescription(first.description);
  const chunks: PackedEncodedChunk[] = ordered.map((s) => {
    if (!s.data) throw new Error("packedDemux(mp4): sample has no data (did extraction discard mdat?)");
    return {
      timestamp: Math.round((s.cts * 1_000_000) / s.timescale),
      duration: Math.round((s.duration * 1_000_000) / s.timescale),
      keyFrame: s.is_sync,
      data: s.data,
    };
  });
  return {
    codec: track.codec,
    description,
    codedWidth: track.video?.width ?? 0,
    codedHeight: track.video?.height ?? 0,
    frameCount: chunks.length,
    chunks,
  };
}

function demuxPackedMp4(bytes: Uint8Array): Promise<PackedEncodedStream> {
  return new Promise((resolve, reject) => {
    const file: ISOFile = createFile();
    let track: Track | undefined;
    let settled = false;
    const collected: Sample[] = [];

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    file.onError = (module, message) => fail(new Error(`packedDemux(mp4): mp4box error (${module}): ${message}`));

    file.onReady = (info: Movie) => {
      track = info.videoTracks[0];
      if (!track) {
        fail(new Error("packedDemux(mp4): no video track found"));
        return;
      }
      file.setExtractionOptions(track.id, undefined, { nbSamples: Infinity });
      file.start();
    };

    file.onSamples = (_id, _user, samples) => {
      if (settled || !track) return;
      collected.push(...samples);
      if (collected.length < track.nb_samples) return;
      try {
        resolve(buildPackedStreamFromMp4(track, collected));
        settled = true;
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    };

    try {
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0);
      file.appendBuffer(mp4Buffer, true);
      file.flush();
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ============================================================================
// webm (VP9) — 最小 EBML/Matroska ウォーカー
// ============================================================================

const EBML_ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

const TRACK_TYPE_VIDEO = 1;

interface EbmlElement {
  id: number;
  /** 内容（id・size バイトを除く）の開始オフセット。 */
  start: number;
  /** 内容の終了オフセット（exclusive）。 */
  end: number;
}

function vintLength(firstByte: number): number {
  if (firstByte === 0) throw new Error("packedDemux(webm): invalid EBML vint (leading byte 0)");
  let mask = 0x80;
  let len = 1;
  while ((firstByte & mask) === 0) {
    mask >>= 1;
    len++;
  }
  return len;
}

/** EBML element ID vint。マーカービットを含めた生の値がそのまま ID になる。 */
function readElementId(bytes: Uint8Array, pos: number): { id: number; nextPos: number } {
  const len = vintLength(bytes[pos]!);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + bytes[pos + i]!;
  return { id, nextPos: pos + len };
}

/** EBML size vint（および Block 内 track number vint と同じ形式）。マーカービットは値から除く。 */
function readVintValue(bytes: Uint8Array, pos: number): { value: number; nextPos: number } {
  const first = bytes[pos]!;
  const len = vintLength(first);
  const firstByteMask = 0xff >> len;
  let value = first & firstByteMask;
  for (let i = 1; i < len; i++) value = value * 256 + bytes[pos + i]!;
  return { value, nextPos: pos + len };
}

function readChildren(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const children: EbmlElement[] = [];
  let pos = start;
  while (pos < end) {
    const { id, nextPos: afterId } = readElementId(bytes, pos);
    const { value: size, nextPos: afterSize } = readVintValue(bytes, afterId);
    const contentStart = afterSize;
    const contentEnd = contentStart + size;
    children.push({ id, start: contentStart, end: contentEnd });
    pos = contentEnd;
  }
  return children;
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i]!;
  return value;
}

function readAsciiString(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.subarray(start, end));
}

interface WebmBlockPrelude {
  trackNumber: number;
  relativeTimecode: number;
  keyFrame: boolean;
  /** prelude 自体のバイト長（track number vint + 2 バイト timecode + 1 バイトフラグ）。 */
  preludeLength: number;
}

/** SimpleBlock / Block（BlockGroup 内）共通のヘッダ形式（webm-muxer の writeBlock_fn と対応）。 */
function readBlockPrelude(bytes: Uint8Array, start: number): WebmBlockPrelude {
  const { value: trackNumber, nextPos } = readVintValue(bytes, start);
  const tcHigh = bytes[nextPos]!;
  const tcLow = bytes[nextPos + 1]!;
  let relativeTimecode = (tcHigh << 8) | tcLow;
  if (relativeTimecode & 0x8000) relativeTimecode -= 0x10000; // signed int16
  const flags = bytes[nextPos + 2]!;
  const lacing = (flags >> 1) & 0x03;
  if (lacing !== 0) {
    throw new Error("packedDemux(webm): laced blocks are not supported (self-generated packed assets never lace)");
  }
  return {
    trackNumber,
    relativeTimecode,
    keyFrame: (flags & 0x80) !== 0,
    preludeLength: nextPos + 3 - start,
  };
}

function demuxPackedWebm(bytes: Uint8Array): Promise<PackedEncodedStream> {
  const topLevel = readChildren(bytes, 0, bytes.length);
  const segment = topLevel.find((e) => e.id === EBML_ID.Segment);
  if (!segment) return Promise.reject(new Error("packedDemux(webm): no Segment element found"));
  const segmentChildren = readChildren(bytes, segment.start, segment.end);

  let timestampScale = 1_000_000; // ns/tick, webm-muxer 既定
  let videoTrackNumber: number | undefined;
  let codedWidth = 0;
  let codedHeight = 0;

  for (const child of segmentChildren) {
    if (child.id === EBML_ID.Info) {
      for (const infoChild of readChildren(bytes, child.start, child.end)) {
        if (infoChild.id === EBML_ID.TimestampScale) {
          timestampScale = readUint(bytes, infoChild.start, infoChild.end);
        }
      }
    } else if (child.id === EBML_ID.Tracks) {
      for (const trackEntry of readChildren(bytes, child.start, child.end)) {
        if (trackEntry.id !== EBML_ID.TrackEntry) continue;
        const entryChildren = readChildren(bytes, trackEntry.start, trackEntry.end);
        const trackTypeEl = entryChildren.find((e) => e.id === EBML_ID.TrackType);
        if (!trackTypeEl || readUint(bytes, trackTypeEl.start, trackTypeEl.end) !== TRACK_TYPE_VIDEO) continue;
        const codecIdEl = entryChildren.find((e) => e.id === EBML_ID.CodecID);
        const codecId = codecIdEl ? readAsciiString(bytes, codecIdEl.start, codecIdEl.end) : "";
        if (codecId !== "V_VP9") {
          throw new Error(`packedDemux(webm): unsupported CodecID "${codecId}" (only self-generated V_VP9 packed assets are supported)`);
        }
        const trackNumberEl = entryChildren.find((e) => e.id === EBML_ID.TrackNumber);
        videoTrackNumber = trackNumberEl ? readUint(bytes, trackNumberEl.start, trackNumberEl.end) : undefined;
        const videoEl = entryChildren.find((e) => e.id === EBML_ID.Video);
        if (videoEl) {
          const videoChildren = readChildren(bytes, videoEl.start, videoEl.end);
          const widthEl = videoChildren.find((e) => e.id === EBML_ID.PixelWidth);
          const heightEl = videoChildren.find((e) => e.id === EBML_ID.PixelHeight);
          if (widthEl) codedWidth = readUint(bytes, widthEl.start, widthEl.end);
          if (heightEl) codedHeight = readUint(bytes, heightEl.start, heightEl.end);
        }
      }
    }
  }

  if (videoTrackNumber === undefined) {
    return Promise.reject(new Error("packedDemux(webm): no video TrackEntry found"));
  }

  const usPerScaleUnit = timestampScale / 1000; // ns/tick → us/tick
  const chunks: PackedEncodedChunk[] = [];

  for (const child of segmentChildren) {
    if (child.id !== EBML_ID.Cluster) continue;
    const clusterChildren = readChildren(bytes, child.start, child.end);
    const timecodeEl = clusterChildren.find((e) => e.id === EBML_ID.Timecode);
    const clusterTimecode = timecodeEl ? readUint(bytes, timecodeEl.start, timecodeEl.end) : 0;

    for (const el of clusterChildren) {
      let blockRange: EbmlElement | undefined;
      let blockDurationTicks: number | undefined;
      if (el.id === EBML_ID.SimpleBlock) {
        blockRange = el;
      } else if (el.id === EBML_ID.BlockGroup) {
        const groupChildren = readChildren(bytes, el.start, el.end);
        blockRange = groupChildren.find((e) => e.id === EBML_ID.Block);
        const durationEl = groupChildren.find((e) => e.id === EBML_ID.BlockDuration);
        if (durationEl) blockDurationTicks = readUint(bytes, durationEl.start, durationEl.end);
      } else {
        continue;
      }
      if (!blockRange) continue;

      const prelude = readBlockPrelude(bytes, blockRange.start);
      if (prelude.trackNumber !== videoTrackNumber) continue;

      const absoluteTicks = clusterTimecode + prelude.relativeTimecode;
      const dataStart = blockRange.start + prelude.preludeLength;
      chunks.push({
        timestamp: Math.round(absoluteTicks * usPerScaleUnit),
        duration: blockDurationTicks !== undefined ? Math.round(blockDurationTicks * usPerScaleUnit) : 0,
        keyFrame: prelude.keyFrame,
        data: bytes.subarray(dataStart, blockRange.end),
      });
    }
  }

  if (chunks.length === 0) return Promise.reject(new Error("packedDemux(webm): no video blocks found"));

  return Promise.resolve({
    codec: "vp09.00.10.08", // 自前エンコーダの固定出力コーデック（encodeAlphaWebm.ts と一致）
    description: undefined,
    codedWidth,
    codedHeight,
    frameCount: chunks.length,
    chunks,
  });
}
