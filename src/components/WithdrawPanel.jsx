import { useState, useRef, useEffect } from 'react'
import { rpc as SorobanRpc, Contract, TransactionBuilder, xdr, Keypair } from '@stellar/stellar-sdk'
import { useNetwork } from '../NetworkContext'
import { useWallet } from '../WalletContext'
import { g1ToBytes, g2ToBytes, fieldToBytes32 } from '../stellar'
import { poseidon2 } from '../lib/poseidon'

export default function WithdrawPanel({ onWithdrawn }) {
  const { network } = useNetwork()
  const wallet = useWallet()

  const [note, setNote]             = useState(null)   // parsed note.json
  const [recipient, setRecipient]   = useState('')
  const [secretKey, setSecretKey]   = useState('')
  const [progress, setProgress]     = useState(null)   // { step, total, msg }
  const [phase, setPhase]           = useState('idle') // idle|proving|submitting|done
  const [txHash, setTxHash]         = useState(null)
  const [error, setError]           = useState(null)
  const [log, setLog]               = useState([])
  const fileRef                     = useRef()
  const workerRef                   = useRef()

  // Pre-fill recipient from connected wallet only on first connect
  useEffect(() => {
    if (wallet.address && !recipient) setRecipient(wallet.address)
  }, [wallet.address])

  function isValidStellarAddress(addr) {
    return /^G[A-Z2-7]{55}$/.test(addr.trim())
  }

  // Cleanup worker on unmount
  useEffect(() => () => workerRef.current?.terminate(), [])

  const addLog = (msg, type = 'info') => setLog(prev => [...prev, { msg, type }])

  function loadNoteFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target.result)
        if (!parsed.nullifier || !parsed.secret || !parsed.amount) {
          setError('Invalid note.json — missing nullifier, secret, or amount.')
          return
        }
        setNote(parsed)
        setError(null)
      } catch {
        setError('Could not parse note.json — make sure it is a valid JSON file.')
      }
    }
    reader.readAsText(file)
  }

  async function fetchCommitmentsFromChain() {
    const server = new SorobanRpc.Server(network.rpcUrl)
    const contract = new Contract(network.poolContract)
    const kp = Keypair.random()
    const account = {
      accountId: () => kp.publicKey(),
      sequenceNumber: () => '0',
      incrementSequenceNumber() {},
    }
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: network.passphrase })
      .addOperation(contract.call('get_commitments'))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    const val = SorobanRpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : null
    if (!val || val.switch().name !== 'scvVec') return []
    return val.vec().map(v => ('0x' + Buffer.from(v.bytes()).toString('hex')))
  }

  async function computeExpectedRoot(commitments) {
    const LEVELS = 20
    let zeros = [0n]
    for (let i = 1; i <= LEVELS; i++) zeros.push(await poseidon2(zeros[i - 1], zeros[i - 1]))
    let layer = commitments.map(c => BigInt(c))
    for (let lvl = 0; lvl < LEVELS; lvl++) {
      const next = []
      const size = Math.max(Math.ceil(layer.length / 2), 1)
      for (let i = 0; i < size; i++)
        next.push(await poseidon2(layer[i * 2] ?? zeros[lvl], layer[i * 2 + 1] ?? zeros[lvl]))
      layer = next
    }
    return '0x' + (layer[0] ?? zeros[LEVELS]).toString(16).padStart(64, '0')
  }

  async function readOnChainRoot(server, contract, method) {
    const kp = Keypair.random()
    const dummy = { accountId: () => kp.publicKey(), sequenceNumber: () => '0', incrementSequenceNumber() {} }
    const tx = new TransactionBuilder(dummy, { fee: '100', networkPassphrase: network.passphrase })
      .addOperation(contract.call(method)).setTimeout(30).build()
    const sim = await server.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null
    const retval = sim.result?.retval
    if (!retval || retval.switch().name !== 'scvBytes') return null
    return '0x' + Buffer.from(retval.bytes()).toString('hex')
  }

  async function ensureRootsInSync(server, contract, expectedRoot, commitmentCount) {
    const [poolRoot, aspRoot] = await Promise.all([
      readOnChainRoot(server, contract, 'get_pool_root'),
      readOnChainRoot(server, contract, 'get_asp_root'),
    ])
    const poolOk = poolRoot === expectedRoot
    const aspOk  = aspRoot  === expectedRoot
    if (poolOk && aspOk) return

    addLog(`Root mismatch detected — auto-syncing (pool:${poolOk ? '✓' : '✗'} asp:${aspOk ? '✓' : '✗'})…`)

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('/api/update-roots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: expectedRoot, leaves: commitmentCount }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.ok) {
          addLog(data.partial ? 'Roots submitted (confirming in background) ✓' : 'Roots synced ✓', 'success')
          return
        }
        throw new Error(data.error ?? 'Unknown error')
      } catch (e) {
        if (attempt >= 3) throw new Error(`Root sync failed after 3 attempts: ${e.message}`)
        addLog(`Sync attempt ${attempt} failed — retrying…`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }

  async function run() {
    const usingFreighter = !!wallet.address
    const dest = recipient.trim()
    if (!note)  { setError('Upload your note.json first.'); return }
    if (!dest)  { setError('Enter the recipient address.'); return }
    if (!isValidStellarAddress(dest)) {
      setError('Invalid recipient address — must be a valid Stellar address starting with G.')
      return
    }
    if (!usingFreighter && !secretKey.trim()) {
      setError('Connect Freighter wallet or enter your secret key to pay fees.')
      return
    }

    setError(null)
    setLog([])
    setProgress(null)
    setPhase('proving')

    try {
      addLog('Fetching pool commitments from chain…')
      const commitments = await fetchCommitmentsFromChain()
      addLog(`Found ${commitments.length} commitment${commitments.length === 1 ? '' : 's'} in pool`)

      // Self-healing: verify on-chain roots match current commitments before proving.
      // This prevents wasting 60s generating a proof that will fail on simulation.
      addLog('Verifying pool state…')
      const server = new SorobanRpc.Server(network.rpcUrl)
      const contract = new Contract(network.poolContract)
      const expectedRoot = await computeExpectedRoot(commitments)
      await ensureRootsInSync(server, contract, expectedRoot, commitments.length)
      addLog('Pool state verified ✓')

      const proofResult = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../proveWorker.js', import.meta.url), { type: 'module' })
        workerRef.current = worker
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') {
            setProgress({ step: data.step, total: data.total, msg: data.msg })
            addLog(data.msg)
          } else if (data.type === 'done') {
            worker.terminate()
            resolve(data)
          } else if (data.type === 'error') {
            worker.terminate()
            reject(new Error(data.message))
          }
        }
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message)) }
        worker.postMessage({ note, commitments, recipient: dest })
      })

      const { proof, meta } = proofResult
      setProgress(null)
      setPhase('submitting')
      addLog('Proof generated ✓ — building withdrawal transaction…')

      const proofABytes = g1ToBytes(proof.pi_a)
      const proofBBytes = g2ToBytes(proof.pi_b)
      const proofCBytes = g1ToBytes(proof.pi_c)

      const signerAddress = usingFreighter
        ? wallet.address
        : Keypair.fromSecret(secretKey.trim()).publicKey()

      const account = await server.getAccount(signerAddress)

      const tx = new TransactionBuilder(account, { fee: '10000000', networkPassphrase: network.passphrase })
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
              xdr.PublicKey.publicKeyTypeEd25519(Keypair.fromPublicKey(dest).rawPublicKey())
            )
          ),
          xdr.ScVal.scvI128(new xdr.Int128Parts({
            hi:  xdr.Int64.fromString('0'),
            lo:  xdr.Uint64.fromString(meta.amount),
          })),
        ))
        .setTimeout(300)
        .build()

      addLog('Simulating transaction…')
      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error('Simulation failed: ' + sim.error)
      addLog('Simulation passed ✓')

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build()

      let send
      if (usingFreighter) {
        addLog('Approve in Freighter…')
        const signedXdr = await wallet.sign(prepared, network.passphrase)
        addLog('Got signed XDR from Freighter ✓')
        const signedTx = TransactionBuilder.fromXDR(signedXdr, network.passphrase)
        send = await server.sendTransaction(signedTx)
      } else {
        const kp = Keypair.fromSecret(secretKey.trim())
        prepared.sign(kp)
        send = await server.sendTransaction(prepared)
      }

      addLog(`Send status: ${send.status}`)
      if (send.status === 'ERROR') {
        throw new Error(`Transaction rejected: ${send.errorResultXdr ?? 'unknown error'}`)
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
          addLog('Withdrawal confirmed ✓', 'success')
          setPhase('done')
          onWithdrawn?.()
          return
        }
        if (poll.status === 'FAILED') throw new Error('Transaction failed on-chain')
        // NOT_FOUND = still pending, keep polling
      }
      // Timed out — TX may still confirm, show it as done with warning
      setPhase('done')
      addLog('Timed out waiting — TX may still confirm. Check Explorer.', 'error')
      onWithdrawn?.()
    } catch (e) {
      setError(e.message)
      addLog(e.message, 'error')
      setPhase('idle')
      setProgress(null)
    }
  }

  const busy = phase === 'proving' || phase === 'submitting'
  const progressPct = progress ? Math.round((progress.step / progress.total) * 100) : 0

  return (
    <div>
      <h2 style={s.title}>Withdraw</h2>
      <p style={s.desc}>
        Upload your <code style={s.code}>note.json</code> — the app generates
        the ZK proof in your browser and withdraws to any address you choose.
        No CLI required.
      </p>

      {/* Wallet status banner */}
      {wallet.address ? (
        <div style={s.walletBanner}>
          <span style={s.dot} />
          <span style={s.walletAddr}>
            Connected: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </span>
          <span style={s.walletHint}>— will sign with Freighter</span>
        </div>
      ) : (
        <div style={s.noWalletBanner}>
          No wallet connected — connect Freighter in the header, or enter a secret key below.
        </div>
      )}

      {/* Note upload */}
      <div style={s.section}>
        <label style={s.label}>Upload note.json</label>
        <div style={{ ...s.dropZone, ...(note ? s.dropZoneDone : {}) }} onClick={() => fileRef.current.click()}>
          {note
            ? <><span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ note.json loaded</span><span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>commitment: {BigInt(note.commitment).toString(16).slice(0, 12)}…</span></>
            : <span>Click to upload note.json</span>
          }
        </div>
        <input ref={fileRef} type="file" accept=".json" onChange={loadNoteFile} style={{ display: 'none' }} />
      </div>

      {/* Recipient — core privacy feature: can be ANY address */}
      <div style={s.section}>
        <div style={s.recipientHeader}>
          <label style={{ ...s.label, marginBottom: 0 }}>Recipient address</label>
          <div style={s.recipientActions}>
            {wallet.address && recipient !== wallet.address && (
              <button style={s.addrBtn} onClick={() => setRecipient(wallet.address)}>
                Use my wallet
              </button>
            )}
            {recipient && (
              <button style={s.addrBtn} onClick={() => setRecipient('')}>
                Clear
              </button>
            )}
          </div>
        </div>
        <input
          placeholder="G… enter any Stellar address"
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          style={{
            ...s.input,
            borderColor: recipient && !isValidStellarAddress(recipient)
              ? 'rgba(239,68,68,0.5)'
              : 'var(--border)',
          }}
          spellCheck={false}
          autoComplete="off"
        />
        {recipient && !isValidStellarAddress(recipient) && (
          <p style={s.inputError}>Not a valid Stellar address</p>
        )}
        <div style={s.privacyHint}>
          <span style={s.privacyIcon}>🔒</span>
          <span>
            This can be <strong>any</strong> Stellar address — using a different address
            from the depositor breaks the link between deposit and withdrawal.
          </span>
        </div>
      </div>

      {/* Secret key fallback (only shown when no wallet) */}
      {!wallet.address && (
        <div style={s.section}>
          <label style={s.label}>Secret Key <span style={s.labelHint}>(to pay fees)</span></label>
          <input
            type="password"
            placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            value={secretKey}
            onChange={e => setSecretKey(e.target.value)}
            style={s.input}
          />
          <p style={s.hint}>Never sent to any server — stays in your browser.</p>
        </div>
      )}

      {/* Progress bar */}
      {busy && (
        <div style={s.progressBox}>
          <div style={s.progressHeader}>
            <span style={{ fontSize: 13, color: '#e2e8f0' }}>
              {phase === 'proving' ? 'Generating ZK proof…' : 'Submitting to Stellar…'}
            </span>
            <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>
              {phase === 'proving' ? `${progressPct}%` : ''}
            </span>
          </div>
          {phase === 'proving' && (
            <div style={s.progressTrack}>
              <div style={{ ...s.progressFill, width: `${progressPct}%` }} />
            </div>
          )}
          {progress?.msg && <div style={s.progressMsg}>{progress.msg}</div>}
          {phase === 'proving' && <p style={s.provingNote}>Groth16 proof takes ~60s — don't close this tab.</p>}
        </div>
      )}

      {/* Action button */}
      {phase !== 'done' && (
        <button
          onClick={run}
          disabled={busy || !note || (!wallet.address && !secretKey.trim())}
          style={{ ...s.btn, ...(busy || !note ? s.btnDisabled : {}) }}
        >
          {phase === 'proving'   ? '⟳ Generating proof…' :
           phase === 'submitting'? '⟳ Submitting…' :
           '⚡ Generate Proof & Withdraw'}
        </button>
      )}

      {/* Success */}
      {phase === 'done' && (
        <div style={s.successBox}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <div style={s.successText}>Withdrawal successful!</div>
          <a
            href={`${network.explorerBase}/tx/${txHash}`}
            target="_blank" rel="noreferrer"
            style={s.txLink}
          >
            View on Stellar Expert ↗
          </a>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
            The Groth16 proof was verified on-chain. No one can link this withdrawal to your deposit.
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

const s = {
  title: { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 },
  desc: { fontSize: 14, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.6 },
  code: { fontFamily: 'var(--mono)', fontSize: 13, background: 'var(--surface2)', padding: '1px 5px', borderRadius: 4, color: '#e2e8f0' },
  walletBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', marginBottom: 20, fontSize: 13 },
  dot: { width: 7, height: 7, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981', flexShrink: 0 },
  walletAddr: { fontFamily: 'var(--mono)', color: '#10b981', fontWeight: 600 },
  walletHint: { color: 'var(--muted)', fontSize: 12 },
  noWalletBanner: { padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.2)', color: '#fbbf24', fontSize: 13, marginBottom: 20 },
  section: { marginBottom: 18 },
  label: { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 },
  labelHint: { fontSize: 11, color: '#475569', fontStyle: 'italic', fontWeight: 400 },
  recipientHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  recipientActions: { display: 'flex', gap: 6 },
  addrBtn: { background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--muted)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' },
  inputError: { fontSize: 11, color: 'var(--red)', marginTop: 4 },
  privacyHint: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: '8px 10px', background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.15)', borderRadius: 6, fontSize: 12, color: '#94a3b8', lineHeight: 1.5 },
  privacyIcon: { flexShrink: 0, fontSize: 13 },
  dropZone: { border: '1px dashed var(--border)', borderRadius: 8, padding: '18px 20px', textAlign: 'center', cursor: 'pointer', fontSize: 14, color: 'var(--muted)', background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dropZoneDone: { borderColor: 'rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.05)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: '#e2e8f0', fontSize: 13, fontFamily: 'var(--mono)', outline: 'none', boxSizing: 'border-box' },
  hint: { fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 },
  progressBox: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 },
  progressHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  progressTrack: { height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: '100%', background: 'linear-gradient(90deg, var(--accent), #06b6d4)', borderRadius: 99, transition: 'width 0.4s ease' },
  progressMsg: { fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--muted)' },
  provingNote: { fontSize: 11, color: 'var(--muted)', marginTop: 8, fontStyle: 'italic' },
  btn: { width: '100%', padding: '11px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginBottom: 12 },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  successBox: { textAlign: 'center', padding: '24px 0' },
  successText: { fontWeight: 700, fontSize: 16, color: 'var(--green)', marginBottom: 8 },
  txLink: { fontSize: 13, color: 'var(--cyan)', display: 'block', marginBottom: 4 },
  error: { fontSize: 13, color: 'var(--red)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', marginTop: 12, wordBreak: 'break-all' },
  logBox: { marginTop: 16, padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)', maxHeight: 180, overflowY: 'auto' },
  logLine: { fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 4, lineHeight: 1.5 },
}
