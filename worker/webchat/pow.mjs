// DIAGNOSTIC BUILD ONLY — runtime WebAssembly removed.
// This disables DeepSeek web proof-of-work to test whether the Orca directory's
// "code" review trigger is caused by fetching/compiling a remote WASM module.
// Do not release this commit as-is; restore the real solver after the test.

export async function solvePOW(_challenge, wasmUrl, _opts = {}) {
  if (!wasmUrl) throw new Error('POW: missing wasmUrl')
  throw new Error('POW: WASM solver disabled in diagnostic build')
}

export function _clearPowCache() {}
