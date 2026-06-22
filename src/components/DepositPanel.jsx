import { useState } from 'react'
import { rpc as SorobanRpc, Contract, TransactionBuilder, xdr, Keypair } from '@stellar/stellar-sdk'
import { useNetwork } from '../NetworkContext'
import { useWallet } from '../WalletContext'
import { poseidon2, poseidon3 } from '../lib/poseidon'

const BLS_r = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')
const DENOMINATION = 10_000_000n

function randFieldEl() {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')) % BLS_r
}

export default function DepositPanel({ onDeposited }) {
  const { network } = useNetwork()
  const wallet = useWallet()
  const [step, setStep]         = useState('idle')   // idle|generating|ready|depositing|done
  const [note, setNote]         = useState(null)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [secretKey, setSecretKey] = useState('')
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [txHash, setTxHash]     = useState(null)
  const [error, setError]       = useState(null)
  const [log, setLog]           = useState([])

  const addLog = (msg, type = 'info') => setLog(prev => [...prev, { msg, type }])

  async function generateNote() {
    setStep('generating')
    setLog([])
    setError(null)
    try {
      addLog('Generating random nullifier and secret…')
      const nullifier = randFieldEl()
      const secret    = randFieldEl()
      addLog('Loading Poseidon WASM…')
      const commitment = await poseidon3(nullifier, secret, DENOMINATION)
      addLog('Commitment computed ✓')
      setNote({ nullifier: nullifier.toString(), secret: secret.toString(), amount: DENOMINATION.toString(), commitment: commitment.toString() })
      setStep('ready')
    } catch (e) {
      setError(e.message)
      setStep('idle')
    }
  }

  async function syncRootAfterDeposit() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          addLog(`Root update retry ${attempt}/3…`)
          await new Promise(r => setTimeout(r, 3000))
        }
        // Phase 1: get current commitments from chain
        const commitmentsRes = await fetch('/api/update-roots', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        })
        if (!commitmentsRes.ok) throw new Error(`Server error ${commitmentsRes.status}`)
        const commitmentsData = await commitmentsRes.json()
        if (!commitmentsData.needsRoot) throw new Error(commitmentsData.error ?? 'Unexpected API response')

        // Phase 2: compute root locally using Poseidon WASM
        const LEVELS = 20
        let zeros = [0n]
        for (let i = 1; i <= LEVELS; i++) zeros.push(await poseidon2(zeros[i - 1], zeros[i - 1]))
        let layer = commitmentsData.commitments.map(c => BigInt(c))
        for (let lvl = 0; lvl < LEVELS; lvl++) {
          const next = []
          const size = Math.max(Math.ceil(layer.length / 2), 1)
          for (let i = 0; i < size; i++)
            next.push(await poseidon2(layer[i * 2] ?? zeros[lvl], layer[i * 2 + 1] ?? zeros[lvl]))
          layer = next
        }
        const newRoot = '0x' + (layer[0] ?? zeros[LEVELS]).toString(16).padStart(64, '0')
        addLog(`Root computed for ${commitmentsData.commitments.length} deposit(s)`)

        // Phase 3: submit root to chain via API
        const rootRes = await fetch('/api/update-roots', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: newRoot, leaves: commitmentsData.commitments.length })
        })
        if (!rootRes.ok) throw new Error(`Server error ${rootRes.status}`)
        const rootData = await rootRes.json()
        if (rootData.ok) {
          addLog(rootData.partial ? 'Root submitted (finalizing on-chain) ✓' : 'Root updated ✓', 'success')
          return // success
        }
        throw new Error(rootData.error ?? 'Root update failed')
      } catch (e) {
        if (attempt >= 3) {
          addLog(`Root update failed — your deposit is safe. Withdrawals will auto-sync.`, 'error')
          return // non-fatal: withdraw self-heals
        }
      }
    }
  }

  async function submitDeposit() {
    const usingFreighter = !!wallet.address && !showSecretKey
    if (!note) { setError('Generate a note first.'); return }
    if (!usingFreighter && !secretKey.trim()) {
      setError('Enter your secret key or connect Freighter.')
      return
    }

    setStep('depositing')
    setError(null)
    addLog(`Connecting to Stellar ${network.name}…`)

    try {
      const signerAddress = usingFreighter
        ? wallet.address
        : Keypair.fromSecret(secretKey.trim()).publicKey()

      const server  = new SorobanRpc.Server(network.rpcUrl)
      const account = await server.getAccount(signerAddress)

      const commitHex = BigInt(note.commitment).toString(16).padStart(64, '0')
      addLog(`Commitment: ${commitHex.slice(0, 12)}…`)

      const contract = new Contract(network.poolContract)
      const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: network.passphrase })
        .addOperation(contract.call(
          'deposit',
          xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(Keypair.fromPublicKey(signerAddress).rawPublicKey())
          )),
          xdr.ScVal.scvBytes(Buffer.from(commitHex, 'hex')),
        ))
        .setTimeout(300)
        .build()

      addLog('Simulating…')
      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error)

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build()

      let send
      if (usingFreighter) {
        addLog('Approve in Freighter…')
        const signedXdr = await wallet.sign(prepared, network.passphrase)
        addLog('Got signed XDR from Freighter ✓')
        const signedTx  = TransactionBuilder.fromXDR(signedXdr, network.passphrase)
        send = await server.sendTransaction(signedTx)
      } else {
        prepared.sign(Keypair.fromSecret(secretKey.trim()))
        send = await server.sendTransaction(prepared)
      }

      addLog(`Send status: ${send.status}`)
      if (send.status === 'ERROR') {
        throw new Error(`Transaction rejected by network: ${send.errorResultXdr ?? 'unknown error'}`)
      }
      if (send.status === 'TRY_AGAIN_LATER') {
        throw new Error('Network is busy — please try again in a moment')
      }

      setTxHash(send.hash)
      addLog(`TX submitted: ${send.hash.slice(0, 16)}…`)

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const poll = await server.getTransaction(send.hash)
        if (poll.status === 'SUCCESS') {
          addLog('Deposit confirmed ✓', 'success')
          addLog('Updating pool Merkle root…')
          await syncRootAfterDeposit()
          setStep('done')
          onDeposited?.()
          return
        }
        if (poll.status === 'FAILED') throw new Error('Transaction failed on-chain')
        // NOT_FOUND = still pending, keep polling
      }
      // Timed out but TX may still confirm — show hash so user can verify
      setStep('done')
      addLog('Timed out waiting — TX may still confirm. Check Explorer.', 'error')
      onDeposited?.()
    } catch (e) {
      setError(e.message)
      addLog(e.message, 'error')
      setStep('ready')
    }
  }

  function downloadNote() {
    const blob = new Blob([JSON.stringify(note, null, 2)], { type: 'application/json' })
    const a    = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = `veil-note-${Date.now()}.json`
    a.click()
  }

  return (
    <div>
      <h2 style={s.title}>Deposit</h2>
      <p style={s.desc}>
        Deposit <strong>1 XLM</strong> into the Veil pool. You'll receive a private note —
        keep it safe, it's the only way to withdraw later.
      </p>

      {/* Step indicators */}
      <div style={s.flow}>
        <StepDot n={1} active={step === 'idle' || step === 'generating'} done={!!note} label="Generate note" />
        <div style={s.arrow}>→</div>
        <StepDot n={2} active={step === 'ready' || step === 'depositing'} done={step === 'done'} label="Deposit" />
        <div style={s.arrow}>→</div>
        <StepDot n={3} done={step === 'done'} label="Save note" />
      </div>

      {/* STEP 1: Generate note */}
      {step === 'idle' && (
        <button style={s.btn} onClick={generateNote}>Generate Note</button>
      )}
      {step === 'generating' && (
        <button style={{ ...s.btn, ...s.btnDisabled }} disabled>⟳ Generating…</button>
      )}

      {/* Note card */}
      {note && (
        <div style={s.noteBox}>
          <div style={s.noteHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={s.noteTitle}>🔑 Your Private Note</span>
              <span style={s.noteBadge}>SECRET</span>
            </div>
            <button style={s.toggleBtn} onClick={() => setNoteExpanded(v => !v)}>
              {noteExpanded ? '▲ Hide details' : '▼ Show details'}
            </button>
          </div>

          {/* Collapsed summary */}
          {!noteExpanded && (
            <div style={s.noteSummary}>
              <span style={s.noteSummaryText}>
                Commitment: <code style={s.noteSummaryCode}>
                  {BigInt(note.commitment).toString(16).padStart(64,'0').slice(0,12)}…
                </code>
              </span>
              <span style={s.noteSummaryHint}>Details hidden for privacy</span>
            </div>
          )}

          {/* Expanded details */}
          {noteExpanded && (
            <>
              <NoteRow label="Nullifier"  value={note.nullifier} />
              <NoteRow label="Secret"     value={note.secret} />
              <NoteRow label="Amount"     value={`${(BigInt(note.amount) / 10_000_000n).toString()} XLM`} />
              <NoteRow label="Commitment" value={BigInt(note.commitment).toString(16).padStart(64, '0')} />
            </>
          )}

          <div style={s.noteWarning}>
            ⚠️ Download and store this note. Losing it means losing access to your funds.
          </div>
          <button style={{ ...s.btn, ...s.btnSecondary, marginTop: 10 }} onClick={downloadNote}>
            ↓ Download note.json
          </button>
        </div>
      )}

      {/* STEP 2: Sign & Deposit */}
      {note && step !== 'done' && (
        <div style={s.signSection}>
          {wallet.address && !showSecretKey ? (
            /* Freighter connected */
            <div style={s.walletReady}>
              <span style={s.dot} />
              <div>
                <div style={s.walletAddr}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</div>
                <div style={s.walletSub}>Freighter — will sign deposit transaction</div>
              </div>
              <button style={s.switchLink} onClick={() => setShowSecretKey(true)}>use key instead</button>
            </div>
          ) : (
            /* Secret key fallback */
            <div>
              <div style={s.keyHeader}>
                {wallet.address && (
                  <button style={s.switchLink} onClick={() => setShowSecretKey(false)}>← use Freighter</button>
                )}
                {!wallet.address && (
                  <button style={s.connectInline} onClick={wallet.connect} disabled={wallet.connecting}>
                    {wallet.connecting ? '⟳ Connecting…' : '⬡ Connect Freighter instead'}
                  </button>
                )}
              </div>
              <label style={s.label}>Secret Key</label>
              <input
                type="password"
                placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                value={secretKey}
                onChange={e => setSecretKey(e.target.value)}
                style={s.input}
              />
              <p style={s.hint}>Stays in your browser — never sent anywhere.</p>
            </div>
          )}

          <button
            style={{ ...s.btn, ...(step === 'depositing' ? s.btnDisabled : {}) }}
            onClick={submitDeposit}
            disabled={step === 'depositing'}
          >
            {step === 'depositing' ? '⟳ Depositing…' : '⬡ Sign & Deposit 1 XLM'}
          </button>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div style={s.successBox}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <div style={s.successText}>Deposit confirmed!</div>
          <a href={`${network.explorerBase}/tx/${txHash}`} target="_blank" rel="noreferrer" style={s.txLink}>
            View on Stellar Expert ↗
          </a>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
            Your note.json is your withdrawal key. Keep it private.
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

function StepDot({ n, active, done, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: done ? 'var(--green)' : active ? '#e2e8f0' : 'var(--muted)' }}>
      <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: done ? 'var(--green)' : active ? 'var(--accent)' : 'var(--surface2)', color: done || active ? '#fff' : 'var(--muted)', border: `1px solid ${done ? 'var(--green)' : active ? 'var(--accent)' : 'var(--border)'}` }}>
        {done ? '✓' : n}
      </div>
      {label}
    </div>
  )
}

function NoteRow({ label, value }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const display = value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', width: 90, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', color: '#e2e8f0', flex: 1, fontSize: 12, wordBreak: 'break-all' }} title={value}>{display}</span>
      <button style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', fontSize: 11 }} onClick={copy}>{copied ? '✓' : '⎘'}</button>
    </div>
  )
}

const s = {
  title:       { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 },
  desc:        { fontSize: 14, color: 'var(--muted)', marginBottom: 24, lineHeight: 1.6 },
  flow:        { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, flexWrap: 'wrap' },
  arrow:       { color: 'var(--muted)', fontSize: 14 },
  btn:         { width: '100%', padding: '11px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginBottom: 8 },
  btnSecondary:{ background: 'var(--surface2)', color: 'var(--muted)', border: '1px solid var(--border)' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  noteBox:        { background: 'var(--surface2)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: 16, marginBottom: 20 },
  noteHeader:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  noteTitle:      { fontWeight: 700, color: '#e2e8f0', fontSize: 14 },
  noteBadge:      { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' },
  toggleBtn:      { background: 'none', border: '1px solid rgba(148,163,184,0.3)', borderRadius: 6, color: '#94a3b8', fontSize: 11, padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap' },
  noteSummary:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: 6, marginBottom: 10 },
  noteSummaryText:{ fontSize: 12, color: '#94a3b8' },
  noteSummaryCode:{ fontFamily: 'monospace', color: '#e2e8f0', letterSpacing: '0.02em' },
  noteSummaryHint:{ fontSize: 11, color: 'rgba(148,163,184,0.6)', fontStyle: 'italic' },
  noteWarning:    { fontSize: 12, color: '#fbbf24', marginTop: 10, lineHeight: 1.5, padding: '8px 10px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' },
  signSection: { marginBottom: 20 },
  walletReady: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', marginBottom: 12 },
  dot:         { width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981', flexShrink: 0 },
  walletAddr:  { fontFamily: 'var(--mono)', color: '#10b981', fontWeight: 600, fontSize: 13 },
  walletSub:   { fontSize: 11, color: 'var(--muted)', marginTop: 2 },
  switchLink:  { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline', flexShrink: 0 },
  keyHeader:   { marginBottom: 8 },
  connectInline: { padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(124,58,237,0.4)', background: 'rgba(124,58,237,0.1)', color: '#a78bfa', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginBottom: 10, display: 'block' },
  label:       { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 },
  input:       { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: '#e2e8f0', fontSize: 13, fontFamily: 'var(--mono)', outline: 'none', boxSizing: 'border-box' },
  hint:        { fontSize: 12, color: 'var(--muted)', marginTop: 6, marginBottom: 12 },
  successBox:  { textAlign: 'center', padding: '24px 0' },
  successText: { fontWeight: 700, fontSize: 16, color: 'var(--green)', marginBottom: 8 },
  txLink:      { fontSize: 13, color: 'var(--cyan)', display: 'block' },
  error:       { fontSize: 13, color: 'var(--red)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', marginTop: 12, wordBreak: 'break-all' },
  logBox:      { marginTop: 16, padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)', maxHeight: 160, overflowY: 'auto' },
  logLine:     { fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 4, lineHeight: 1.5 },
}
