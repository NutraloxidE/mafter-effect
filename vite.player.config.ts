import { defineConfig } from "vite";
import path from "node:path";

/** §11.7 bundle player IIFE（file:// 互換）。 */
export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/player/main.ts"),
      name: "MafterPlayer",
      formats: ["iife"],
      fileName: () => "player.js",
    },
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
