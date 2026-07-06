import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(dir, "..", "dist-electron");
const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [path.join(dir, "main.ts"), path.join(dir, "preload.ts")],
  outdir,
  platform: "node",
  format: "cjs",
  target: "node20",
  bundle: true,
  external: ["electron"],
  outExtension: { ".js": ".cjs" },
};

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("[electron/build] watching electron/*.ts -> dist-electron/*.cjs");
} else {
  await build(buildOptions);
  console.log("[electron/build] wrote dist-electron/main.cjs, dist-electron/preload.cjs");
}
