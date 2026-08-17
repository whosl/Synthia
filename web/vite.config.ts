import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    // 5173 常被本机其他项目占用；5180 冲突时 vite 自动顺延
    port: 5180,
    allowedHosts: ["synthia.wenzhuolin.xyz"],
    proxy: {
      // Core API (dev): http://127.0.0.1:5130
      "/api": {
        target: "http://127.0.0.1:5130",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
