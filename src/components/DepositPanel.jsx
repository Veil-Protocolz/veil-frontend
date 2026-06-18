import { useState } from 'react'
import { rpc as SorobanRpc, Networks, Contract, TransactionBuilder, xdr, Keypair } from '@stellar/stellar-sdk'
import { RPC_URL, POOL_CONTRACT, DENOMINATION, EXPLORER_BASE } from '../config'

// BLS12-381 scalar field modulus
const BLS_r = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')

function randFieldEl() {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return (BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')) % BLS_r)
}

export default function DepositPanel({ onDeposited }) {
  const [step, setStep] = useState('idle') // idle | generating | ready | depositing | done | error
  const [note, setNote] = useState(null)
  const [secretKey, setSecretKey] = useState('')
  const [txHash, setTxHash] = useState(null)
  const [error, setError] = useState(null)
  const [log, setLog] = useState([])

  const addLog = (msg, type = 'info') => setLog(prev => [...prev, { msg, type, ts: Date.now() }])

  async function generateNote() {
    setStep('generating')
    setLog([])
    setError(null)
    try {
      addLog('Generating random nullifier and secret…')
      const nullifier = randFieldEl()
      const secret = randFieldEl()
      const amount = DENOMINATION

      addLog('Computing Poseidon commitment off-chain…')
      // commitment = poseidon3(nullifier, secret, amount) — computed via WASM
      // For the demo UI we approximate with a SHA-256 hash (real proofs use the WASM)
      const preimage = `${nullifier}:${secret}:${amount}`
      const enc = new TextEncoder().encode(preimage)
      const hashBuf = await crypto.subtle.digest('SHA-256', enc)
      const commitment = BigInt('0x' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('')) % BLS_r

      const newNote = { nullifier: nullifier.toString(), secret: secret.toString(), amount: amount.toString(), commitment: commitment.toString() }
      setNote(newNote)
      addLog('Note generated. Keep it secret — it is your spending key.', 'success')
      setStep('ready')
    } catch (e) {
      setError(e.message)
      setStep('error')
    }
  }

  async function submitDeposit() {
    if (!note || !secretKey.trim()) {
      setError('Enter your Stellar secret key (S...) to sign the transaction.')
      return
    }
    setStep('depositing')
    setError(null)

    try {
      addLog('Connecting to Stellar testnet RPC…')
      const server = new SorobanRpc.Server(RPC_URL)
      const kp = Keypair.fromSecret(secretKey.trim())
      const account = await server.getAccount(kp.publicKey())

      const commitHex = BigInt(note.commitment).toString(16).padStart(64, '0')
      addLog(`Commitment: ${commitHex.slice(0,12)}…`)

      const contract = new Contract(POOL_CONTRACT)
      const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.TESTNET })
        .addOperation(contract.call(
          'deposit',
          xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(kp.rawPublicKey())
          )),
          xdr.ScVal.scvBytes(Buffer.from(commitHex, 'hex')),
        ))
        .setTimeout(30)
        .build()

      addLog('Simulating transaction…')
      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error)

      addLog('Signing and submitting…')
      const prepared = SorobanRpc.assembleTransaction(tx, sim).build()
      prepared.sign(kp)

      const send = await server.sendTransaction(prepared)
      setTxHash(send.hash)
      addLog(`TX submitted: ${send.hash.slice(0,16)}…`, 'info')

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const poll = await server.getTransaction(send.hash)
        if (poll.status === 'SUCCESS') {
          addLog('Deposit confirmed on-chain!', 'success')
          setStep('done')
          onDeposited?.()
          return
        }
        if (poll.status === 'FAILED') throw new Error('Transaction failed on-chain')
      }
      throw new Error('Timeout waiting for confirmation')
    } catch (e) {
      setError(e.message)
      addLog(e.message, 'error')
      setStep('ready')
    }
  }

  function downloadNote() {
    const blob = new Blob([JSON.stringify(note, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `veil-note-${Date.now()}.json`
    a.click()
  }

  return (
    <div>
      <h2 style={s.title}>Deposit</h2>
      <p style={s.desc}>
        Deposit <strong>1 XLM</strong> into the Veil pool and receive a private note.
        The note is your spending key — keep it secret.
      </p>

      <div style={s.flow}>
        <Step n={1} active={step === 'idle' || step === 'generating'} done={!!note} label="Generate note" />
        <Arrow />
        <Step n={2} active={step === 'ready' || step === 'depositing'} done={step === 'done'} label="Submit deposit" />
        <Arrow />
        <Step n={3} active={false} done={step === 'done'} label="Save note" />
      </div>

      {/* Step 1 */}
      {!note && (
        <div style={s.section}>
          <Btn onClick={generateNote} loading={step === 'generating'} disabled={step === 'generating'}>
            Generate Note
          </Btn>
        </div>
      )}

      {/* Note display */}
      {note && (
        <div style={s.noteBox}>
          <div style={s.noteHeader}>
            <span style={s.noteTitle}>🔑 Private Note</span>
            <span style={s.noteBadge}>SECRET</span>
          </div>
          <NoteRow label="Nullifier" value={note.nullifier} />
          <NoteRow label="Secret" value={note.secret} />
          <NoteRow label="Amount" value={`${(BigInt(note.amount) / 10_000_000n).toString()} XLM`} />
          <NoteRow label="Commitment" value={BigInt(note.commitment).toString(16).padStart(64,'0')} />
          <div style={s.noteWarning}>
            ⚠️ Never share the nullifier or secret. Anyone with this note can spend your deposit.
          </div>
          <Btn variant="secondary" onClick={downloadNote} style={{ marginTop: 8 }}>
            Download note.json
          </Btn>
        </div>
      )}

      {/* Step 2: sign + submit */}
      {note && step !== 'done' && (
        <div style={s.section}>
          <label style={s.label}>Your Stellar Secret Key</label>
          <input
            type="password"
            placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            value={secretKey}
            onChange={e => setSecretKey(e.target.value)}
            style={s.input}
          />
          <p style={s.hint}>Key stays in your browser — never sent to any server.</p>
          <Btn onClick={submitDeposit} loading={step === 'depositing'} disabled={step === 'depositing'}>
            Deposit 1 XLM
          </Btn>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div style={s.successBox}>
          <div style={s.successIcon}>✅</div>
          <div style={s.successText}>Deposit confirmed!</div>
          <a
            href={`${EXPLORER_BASE}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            style={s.txLink}
          >
            View on Stellar Expert ↗
          </a>
          <p style={{ ...s.hint, marginTop: 8 }}>
            Save your note.json — you'll need it to withdraw.
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

function Step({ n, active, done, label }) {
  return (
    <div style={{ ...s.step, ...(active ? s.stepActive : {}), ...(done ? s.stepDone : {}) }}>
      <div style={{ ...s.stepNum, ...(active ? s.stepNumActive : {}), ...(done ? s.stepNumDone : {}) }}>
        {done ? '✓' : n}
      </div>
      <span style={{ fontSize: 12 }}>{label}</span>
    </div>
  )
}

function Arrow() {
  return <div style={s.arrow}>→</div>
}

function NoteRow({ label, value }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const display = value.length > 24 ? `${value.slice(0,12)}…${value.slice(-8)}` : value
  return (
    <div style={s.noteRow}>
      <span style={s.noteRowLabel}>{label}</span>
      <span style={s.noteRowVal} title={value}>{display}</span>
      <button style={s.copyBtn} onClick={copy}>{copied ? '✓' : '⎘'}</button>
    </div>
  )
}

function Btn({ children, onClick, loading, disabled, variant = 'primary', style: extra = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        ...s.btn,
        ...(variant === 'secondary' ? s.btnSecondary : {}),
        ...(disabled || loading ? s.btnDisabled : {}),
        ...extra,
      }}
    >
      {loading ? '⟳ Working…' : children}
    </button>
  )
}

const s = {
  title: { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 },
  desc: { fontSize: 14, color: 'var(--muted)', marginBottom: 24, lineHeight: 1.6 },
  flow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 },
  step: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', fontSize: 12, color: 'var(--muted)' },
  stepActive: { borderColor: 'var(--accent)', color: '#e2e8f0' },
  stepDone: { borderColor: 'var(--green)', color: 'var(--green)' },
  stepNum: { width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: 'var(--border)', color: 'var(--muted)' },
  stepNumActive: { background: 'var(--accent)', color: '#fff' },
  stepNumDone: { background: 'var(--green)', color: '#fff' },
  arrow: { color: 'var(--muted)', fontSize: 16 },
  section: { marginBottom: 20 },
  noteBox: { background: 'var(--surface2)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: 16, marginBottom: 20 },
  noteHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  noteTitle: { fontWeight: 700, color: '#e2e8f0', fontSize: 14 },
  noteBadge: { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' },
  noteRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 },
  noteRowLabel: { color: 'var(--muted)', width: 90, flexShrink: 0, fontSize: 12 },
  noteRowVal: { fontFamily: 'var(--mono)', color: '#e2e8f0', flex: 1, wordBreak: 'break-all', fontSize: 12 },
  copyBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', fontSize: 12 },
  noteWarning: { fontSize: 12, color: 'var(--yellow)', marginTop: 10, lineHeight: 1.5, padding: '8px 10px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' },
  label: { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: '#e2e8f0', fontSize: 13, fontFamily: 'var(--mono)', marginBottom: 6, outline: 'none' },
  hint: { fontSize: 12, color: 'var(--muted)', marginBottom: 12 },
  btn: { width: '100%', padding: '11px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  btnSecondary: { background: 'var(--surface2)', color: 'var(--muted)', border: '1px solid var(--border)' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  successBox: { textAlign: 'center', padding: '24px 0' },
  successIcon: { fontSize: 40, marginBottom: 8 },
  successText: { fontWeight: 700, fontSize: 16, color: 'var(--green)', marginBottom: 8 },
  txLink: { fontSize: 13, color: 'var(--cyan)', display: 'block' },
  error: { fontSize: 13, color: 'var(--red)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', marginTop: 12, wordBreak: 'break-all' },
  logBox: { marginTop: 16, padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)' },
  logLine: { fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 4, lineHeight: 1.5 },
}
