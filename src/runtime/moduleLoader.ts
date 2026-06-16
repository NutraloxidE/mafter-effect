import type { FileSystem } from "../fs/FileSystem";

// §11.3 FS → module loader
// fake FS 上の JS を ES module として評価し、default export を返す。
// ロード済みは Map にキャッシュして毎フレーム re-import しない（§11.3 注記）。
//
// ブラウザ環境のみ（URL.createObjectURL が必要）。Node テストでは
// テスト用の MockModuleLoader を使うこと。

export type ExprFn = (ctx: unknown) => unknown;

// load() が返す default export。expression は関数（ExprFn）、HTML comp は
// オブジェクト（§7 CompositionModule）。loader は型を選ばず default をそのまま返し、
// 呼び出し側（ExpressionEngine / HtmlCompPlayer）が用途に応じて検証する。
export type LoadedExport = unknown;

export interface IModuleLoader {
  load(path: string): Promise<LoadedExport | null>;
  invalidate(path: string): void;
  clear(): void;
}

export class ModuleLoader implements IModuleLoader {
  private readonly cache = new Map<string, LoadedExport>();
  // ロード失敗済みパスのセット。ファイル保存時は invalidate で消す。
  private readonly failed = new Set<string>();

  constructor(private readonly fs: FileSystem) {}

  async load(path: string): Promise<LoadedExport | null> {
    if (this.cache.has(path)) return this.cache.get(path) ?? null;
    if (this.failed.has(path)) return null;

    let src: string;
    try {
      src = await this.fs.readText(path);
    } catch {
      this.failed.add(path);
      return null; // ファイルが存在しない場合は null（エラーにしない）
    }

    try {
      const blob = new Blob([src], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      let mod: { default?: LoadedExport };
      try {
        // dynamic import で ES module として評価
        mod = (await import(/* @vite-ignore */ url)) as { default?: LoadedExport };
      } finally {
        URL.revokeObjectURL(url);
      }
      const def = mod.default;
      // 関数（expression）でもオブジェクト（CompositionModule）でも受け付ける。
      if (def === undefined || def === null) {
        this.failed.add(path);
        return null;
      }
      this.cache.set(path, def);
      return def;
    } catch {
      this.failed.add(path);
      return null;
    }
  }

  invalidate(path: string): void {
    this.cache.delete(path);
    this.failed.delete(path);
  }

  clear(): void {
    this.cache.clear();
    this.failed.clear();
  }
}

// テスト / headless 用のモック実装（関数を直接登録する）
export class MockModuleLoader implements IModuleLoader {
  private readonly registry = new Map<string, LoadedExport>();

  register(path: string, mod: LoadedExport): void {
    this.registry.set(path, mod);
  }

  async load(path: string): Promise<LoadedExport | null> {
    return this.registry.get(path) ?? null;
  }

  invalidate(path: string): void {
    this.registry.delete(path);
  }

  clear(): void {
    this.registry.clear();
  }
}
