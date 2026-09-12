import { defineConfig, type Plugin } from "vite";
import path from "path";
import fs from "node:fs";

// 思源插件要求产物为 dist/index.js + dist/index.css（cjs + external siyuan）
function renameCss(): Plugin {
  return {
    name: "rename-css",
    closeBundle() {
      const from = path.resolve(__dirname, "dist/style.css");
      if (fs.existsSync(from)) fs.renameSync(from, path.resolve(__dirname, "dist/index.css"));
    }
  };
}

export default defineConfig({
  plugins: [renameCss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "Plugin",
      fileName: "index",
      formats: ["cjs"]
    },
    rollupOptions: {
      external: ["siyuan", "process"],
      output: {
        entryFileNames: "index.js",
        assetFileNames: "[name][extname]",
        // 兼容思源 loader：module.exports 为类本身，同时提供 .default
        footer: "if (typeof module !== 'undefined' && module.exports && !module.exports.default) module.exports.default = module.exports;"
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
