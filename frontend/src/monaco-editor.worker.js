// Local shim for the Monaco editor worker.
//
// monaco-editor 0.57's `exports` map breaks deep-subpath resolution in
// rolldown-vite 8 (strict, no fs fallback), and the native `?worker`
// resolver in dev ignores plugin-based aliases. Importing the real worker
// entry from this LOCAL file works everywhere: the relative `?worker`
// import below resolves in dev and build, and the bare import inside this
// file is a side-effect import (the worker chunk legitimately has no
// default export), which both dev pre-bundling and the rolldown build
// (build.rolldownOptions.resolve.alias maps it to the real file) handle.
import "monaco-editor/esm/vs/editor/editor.worker.js";
