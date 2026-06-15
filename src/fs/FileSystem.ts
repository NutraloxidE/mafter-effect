// §11.1 FileSystem 抽象。
// IndexedDbFs（ブラウザ）と NodeFs（アプリ版）は同一パス構成を生成する (INV-4)。
// パスは常に POSIX 形式（"/" 区切り）。先頭 "/" は付けない（例: "project.json", "assets/x.png"）。

export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Plugin に渡す読み取り専用ビュー（§12）。 */
export type ReadonlyFileSystem = Pick<
  FileSystem,
  "read" | "readText" | "list" | "exists"
>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

export function bytesToText(data: Uint8Array): string {
  return decoder.decode(data);
}

/** パスを正規化する。先頭/末尾の "/" を除き、"\\" を "/" に統一、重複 "/" を畳む。 */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return p;
}

/** dir 配下のパスかを判定する（dir 自身は含めない）。 */
export function isUnder(dir: string, path: string): boolean {
  const d = normalizePath(dir);
  if (d === "") return true; // ルート
  return path === d || path.startsWith(d + "/");
}
