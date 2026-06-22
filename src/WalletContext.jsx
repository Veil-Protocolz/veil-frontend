import { createContext, useContext, useState, useCallback } from 'react'
import {
  isConnected,
  requestAccess,
  getAddress,
  signTransaction,
} from '@stellar/freighter-api'

const WalletContext = createContext(null)

// Freighter API v6 hangs if the extension isn't installed.
// Wrap any call with a timeout so the UI doesn't spin forever.
function withTimeout(promise, ms = 4000, msg = 'Freighter timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ])
}

export function WalletProvider({ children }) {
  const [address, setAddress]       = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError]           = useState(null)

  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      // v6: isConnected() returns { isConnected: bool }
      const status = await withTimeout(
        isConnected(),
        4000,
        'Freighter not detected — install it at freighter.app',
      )
      if (!status?.isConnected) {
        throw new Error('Freighter not installed — get it at freighter.app')
      }

      // v6: requestAccess() returns { address, error? }
      const access = await withTimeout(requestAccess(), 30000, 'Freighter request timed out')
      if (access?.error) throw new Error(access.error.message ?? String(access.error))

      const addr = access?.address
      if (!addr) {
        // Fallback: try getAddress()
        const ga = await withTimeout(getAddress(), 5000, 'Could not get address from Freighter')
        if (ga?.error) throw new Error(ga.error.message ?? String(ga.error))
        if (!ga?.address) throw new Error('Freighter returned no address')
        setAddress(ga.address)
      } else {
        setAddress(addr)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setError(null)
  }, [])

  // Signs a built Transaction using Freighter; returns signed XDR string
  const sign = useCallback(async (tx, networkPassphrase) => {
    const xdrStr = tx.toXDR()
    // v6: signTransaction returns { signedTxXdr, signerAddress, error? }
    const result = await withTimeout(
      signTransaction(xdrStr, { networkPassphrase, address }),
      60000,
      'Freighter signing timed out',
    )
    if (result?.error) throw new Error(result.error.message ?? String(result.error))
    if (!result?.signedTxXdr) throw new Error('Freighter returned empty signed transaction')
    return result.signedTxXdr
  }, [address])

  return (
    <WalletContext.Provider value={{ address, connecting, error, connect, disconnect, sign }}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  return useContext(WalletContext)
}
