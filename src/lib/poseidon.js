/**
 * Browser Poseidon over BLS12-381 via circom WASM witness calculators.
 * Output is byte-identical to the in-circuit Poseidon.
 */

const _cache = {}

async function loadWC(wasmName) {
  if (_cache[wasmName]) return _cache[wasmName]
  const [wcSrc, wasmBuf] = await Promise.all([
    fetch('/circuits/witness_calculator.js').then(r => r.text()),
    fetch(`/circuits/${wasmName}.wasm`).then(r => r.arrayBuffer()),
  ])
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', wcSrc)(mod, mod.exports)
  const builder = mod.exports.default ?? mod.exports
  const wc = await builder(wasmBuf)
  _cache[wasmName] = wc
  return wc
}

async function hashWASM(circuitName, inputs) {
  const wc = await loadWC(circuitName)
  const witness = await wc.calculateWitness(inputs, false)
  return witness[1] // index 1 = first public output signal 'out'
}

/** Poseidon(nullifier) — nullifier hash */
export const poseidon1 = a =>
  hashWASM('poseidon1', { a: a.toString() })

/** Poseidon(a, b) — Merkle pair */
export const poseidon2 = (a, b) =>
  hashWASM('poseidon_helper', { a: a.toString(), b: b.toString() })

/** Poseidon(nullifier, secret, amount) — commitment */
export const poseidon3 = (a, b, c) =>
  hashWASM('poseidon3', { a: a.toString(), b: b.toString(), c: c.toString() })
