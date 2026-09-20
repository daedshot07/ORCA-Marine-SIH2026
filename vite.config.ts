import { defineConfig } from "vite";

// No framework plugin: the UI is a handful of DOM writes and must load fast on
// 2G, so there is nothing here to transform beyond TypeScript.
export default defineConfig({
  build: {
    target: "es2022",
    // A cheap Android phone on 2G should not pay for a source map it will
    // never open, and inlining assets keeps the request count down.
    sourcemap: false,
    assetsInlineLimit: 8192,
  },
});
