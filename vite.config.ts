import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Strip console.* and debugger statements in prod bundles. 52+
    // console.logs scattered across the app were polluting users'
    // DevTools; we keep them intact in `vite dev` for local debugging.
    // Critical errors still surface via explicit alertDialog / toast.
    minify: "esbuild",
    // Split heavy dependencies into their own chunks so the main bundle
    // stays under 400KB and unused-at-startup libraries (React Flow,
    // markdown renderer) load lazily with their owning tab/feature.
    //
    // Prior to this split the main bundle was ~684KB (213KB gzip) —
    // the React Flow payload alone is ~150KB gzipped and only the
    // Studio tab uses it.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/@xyflow/")) return "reactflow";
          if (id.includes("node_modules/react-dom")) return "react-dom";
          if (id.includes("node_modules/react/")) return "react";
          // Group every markdown-related dep into one chunk. react-markdown,
          // remark-gfm, remark-parse, micromark, unified, mdast-util-*, etc.
          // all cluster together — only Sessions/Runs tabs pull them in, so
          // co-locating keeps the main bundle slim.
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/remark-") ||
            id.includes("node_modules/rehype-") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/mdast-") ||
            id.includes("node_modules/unified") ||
            id.includes("node_modules/marked")
          ) {
            return "markdown";
          }
          if (id.includes("node_modules/zustand")) return "zustand";
          if (id.includes("node_modules/@tauri-apps")) return "tauri";
          return undefined;
        },
      },
    },
    // Quiet the 500KB warning after manualChunks brings us under it;
    // if a future chunk regresses, we'll still see the number.
    chunkSizeWarningLimit: 450,
  },

  // esbuild-level drops applied to prod builds only. console.log
  // survives `vite dev`; `vite build` strips it from the shipped JS.
  // Explicit list so console.error/warn survive — users' DevTools
  // still see real problems.
  esbuild: {
    drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
    pure:
      process.env.NODE_ENV === "production"
        ? ["console.log", "console.debug", "console.info"]
        : [],
  },
}));
