import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 发行产物**不得**携带 Live2D 模型与 Cubism Core（授权禁分发，见
// `desktop/public/live2d/使用注意事项.txt`）。剔除动作在 `scripts/build-beta.mjs`
// 里以「构建前移出 public/、构建后移回」的方式完成——不在这里做，因为某些 Windows
// 环境无法递归删除目录（rmSync 静默失败），只能靠重命名。
const live2dPresent = existsSync(fileURLToPath(new URL("./public/live2d", import.meta.url)));

export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [vue()],
  // 构建期就把「这次产物里有没有 Live2D 模型」告诉前端：
  // 没有时直接走诚实回退文案，不去请求不存在的文件（否则控制台会留 404 噪音）。
  define: {
    __VV_LIVE2D_BUNDLED__: JSON.stringify(live2dPresent),
  },
  resolve: {
    alias: {
      // Shared cross-stage contracts live in the workspace packages/ dir.
      "@contracts": fileURLToPath(
        new URL("../packages/contracts/src", import.meta.url),
      ),
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
});
