/**
 * §16.2b — RGBA canvas ソースから WebCodecs VideoEncoder で動画を作る全経路が共有する
 * 色空間ターゲット。canvas/ImageBitmap から作った VideoFrame は常に sRGB
 * (primaries=bt709, transfer=iec61966-2-1, matrix=rgb, fullRange=true) としてタグ付けされるが、
 * これは「入力」のタグであり、エンコーダが実際にどの行列で RGB→YUV 変換するかは別（既定では
 * 明示指定しない限り曖昧・環境依存で、解像度ベースの再生側ヒューリスティックと食い違う
 * ことがある＝いわゆる BT.601 encode / BT.709 decode 起因の黄色っぽい色ズレ）。
 * この既知の Chromium 挙動を避けるため、エンコード側の目標色空間を明示的に固定する。
 */
export const RGBA_SOURCE_VIDEO_COLOR_SPACE: VideoColorSpaceInit = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
};
