export {};

declare global {
  interface VideoEncoderConfig {
    /**
     * TS の lib.dom.d.ts (5.9系時点) にはまだ無いが、WebCodecs 仕様には存在するフィールド。
     * 指定するとエンコーダの RGB→YUV 変換先の色空間(matrix/primaries/transfer/range)を
     * ヒントできる（`src/runtime/videoColorSpace.ts` 参照・§16.2b 黄ばみ色ズレ対策）。
     */
    colorSpace?: VideoColorSpaceInit;
  }
}
