import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Vite config for the Cyclone IV Studio frontend.
// `root` is this directory (frontend/); the build lands in frontend/dist.

// monaco-editor 0.57's package.json `exports` map ("./*.js": "./esm/vs/*.js")
// rewrites deep subpaths like "monaco-editor/esm/vs/editor/editor.worker.js"
// to a doubled path (./esm/vs/esm/vs/...) that does not exist on disk, and
// rolldown-vite 8 resolves exports strictly (no fs fallback), so the deep
// worker import in src/ui/editorPanel.js fails to resolve. Alias the worker
// module id straight to the real file:
//   - resolve.alias covers the dev server (JS-side resolver);
//   - build.rolldownOptions.resolve.alias covers the build, where the native
//     `?worker` handler resolves through the native rolldown resolver and
//     bypasses the plugin-based resolve.alias.
const MONACO_WORKER_ID = "monaco-editor/esm/vs/editor/editor.worker.js";
const MONACO_WORKER_FILE = fileURLToPath(
  new URL("./node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [{ find: MONACO_WORKER_ID, replacement: MONACO_WORKER_FILE }],
  },
  build: {
    rolldownOptions: {
      resolve: {
        alias: { [MONACO_WORKER_ID]: MONACO_WORKER_FILE },
      },
    },
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
