// Preview / store 共有の expression module loader。FS は store.getFs() と同一インスタンス。

import { IndexedDbFs } from "../fs/IndexedDbFs";
import { ExpressionEngine } from "../runtime/expressionEngine";
import { ModuleLoader } from "../runtime/moduleLoader";

let boundFs: IndexedDbFs | null = null;
let moduleLoader: ModuleLoader | null = null;
let expressionEngine: ExpressionEngine | null = null;

/** store 初期化時に呼ぶ。loader が読む FS と脚本 write 先を一致させる（§17）。 */
export function bindExpressionFs(fs: IndexedDbFs): void {
  if (boundFs === fs && expressionEngine) return;
  boundFs = fs;
  moduleLoader = new ModuleLoader(fs);
  expressionEngine = new ExpressionEngine(moduleLoader);
}

function ensureHub(): ExpressionEngine {
  if (!expressionEngine || !moduleLoader) {
    throw new Error("expressionModuleHub: bindExpressionFs() must be called before use");
  }
  return expressionEngine;
}

export function getExpressionModuleLoader(): ModuleLoader {
  ensureHub();
  return moduleLoader!;
}

export function getPreviewExpressionEngine(): ExpressionEngine {
  if (!expressionEngine) {
    bindExpressionFs(new IndexedDbFs("mafter-effect-fs"));
  }
  return expressionEngine!;
}

export function invalidateExpressionPath(path: string): void {
  if (!expressionEngine || !moduleLoader) return;
  moduleLoader.invalidate(path);
  expressionEngine.invalidate(path);
}
