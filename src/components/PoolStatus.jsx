import { useState, useEffect } from 'react'
import { rpc as SorobanRpc, xdr, Contract, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { RPC_URL, EXPLORER_BASE } from '../config'

export default function PoolStatus({ contractId, refreshTick }) {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const server = new SorobanRpc.Server(RPC_URL)
        const contract = new Contract(contractId)

        // Read pool root
        const simRoot = await server.simulateTransaction(
          buildReadTx(contract, 'get_pool_root')
        )
        const poolRoot = parseHex(simRoot)

        const simAsp = await server.simulateTransaction(
          buildReadTx(contract, 'get_asp_root')
        )
        const aspRoot = parseHex(simAsp)

        const simCommit = await server.simulateTransaction(
          buildReadTx(contract, 'get_commitments')
        )
        const commitments = parseCommitments(simCommit)

        if (!cancelled) {
          setState({ poolRoot, aspRoot, commitments, ts: Date.now() })
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setState(prev => prev ? { ...prev, error: e.message } : { error: e.message })
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [contractId, refreshTick])

  return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.title}>Pool State</span>
        {loading && <span style={s.spinner}>⟳</span>}
        {state?.ts && !loading && (
          <span style={s.ts}>{new Date(state.ts).toLocaleTimeString()}</span>
        )}
      </div>

      {state?.error && <div style={s.error}>{state.error}</div>}

      <Field label="Pool Merkle Root" value={state?.poolRoot} mono trunc />
      <Field label="ASP Root" value={state?.aspRoot} mono trunc />
      <Field label="Deposits" value={state?.commitments?.length ?? '—'} />

      {state?.commitments?.length > 0 && (
        <div style={s.commitSection}>
          <div style={s.commitLabel}>Commitments</div>
          {state.commitments.slice(-3).map((c, i) => (
            <div key={i} style={s.commit}>
              <span style={s.commitIdx}>#{(state.commitments.length - state.commitments.slice(-3).length + i)}</span>
              <span style={s.commitVal}>{c.slice(0, 10)}…{c.slice(-8)}</span>
            </div>
          ))}
          {state.commitments.length > 3 && (
            <div style={s.more}>+{state.commitments.length - 3} more</div>
          )}
        </div>
      )}

      <div style={s.divider} />

      <div style={s.contractRow}>
        <span style={s.contractLabel}>Contract</span>
        <a
          href={`${EXPLORER_BASE}/contract/${contractId}`}
          target="_blank"
          rel="noreferrer"
          style={s.contractLink}
        >
          {contractId.slice(0, 8)}…{contractId.slice(-6)} ↗
        </a>
      </div>

      <div style={s.note}>
        Running on Stellar Testnet · Protocol 26<br />
        BLS12-381 Groth16 verification on-chain
      </div>
    </div>
  )
}

function Field({ label, value, mono, trunc }) {
  if (!value && value !== 0) return (
    <div style={s.field}>
      <div style={s.fieldLabel}>{label}</div>
      <div style={s.fieldSkeleton} />
    </div>
  )
  const display = trunc && typeof value === 'string' && value.length > 20
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : String(value)
  return (
    <div style={s.field}>
      <div style={s.fieldLabel}>{label}</div>
      <div style={{ ...s.fieldVal, fontFamily: mono ? 'var(--mono)' : 'inherit' }}>
        {display}
      </div>
    </div>
  )
}

// ---- helpers ----

function buildReadTx(contract, method) {
  const kp = Keypair.random()
  const account = { accountId: () => kp.publicKey(), sequenceNumber: () => '0', incrementSequenceNumber() {} }
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(method))
    .setTimeout(10)
    .build()
}

function parseHex(sim) {
  try {
    const val = SorobanRpc.Api.isSimulationSuccess(sim)
      ? sim.result?.retval
      : null
    if (!val) return null
    // BytesN<32> comes back as ScvBytes
    if (val.switch().name === 'scvBytes') {
      return Buffer.from(val.bytes()).toString('hex')
    }
    return JSON.stringify(xdr.ScVal.toXDR(val).toString('hex'))
  } catch { return null }
}

function parseCommitments(sim) {
  try {
    const val = SorobanRpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : null
    if (!val) return []
    // Vec<BytesN<32>> — scvVec of scvBytes
    if (val.switch().name === 'scvVec') {
      return val.vec().map(v => Buffer.from(v.bytes()).toString('hex'))
    }
    return []
  } catch { return [] }
}

const s = {
  card: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 20,
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 },
  title: { fontWeight: 700, fontSize: 14, color: '#e2e8f0', flex: 1 },
  spinner: { color: 'var(--accent)', animation: 'spin 1s linear infinite', fontSize: 16 },
  ts: { fontSize: 11, color: 'var(--muted)' },
  error: { fontSize: 12, color: 'var(--red)', marginBottom: 12, wordBreak: 'break-all' },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 11, color: 'var(--muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' },
  fieldVal: { fontSize: 13, color: '#e2e8f0' },
  fieldSkeleton: { height: 18, borderRadius: 4, background: 'var(--surface2)', width: '70%' },
  commitSection: { marginTop: 4, marginBottom: 8 },
  commitLabel: { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 },
  commit: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 },
  commitIdx: { fontSize: 11, color: 'var(--muted)', width: 24, flexShrink: 0 },
  commitVal: { fontSize: 12, fontFamily: 'var(--mono)', color: '#94a3b8' },
  more: { fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' },
  divider: { borderTop: '1px solid var(--border)', margin: '12px 0' },
  contractRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  contractLabel: { fontSize: 12, color: 'var(--muted)' },
  contractLink: { fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--cyan)', textDecoration: 'none' },
  note: { fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 },
}
