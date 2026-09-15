// §11.2 GIF post-encoder — deterministic fixed-palette GIF89a writer.
// The canonical scene/frame rendering stays in exporter.ts; this file only encodes raster pixels.

const GIF_TRANSPARENT_INDEX = 255;
const GIF_MIN_CODE_SIZE = 8;
const MAX_GIF_DIMENSION = 65_535;

class ByteWriter {
  private readonly chunkSize: number;
  private readonly chunks: Uint8Array[] = [];
  private chunk: Uint8Array;
  private offset = 0;
  private totalLength = 0;

  constructor(chunkSize = 65_536) {
    this.chunkSize = chunkSize;
    this.chunk = new Uint8Array(chunkSize);
  }

  pushByte(value: number): void {
    if (this.offset === this.chunk.length) this.flushChunk();
    this.chunk[this.offset++] = value & 0xff;
    this.totalLength++;
  }

  pushBytes(values: ArrayLike<number>): void {
    let sourceOffset = 0;
    while (sourceOffset < values.length) {
      if (this.offset === this.chunk.length) this.flushChunk();
      const count = Math.min(values.length - sourceOffset, this.chunk.length - this.offset);
      if (values instanceof Uint8Array) {
        this.chunk.set(values.subarray(sourceOffset, sourceOffset + count), this.offset);
      } else {
        for (let i = 0; i < count; i++) {
          this.chunk[this.offset + i] = values[sourceOffset + i] & 0xff;
        }
      }
      this.offset += count;
      this.totalLength += count;
      sourceOffset += count;
    }
  }

  pushAscii(text: string): void {
    for (let i = 0; i < text.length; i++) this.pushByte(text.charCodeAt(i));
  }

  pushU16(value: number): void {
    this.pushByte(value);
    this.pushByte(value >>> 8);
  }

  finish(): Uint8Array {
    this.flushChunk();
    const out = new Uint8Array(this.totalLength);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private flushChunk(): void {
    if (this.offset === 0) return;
    this.chunks.push(this.chunk.slice(0, this.offset));
    this.chunk = new Uint8Array(this.chunkSize);
    this.offset = 0;
  }
}

/**
 * GIF timing is stored in 1/100 s. Rounding cumulative frame boundaries avoids
 * accumulating drift at rates such as 24/30/60 fps (e.g. 30 fps => 3,4,3 cs...).
 */
export function gifFrameDelayCs(frameIndex: number, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("GIF fps must be greater than zero");
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error("GIF frameIndex must be a non-negative integer");
  const startCs = Math.round((frameIndex * 100) / fps);
  const endCs = Math.round(((frameIndex + 1) * 100) / fps);
  return Math.max(1, endCs - startCs);
}

/**
 * Deterministic 252-color uniform RGB palette + reserved entries.
 * Index 255 is reserved for GIF's single transparent color.
 */
export function quantizeRgbaToGif(
  rgba: Uint8ClampedArray | Uint8Array,
  allowTransparency: boolean,
): Uint8Array {
  if (rgba.length % 4 !== 0) throw new Error("RGBA byte length must be divisible by four");
  const indexed = new Uint8Array(rgba.length / 4);
  for (let i = 0, pixel = 0; i < rgba.length; i += 4, pixel++) {
    if (allowTransparency && rgba[i + 3] < 128) {
      indexed[pixel] = GIF_TRANSPARENT_INDEX;
      continue;
    }
    const r = Math.min(5, Math.floor((rgba[i] * 6) / 256));
    const g = Math.min(6, Math.floor((rgba[i + 1] * 7) / 256));
    const b = Math.min(5, Math.floor((rgba[i + 2] * 6) / 256));
    indexed[pixel] = r * 42 + g * 6 + b;
  }
  return indexed;
}

export class GifEncoder {
  private readonly writer = new ByteWriter();
  private frameCount = 0;
  private finished = false;

  constructor(
    private readonly width: number,
    private readonly height: number,
    loopCount = 0,
  ) {
    validateDimension(width, "width");
    validateDimension(height, "height");
    if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 65_535) {
      throw new Error("GIF loopCount must be an integer in 0..65535");
    }

    this.writer.pushAscii("GIF89a");
    this.writer.pushU16(width);
    this.writer.pushU16(height);
    // Global color table present, color resolution=8 bits, 256 table entries.
    this.writer.pushByte(0xf7);
    this.writer.pushByte(0); // background color index
    this.writer.pushByte(0); // pixel aspect ratio
    this.writer.pushBytes(buildGlobalPalette());

    // Netscape loop extension. loopCount=0 means infinite looping.
    this.writer.pushBytes([0x21, 0xff, 0x0b]);
    this.writer.pushAscii("NETSCAPE2.0");
    this.writer.pushBytes([0x03, 0x01]);
    this.writer.pushU16(loopCount);
    this.writer.pushByte(0x00);
  }

  addFrame(indexedPixels: Uint8Array, delayCs: number, hasTransparency: boolean): void {
    if (this.finished) throw new Error("Cannot add a GIF frame after finish()");
    if (indexedPixels.length !== this.width * this.height) {
      throw new Error(`GIF frame has ${indexedPixels.length} pixels; expected ${this.width * this.height}`);
    }
    const delay = Math.max(1, Math.min(65_535, Math.round(delayCs)));

    // Graphic Control Extension. Disposal method 1 = keep previous canvas.
    this.writer.pushBytes([0x21, 0xf9, 0x04, hasTransparency ? 0x05 : 0x04]);
    this.writer.pushU16(delay);
    this.writer.pushByte(hasTransparency ? GIF_TRANSPARENT_INDEX : 0);
    this.writer.pushByte(0x00);

    // Full-canvas Image Descriptor; uses the global palette.
    this.writer.pushByte(0x2c);
    this.writer.pushU16(0);
    this.writer.pushU16(0);
    this.writer.pushU16(this.width);
    this.writer.pushU16(this.height);
    this.writer.pushByte(0x00);

    const lzw = encodeLzw(indexedPixels);
    this.writer.pushByte(GIF_MIN_CODE_SIZE);
    for (let at = 0; at < lzw.length; at += 255) {
      const count = Math.min(255, lzw.length - at);
      this.writer.pushByte(count);
      this.writer.pushBytes(lzw.subarray(at, at + count));
    }
    this.writer.pushByte(0x00);
    this.frameCount++;
  }

  finish(): Uint8Array {
    if (this.finished) throw new Error("GIF encoder finish() may only be called once");
    if (this.frameCount === 0) throw new Error("Cannot finish a GIF with no frames");
    this.finished = true;
    this.writer.pushByte(0x3b);
    return this.writer.finish();
  }
}

function validateDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_GIF_DIMENSION) {
    throw new Error(`GIF ${name} must be an integer in 1..${MAX_GIF_DIMENSION}`);
  }
}

function buildGlobalPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 7; g++) {
      for (let b = 0; b < 6; b++) {
        const index = r * 42 + g * 6 + b;
        palette[index * 3] = Math.round((r * 255) / 5);
        palette[index * 3 + 1] = Math.round((g * 255) / 6);
        palette[index * 3 + 2] = Math.round((b * 255) / 5);
      }
    }
  }
  // 252..254 remain available for future palette refinements; 255 is transparent.
  palette[252 * 3] = 0;
  palette[252 * 3 + 1] = 0;
  palette[252 * 3 + 2] = 0;
  palette[253 * 3] = 255;
  palette[253 * 3 + 1] = 255;
  palette[253 * 3 + 2] = 255;
  palette[254 * 3] = 128;
  palette[254 * 3 + 1] = 128;
  palette[254 * 3 + 2] = 128;
  palette[GIF_TRANSPARENT_INDEX * 3] = 0;
  palette[GIF_TRANSPARENT_INDEX * 3 + 1] = 0;
  palette[GIF_TRANSPARENT_INDEX * 3 + 2] = 0;
  return palette;
}

function encodeLzw(indices: Uint8Array): Uint8Array {
  const clearCode = 1 << GIF_MIN_CODE_SIZE;
  const endCode = clearCode + 1;
  let codeSize = GIF_MIN_CODE_SIZE + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map<number, number>();
  const writer = new ByteWriter(16_384);
  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      writer.pushByte(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  const resetDictionary = (): void => {
    dictionary = new Map<number, number>();
    codeSize = GIF_MIN_CODE_SIZE + 1;
    nextCode = endCode + 1;
  };

  writeCode(clearCode);
  if (indices.length === 0) {
    writeCode(endCode);
    if (bitCount > 0) writer.pushByte(bitBuffer & 0xff);
    return writer.finish();
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const suffix = indices[i];
    const key = (prefix << 8) | suffix;
    const hit = dictionary.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }

    writeCode(prefix);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode++);
      // The decoder learns each dictionary entry one emitted code later than the encoder.
      // Grow only after crossing the boundary so both sides read the boundary code at old width.
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      writeCode(clearCode);
      resetDictionary();
    }
    prefix = suffix;
  }

  writeCode(prefix);
  writeCode(endCode);
  if (bitCount > 0) writer.pushByte(bitBuffer & 0xff);
  return writer.finish();
}
