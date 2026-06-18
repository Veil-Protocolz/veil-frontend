import { rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { RPC_URL } from '../config'

/**
 * Poll a submitted transaction until SUCCESS, FAILED, or timeout.
 * @param {string} hash
 * @param {{ attempts?: number, intervalMs?: number }} opts
 */
export async function pollTx(hash, { attempts = 20, intervalMs = 2000 } = {}) {
  const server = new SorobanRpc.Server(RPC_URL)
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const result = await server.getTransaction(hash)
    if (result.status === 'SUCCESS') return
    if (result.status === 'FAILED') throw new Error('Transaction failed: ' + (result.resultXdr ?? ''))
  }
  throw new Error('Timeout waiting for transaction confirmation')
}
