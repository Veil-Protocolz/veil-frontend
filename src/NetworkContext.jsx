import { createContext, useContext, useState } from 'react'
import { Networks } from '@stellar/stellar-sdk'

export const NETWORKS = {
  testnet: {
    name: 'Testnet',
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    poolContract: 'CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW',
    explorerBase: 'https://stellar.expert/explorer/testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    faucetUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    name: 'Mainnet',
    passphrase: Networks.PUBLIC,
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    poolContract: null, // not yet deployed — shows coming soon
    explorerBase: 'https://stellar.expert/explorer/public',
    horizonUrl: 'https://horizon.stellar.org',
    faucetUrl: null,
  },
}

const NetworkContext = createContext(null)

export function NetworkProvider({ children }) {
  const [networkKey, setNetworkKey] = useState('testnet')
  const network = NETWORKS[networkKey]
  return (
    <NetworkContext.Provider value={{ networkKey, setNetworkKey, network, NETWORKS }}>
      {children}
    </NetworkContext.Provider>
  )
}

export function useNetwork() {
  return useContext(NetworkContext)
}
