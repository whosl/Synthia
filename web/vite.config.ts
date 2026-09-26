import { fileURLToPath, URL } from "node:url";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss(), {
    name: "preview-hashed-asset-cache",
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        // Only immutable build assets: HTML, API responses and missing files retain their own policy.
        if (/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|png|svg)$/.test(path)
          && statSync(resolve(dist, `.${path}`), { throwIfNoEntry: false })?.isFile()) {
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
        next();
      });
    },
  }],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
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
