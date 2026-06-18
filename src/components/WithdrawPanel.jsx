import { useState, useRef } from 'react'
import { rpc as SorobanRpc, Networks, Contract, TransactionBuilder, xdr, Keypair } from '@stellar/stellar-sdk'

const RPC_URL = 'https://soroban-testnet.stellar.org'
const POOL_CONTRACT = 'CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW'

// BLS12-381 ZCash big-endian serialization helpers
function fqBE(n) {
  return Buffer.from(BigInt(n).toString(16).padStart(96, '0'), 'hex')
}
function g1ToBytes(pt) {
  return Buffer.concat([fqBE(pt[0]), fqBE(pt[1])])
}
function g2ToBytes(pt) {
  return Buffer.concat([fqBE(pt[0][1]), fqBE(pt[0][0]), fqBE(pt[1][1]), fqBE(pt[1][0])])
}

export default function WithdrawPanel({ onWithdrawn }) {
  const [step, setStep] = useState('idle') // idle | proving | submitting | done | error
  const [noteJson, setNoteJson] = useState('')
  const [proofJson, setProofJson] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [recipient, setRecipient] = useState('')
  const [txHash, setTxHash] = useState(null)
  const [error, setError] = useState(null)
  const [log, setLog] = useState([])
  const fileRef = useRef()

  const addLog = (msg, type = 'info') => setLog(prev => [...prev, { msg, type }])

  function loadNoteFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => setNoteJson(evt.target.result)
    reader.readAsText(file)
  }

  function loadProofFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => setProofJson(evt.target.result)
    reader.readAsText(file)
  }

  async function submitWithdraw() {
    if (!proofJson.trim() || !secretKey.trim()) {
      setError('Provide proof.json and your secret key.')
      return
    }
    setStep('submitting')
    setError(null)
    setLog([])

    try {
      const { proof, meta } = JSON.parse(proofJson)
      addLog('Parsed proof.json')

      const server = new SorobanRpc.Server(RPC_URL)
      const kp = Keypair.fromSecret(secretKey.trim())
      const account = await server.getAccount(kp.publicKey())
      addLog('Account loaded')

      const proofABytes = g1ToBytes(proof.pi_a)
      const proofBBytes = g2ToBytes(proof.pi_b)
      const proofCBytes = g1ToBytes(proof.pi_c)

      const fieldToBytes32 = s => Buffer.from(BigInt(s).toString(16).padStart(64,'0'), 'hex')

      const contract = new Contract(POOL_CONTRACT)
      const recipientAddr = (recipient.trim() || meta.recipient)

      addLog(`Recipient: ${recipientAddr.slice(0,12)}…`)
      addLog('Building transaction…')

      const tx = new TransactionBuilder(account, { fee: '10000000', networkPassphrase: Networks.TESTNET })
        .addOperation(contract.call(
          'withdraw',
          xdr.ScVal.scvBytes(proofABytes),
          xdr.ScVal.scvBytes(proofBBytes),
          xdr.ScVal.scvBytes(proofCBytes),
          xdr.ScVal.scvBytes(fieldToBytes32(meta.poolRoot)),
          xdr.ScVal.scvBytes(fieldToBytes32(meta.aspRoot)),
          xdr.ScVal.scvBytes(fieldToBytes32(meta.nullifierHash)),
          xdr.ScVal.scvAddress(
            xdr.ScAddress.scAddressTypeAccount(
              xdr.PublicKey.publicKeyTypeEd25519(
                Keypair.fromPublicKey(recipientAddr).rawPublicKey()
              )
            )
          ),
          xdr.ScVal.scvI128(new xdr.Int128Parts({
            hi: xdr.Int64.fromString('0'),
            lo: xdr.Uint64.fromString(meta.amount),
          })),
        ))
        .setTimeout(30)
        .build()

      addLog('Simulating…')
      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error)

      addLog('Simulation passed ✓')
      const prepared = SorobanRpc.assembleTransaction(tx, sim).build()
      prepared.sign(kp)

      addLog('Submitting to Stellar testnet…')
      const send = await server.sendTransaction(prepared)
      setTxHash(send.hash)

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const poll = await server.getTransaction(send.hash)
        if (poll.status === 'SUCCESS') {
          addLog('Withdrawal confirmed!', 'success')
          setStep('done')
          onWithdrawn?.()
          return
        }
        if (poll.status === 'FAILED') throw new Error('Transaction failed: ' + poll.resultXdr)
      }
      throw new Error('Timeout waiting for confirmation')
    } catch (e) {
      setError(e.message)
      addLog(e.message, 'error')
      setStep('idle')
    }
  }

  const note = noteJson ? tryParse(noteJson) : null

  return (
    <div>
      <h2 style={s.title}>Withdraw</h2>
      <p style={s.desc}>
        Submit a ZK proof to withdraw funds from the pool to any address — without
        revealing which deposit you're spending.
      </p>

      <div style={s.infoBox}>
        <div style={s.infoTitle}>How to generate a proof</div>
        <div style={s.infoBody}>
          Proof generation runs off-chain (takes ~60s on a laptop). Run:
          <pre style={s.pre}>{`node scripts/prove.js \\
  --note your-note.json \\
  --pool-db /tmp/pool_db.json \\
  --asp-db /tmp/pool_db.json \\
  --recipient GYOURADDRESS... \\
  --out proof.json`}</pre>
          Then upload <code style={s.code}>proof.json</code> below.
        </div>
      </div>

      {/* Proof upload */}
      <div style={s.section}>
        <label style={s.label}>Upload proof.json</label>
        <div
          style={s.dropZone}
          onClick={() => fileRef.current.click()}
        >
          {proofJson
            ? <span style={{ color: 'var(--green)' }}>✓ proof.json loaded</span>
            : <span>Click to upload proof.json</span>}
        </div>
        <input ref={fileRef} type="file" accept=".json" onChange={loadProofFile} style={{ display: 'none' }} />
      </div>

      {/* Proof summary */}
      {proofJson && (() => {
        const parsed = tryParse(proofJson)
        if (!parsed?.meta) return null
        return (
          <div style={s.proofSummary}>
            <Row label="Pool Root" value={parsed.meta.poolRoot ? `0x${BigInt(parsed.meta.poolRoot).toString(16).padStart(64,'0').slice(0,16)}…` : '—'} />
            <Row label="Nullifier Hash" value={parsed.meta.nullifierHash ? `0x${BigInt(parsed.meta.nullifierHash).toString(16).padStart(64,'0').slice(0,16)}…` : '—'} />
            <Row label="Amount" value={`${(BigInt(parsed.meta.amount) / 10_000_000n)} XLM`} />
            <Row label="Recipient" value={`${parsed.meta.recipient?.slice(0,12)}…`} />
          </div>
        )
      })()}

      {/* Optional recipient override */}
      <div style={s.section}>
        <label style={s.label}>Recipient address (optional override)</label>
        <input
          placeholder={tryParse(proofJson)?.meta?.recipient || 'G… (defaults to address in proof)'}
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          style={s.input}
        />
      </div>

      {/* Secret key */}
      <div style={s.section}>
        <label style={s.label}>Your Stellar Secret Key (to sign + pay fees)</label>
        <input
          type="password"
          placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
          value={secretKey}
          onChange={e => setSecretKey(e.target.value)}
          style={s.input}
        />
      </div>

      {step !== 'done' && (
        <button
          onClick={submitWithdraw}
          disabled={step === 'submitting' || !proofJson || !secretKey}
          style={{
            ...s.btn,
            ...(step === 'submitting' || !proofJson || !secretKey ? s.btnDisabled : {}),
          }}
        >
          {step === 'submitting' ? '⟳ Verifying proof on-chain…' : '⚡ Verify & Withdraw'}
        </button>
      )}

      {step === 'done' && (
        <div style={s.successBox}>
          <div style={s.successIcon}>✅</div>
          <div style={s.successText}>Withdrawal successful!</div>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            style={s.txLink}
          >
            View TX on Stellar Expert ↗
          </a>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
            The Groth16 proof was verified by the on-chain BLS12-381 host functions.
            No one can link this withdrawal to your original deposit.
          </p>
        </div>
      )}

      {error && <div style={s.error}>{error}</div>}

      {log.length > 0 && (
        <div style={s.logBox}>
          {log.map((l, i) => (
            <div key={i} style={{ ...s.logLine, color: l.type === 'error' ? 'var(--red)' : l.type === 'success' ? 'var(--green)' : 'var(--muted)' }}>
              {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: '#e2e8f0' }}>{value}</span>
    </div>
  )
}

function tryParse(json) {
  try { return JSON.parse(json) } catch { return null }
}

const s = {
  title: { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 },
  desc: { fontSize: 14, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.6 },
  infoBox: { background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.2)', borderRadius: 10, padding: 16, marginBottom: 24 },
  infoTitle: { fontWeight: 600, fontSize: 13, color: 'var(--accent)', marginBottom: 8 },
  infoBody: { fontSize: 13, color: 'var(--muted)', lineHeight: 1.7 },
  pre: { fontFamily: 'var(--mono)', fontSize: 12, marginTop: 8, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 6, color: '#e2e8f0', overflowX: 'auto', border: '1px solid var(--border)' },
  code: { fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '1px 5px', borderRadius: 4 },
  section: { marginBottom: 16 },
  label: { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 },
  dropZone: { border: '1px dashed var(--border)', borderRadius: 8, padding: '20px', textAlign: 'center', cursor: 'pointer', fontSize: 14, color: 'var(--muted)', background: 'var(--surface2)' },
  proofSummary: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: '#e2e8f0', fontSize: 13, fontFamily: 'var(--mono)', outline: 'none' },
  btn: { width: '100%', padding: '11px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginBottom: 12 },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  successBox: { textAlign: 'center', padding: '24px 0' },
  successIcon: { fontSize: 40, marginBottom: 8 },
  successText: { fontWeight: 700, fontSize: 16, color: 'var(--green)', marginBottom: 8 },
  txLink: { fontSize: 13, color: 'var(--cyan)', display: 'block', marginBottom: 4 },
  error: { fontSize: 13, color: 'var(--red)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', marginTop: 12, wordBreak: 'break-all' },
  logBox: { marginTop: 16, padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)' },
  logLine: { fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 4, lineHeight: 1.5 },
}
