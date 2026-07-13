/**
 * テスト専用の最小 PNG デコーダ。`src/runtime/pngDataUri.ts`（無圧縮 zlib stored block・
 * RGBA8・filter None）が焼いた data URI だけを対象とする（汎用デコーダではない）。
 */
export function decodePngDataUri(dataUri: string): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const b64 = dataUri.replace(/^data:image\/png;base64,/, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const u32 = (o: number) =>
    ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;

  // walk chunks starting after the 8-byte signature
  let width = 0;
  let height = 0;
  const idat: number[] = [];
  let p = 8;
  while (p < bytes.length) {
    const len = u32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = p + 8;
    if (type === "IHDR") {
      width = u32(body);
      height = u32(body + 4);
    } else if (type === "IDAT") {
      for (let i = 0; i < len; i++) idat.push(bytes[body + i]!);
    } else if (type === "IEND") {
      break;
    }
    p = body + len + 4; // +4 CRC
  }

  // zlib: skip 2-byte header, parse stored blocks, ignore trailing 4-byte adler
  const raw: number[] = [];
  let z = 2;
  const end = idat.length - 4;
  while (z < end) {
    const isLast = idat[z]! & 1;
    z += 1;
    const blen = idat[z]! | (idat[z + 1]! << 8);
    z += 4; // len(2) + nlen(2)
    for (let i = 0; i < blen; i++) raw.push(idat[z + i]!);
    z += blen;
    if (isLast) break;
  }

  // de-filter (all rows filter type 0 = None → strip the leading byte per scanline)
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) rgba[y * stride + i] = raw[src + i]!;
  }
  return { width, height, rgba };
}
