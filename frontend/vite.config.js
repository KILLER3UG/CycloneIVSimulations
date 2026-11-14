import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Vite config for the Cyclone IV Studio frontend.
// `root` is this directory (frontend/); the build lands in frontend/dist.

// monaco-editor 0.57's package.json `exports` map ("./*.js": "./esm/vs/*.js")
// rewrites deep subpaths like "monaco-editor/esm/vs/editor/editor.worker.js"
// to a doubled path (./esm/vs/esm/vs/...) that does not exist on disk, and
// rolldown-vite 8 resolves exports strictly (no fs fallback). The UI imports
// the worker through the LOCAL shim src/monaco-editor.worker.js (relative
// `?worker` import + bare side-effect import inside), which sidesteps the
// exports map in dev and build; the alias below is still required for the
// build, where rolldown resolves the shim's bare import through the native
// resolver (build.rolldownOptions.resolve.alias — the plugin-based
// resolve.alias is bypassed on the native `?worker` path and by dev's
// worker resolver, which is why alias-only fixes kept failing somewhere).
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
