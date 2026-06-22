/**
 * Web Worker: generates a Groth16 proof in the browser.
 *
 * Receives: { note, commitments, recipient }
 * Posts back progress messages: { type: 'progress', step, total, msg }
 * Posts final result: { type: 'done', proof, meta }
 * Posts errors: { type: 'error', message }
 */

import { groth16 } from 'snarkjs'
import { poseidon1, poseidon2, poseidon3 } from './lib/poseidon'

const BLS_r = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')
const LEVELS = 20

// ---- Merkle tree (matches in-circuit MerkleProof(20)) ----
let _zeros = null
async function getZeros() {
  if (_zeros) return _zeros
  _zeros = new Array(LEVELS + 1)
  _zeros[0] = 0n
  for (let i = 1; i <= LEVELS; i++) {
    _zeros[i] = await poseidon2(_zeros[i - 1], _zeros[i - 1])
  }
  return _zeros
}

async function buildTree(leaves) {
  const zeros = await getZeros()
  const layers = [leaves.slice()]
  for (let level = 0; level < LEVELS; level++) {
    const cur = layers[level]
    const next = []
    const size = Math.ceil(Math.max(cur.length, 1) / 2)
    for (let i = 0; i < size; i++) {
      const l = cur[i * 2] ?? zeros[level]
      const r = cur[i * 2 + 1] ?? zeros[level]
      next.push(await poseidon2(l, r))
    }
    layers.push(next)
  }
  const root = layers[LEVELS][0] ?? zeros[LEVELS]
  return { layers, root, zeros }
}

async function merkleProof(layers, zeros, index) {
  const pathElements = []
  const pathIndices = []
  let idx = index
  for (let level = 0; level < LEVELS; level++) {
    const layer = layers[level]
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1
    pathElements.push(layer[siblingIdx] ?? zeros[level])
    pathIndices.push(idx % 2)
    idx = Math.floor(idx / 2)
  }
  return { pathElements, pathIndices }
}

// ---- address_to_fr: mirrors the Soroban contract's logic ----
// SHA-256(G... strkey as UTF-8) → BigInt → mod BLS_r
async function addressToFr(address) {
  const enc = new TextEncoder().encode(address)
  const hashBuf = await crypto.subtle.digest('SHA-256', enc)
  const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('')
  return BigInt('0x' + hex) % BLS_r
}

// ---- Main handler ----
self.onmessage = async ({ data }) => {
  const { note, commitments, recipient } = data

  const post = (step, total, msg) => self.postMessage({ type: 'progress', step, total, msg })

  try {
    post(1, 6, 'Warming up Poseidon WASM…')
    // Pre-warm all three WASM circuits with a dummy hash
    await Promise.all([poseidon1(1n), poseidon2(1n, 2n), poseidon3(1n, 2n, 3n)])

    const nullifier = BigInt(note.nullifier)
    const secret    = BigInt(note.secret)
    const amount    = BigInt(note.amount)

    post(2, 6, 'Computing commitment & nullifier hash…')
    const [commitment, nullifierHash] = await Promise.all([
      poseidon3(nullifier, secret, amount),
      poseidon1(nullifier),
    ])

    post(3, 6, 'Building Merkle trees…')
    const leaves = commitments.map(c => BigInt(c))
    const { layers, root: poolRoot, zeros } = await buildTree(leaves)
    // ASP uses same set for demo (all deposits are pre-approved)
    const aspResult = await buildTree(leaves)
    const aspRoot = aspResult.root

    const leafIdx = leaves.findIndex(l => l === commitment)
    if (leafIdx === -1) throw new Error('Your deposit commitment was not found in the pool. Has the deposit been confirmed on-chain?')

    const [poolProof, aspProof] = await Promise.all([
      merkleProof(layers, zeros, leafIdx),
      merkleProof(aspResult.layers, aspResult.zeros, leafIdx),
    ])

    post(4, 6, 'Encoding recipient address…')
    const recipientFr = await addressToFr(recipient)

    post(5, 6, 'Generating Groth16 proof — this takes ~60s…')
    const inputs = {
      poolRoot:        poolRoot.toString(),
      aspRoot:         aspRoot.toString(),
      nullifierHash:   nullifierHash.toString(),
      recipient:       recipientFr.toString(),
      amount:          amount.toString(),
      nullifier:       nullifier.toString(),
      secret:          secret.toString(),
      poolPathElements: poolProof.pathElements.map(x => x.toString()),
      poolPathIndices:  poolProof.pathIndices.map(x => x.toString()),
      aspPathElements:  aspProof.pathElements.map(x => x.toString()),
      aspPathIndices:   aspProof.pathIndices.map(x => x.toString()),
    }

    const { proof, publicSignals } = await groth16.fullProve(
      inputs,
      '/circuits/shielded_transfer.wasm',
      '/circuits/shielded_transfer.zkey',
    )

    post(6, 6, 'Proof generated ✓')
    self.postMessage({
      type: 'done',
      proof,
      publicSignals,
      meta: {
        poolRoot:      poolRoot.toString(),
        aspRoot:       aspRoot.toString(),
        nullifierHash: nullifierHash.toString(),
        recipient,
        amount:        amount.toString(),
      },
    })
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message })
  }
}
