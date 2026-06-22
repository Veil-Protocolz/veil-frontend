import { Keypair, Networks, Contract, TransactionBuilder } from '@stellar/stellar-sdk'

// BLS12-381 ZCash big-endian serialisation helpers
export function fqBE(n) {
  return Buffer.from(BigInt(n).toString(16).padStart(96, '0'), 'hex')
}

export function g1ToBytes(pt) {
  return Buffer.concat([fqBE(pt[0]), fqBE(pt[1])])
}

export function g2ToBytes(pt) {
  return Buffer.concat([fqBE(pt[0][1]), fqBE(pt[0][0]), fqBE(pt[1][1]), fqBE(pt[1][0])])
}

export function fieldToBytes32(s) {
  return Buffer.from(BigInt(s).toString(16).padStart(64, '0'), 'hex')
}

// Build a read-only (simulation-only) transaction for a contract call
export function buildReadTx(contract, method, networkPassphrase = Networks.TESTNET) {
  const kp = Keypair.random()
  const account = {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => '0',
    incrementSequenceNumber() {},
  }
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(contract.call(method))
    .setTimeout(10)
    .build()
}
