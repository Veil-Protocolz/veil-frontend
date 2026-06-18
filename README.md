# Veil — Compliant Private Payments on Stellar

Veil is a zero-knowledge privacy pool built on **Stellar Soroban** (Protocol 26). It lets users deposit a fixed denomination of XLM and withdraw to any address without revealing the link between depositor and recipient, while enforcing regulatory compliance through an **Association Set Provider (ASP)**.

---

## How it works

| Step | What happens |
|------|-------------|
| **1. Generate note** | A random `nullifier` and `secret` are generated locally. `commitment = Poseidon(nullifier, secret, amount)` is computed in-browser. Only you hold the note. |
| **2. Deposit** | You call `deposit(sender, commitment)` on the Soroban pool contract. The commitment is inserted as a leaf in the on-chain Merkle tree. |
| **3. ASP approval** | The compliance operator adds your commitment to a separate approval Merkle tree and publishes the new root on-chain. This is the KYC/AML gate. |
| **4. Generate ZK proof** | Off-chain, a Groth16 proof demonstrates: pool membership, ASP clearance, correct nullifier derivation, and binding to the recipient address. |
| **5. Verify & withdraw** | The pool contract verifies the proof using Stellar's native **BLS12-381 host functions**. If valid and the nullifier is unspent, 1 XLM is released to the recipient. |

---

## Stellar / Soroban integration

### SDK

The frontend uses [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) (`^16.0.0`) for all on-chain interaction:

```js
import { rpc as SorobanRpc, Networks, Contract, TransactionBuilder, xdr, Keypair }
  from '@stellar/stellar-sdk'
```

### Network

| Parameter | Value |
|-----------|-------|
| Network | Stellar **Testnet** |
| RPC endpoint | `https://soroban-testnet.stellar.org` |
| Network passphrase | `Networks.TESTNET` |
| Protocol | **26** (BLS12-381 host functions) |

### Pool contract

```
CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW
```

[View on Stellar Expert ↗](https://stellar.expert/explorer/testnet/contract/CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW)

### Contract calls

**Deposit**
```js
contract.call(
  'deposit',
  xdr.ScVal.scvAddress(/* sender */),
  xdr.ScVal.scvBytes(/* 32-byte commitment */),
)
```

**Withdraw**
```js
contract.call(
  'withdraw',
  xdr.ScVal.scvBytes(proofA),   // G1 point — 96 bytes
  xdr.ScVal.scvBytes(proofB),   // G2 point — 192 bytes
  xdr.ScVal.scvBytes(proofC),   // G1 point — 96 bytes
  xdr.ScVal.scvBytes(poolRoot), // 32 bytes
  xdr.ScVal.scvBytes(aspRoot),  // 32 bytes
  xdr.ScVal.scvBytes(nullifierHash), // 32 bytes
  xdr.ScVal.scvAddress(/* recipient */),
  xdr.ScVal.scvI128(/* amount in stroops */),
)
```

**Read-only views** (`get_pool_root`, `get_asp_root`, `get_commitments`) are called via `server.simulateTransaction` — no fees, no signing required.

### Transaction flow

```
TransactionBuilder → simulateTransaction → assembleTransaction → sign → sendTransaction → poll getTransaction
```

All simulation errors are surfaced via `SorobanRpc.Api.isSimulationError(sim)`.

---

## ZK stack

| Component | Detail |
|-----------|--------|
| Circuit | Circom 2.1.6 · `ShieldedTransfer(20)` |
| Curve | BLS12-381 |
| Proof system | Groth16 |
| Hash function | Poseidon(2) / Poseidon(3) |
| On-chain verifier | Soroban SDK 26 · `bls12_381` host functions |
| Merkle depth | 20 levels (~1 M deposits) |

Proof points are serialised in **ZCash big-endian** format before being passed to the contract:

```js
// G1: 96-byte big-endian Fq concatenation
// G2: 192-byte big-endian Fq2 concatenation (imaginary part first)
```

---

## Frontend

Built with **React 19 + Vite 8**.

### Project structure

```
src/
  components/
    DepositPanel.jsx   — note generation + deposit flow
    WithdrawPanel.jsx  — proof upload + withdraw flow
    PoolStatus.jsx     — live Merkle root & commitment viewer
    SplashScreen.jsx   — landing screen
  App.jsx              — layout, routing, refresh orchestration
```

### Running locally

```bash
npm install
npm run dev
```

### Generate a withdrawal proof (off-chain)

```bash
node scripts/prove.js \
  --note your-note.json \
  --pool-db /tmp/pool_db.json \
  --asp-db  /tmp/pool_db.json \
  --recipient G… \
  --out proof.json
```

Then upload `proof.json` in the Withdraw tab.

---

## Security notes

- The Stellar secret key is **never sent to any server** — it signs the transaction locally in the browser and is used only in memory.
- The private note (`nullifier` + `secret`) must be kept offline. Anyone with the note can spend the deposit.
- This is a **testnet** deployment. Do not use real funds.
