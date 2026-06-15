import type { FileSystem } from "../fs/FileSystem";

// §11.3 FS → module loader
// fake FS 上の JS を ES module として評価し、default export を返す。
// ロード済みは Map にキャッシュして毎フレーム re-import しない（§11.3 注記）。
//
// ブラウザ環境のみ（URL.createObjectURL が必要）。Node テストでは
// テスト用の MockModuleLoader を使うこと。

export type ExprFn = (ctx: unknown) => unknown;

export interface IModuleLoader {
  load(path: string): Promise<ExprFn | null>;
  invalidate(path: string): void;
  clear(): void;
}

export class ModuleLoader implements IModuleLoader {
  private readonly cache = new Map<string, ExprFn>();

  constructor(private readonly fs: FileSystem) {}

  async load(path: string): Promise<ExprFn | null> {
    const hit = this.cache.get(path);
    if (hit) return hit;

    let src: string;
    try {
      src = await this.fs.readText(path);
    } catch {
      return null; // ファイルが存在しない場合は null（エラーにしない）
    }

    try {
      const blob = new Blob([src], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      let mod: { default?: ExprFn };
      try {
        // dynamic import で ES module として評価
        mod = (await import(/* @vite-ignore */ url)) as { default?: ExprFn };
      } finally {
        URL.revokeObjectURL(url);
      }
      const fn = mod.default;
      if (typeof fn !== "function") return null;
      this.cache.set(path, fn);
      return fn;
    } catch {
      return null;
    }
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }
}

// テスト / headless 用のモック実装（関数を直接登録する）
export class MockModuleLoader implements IModuleLoader {
  private readonly registry = new Map<string, ExprFn>();

  register(path: string, fn: ExprFn): void {
    this.registry.set(path, fn);
  }

  async load(path: string): Promise<ExprFn | null> {
    return this.registry.get(path) ?? null;
  }

  invalidate(path: string): void {
    this.registry.delete(path);
  }

  clear(): void {
    this.registry.clear();
  }
}
