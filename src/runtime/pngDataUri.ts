/**
 * 純関数 PNG エンコーダ（無圧縮 zlib stored block）。
 *
 * displacement map 等、SVG gradient では表現できない 2D 場（放射状リップル等）を
 * `feImage href` で参照できる data URI に焼く用途。DOM/canvas/乱数を使わず決定論的
 * （INV-1 / INV-2）。圧縮はしない（stored block）ため map は小さめに生成すること。
 */

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** zlib stored（無圧縮）ストリームを生成する。 */
function zlibStore(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01]; // CMF, FLG（(0x7801 % 31 === 0)）
  const MAX = 0xffff;
  let offset = 0;
  while (offset < raw.length) {
    const len = Math.min(MAX, raw.length - offset);
    const isLast = offset + len >= raw.length ? 1 : 0;
    out.push(isLast);
    out.push(len & 0xff, (len >>> 8) & 0xff);
    const nlen = ~len & 0xffff;
    out.push(nlen & 0xff, (nlen >>> 8) & 0xff);
    for (let i = 0; i < len; i++) out.push(raw[offset + i]!);
    offset += len;
  }
  const adler = adler32(raw);
  out.push(...u32be(adler));
  return Uint8Array.from(out);
}

function chunk(type: string, data: Uint8Array): number[] {
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const body = Uint8Array.from([...typeBytes, ...data]);
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(binary);
}

/**
 * RGBA ピクセル（行優先・4ch・8bit）を PNG data URI に変換する。
 * `rgba.length === width*height*4` であること。
 */
export function rgbaToPngDataUri(rgba: Uint8Array, width: number, height: number): string {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Uint8Array.from([
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // color type RGBA
    0, // compression
    0, // filter
    0, // interlace
  ]);
  const idat = zlibStore(raw);
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
  return `data:image/png;base64,${bytesToBase64(png)}`;
}
