import { useState, useCallback } from 'react'
import DepositPanel from './components/DepositPanel'
import WithdrawPanel from './components/WithdrawPanel'
import PoolStatus from './components/PoolStatus'
import SplashScreen from './components/SplashScreen'
import ConnectWallet from './components/ConnectWallet'
import { NetworkProvider, useNetwork } from './NetworkContext'
import { WalletProvider } from './WalletContext'
import './App.css'

function AppInner() {
  const { network, networkKey, setNetworkKey } = useNetwork()
  const [splash, setSplash] = useState(true)
  const [tab, setTab] = useState('deposit')
  const [refreshTick, setRefreshTick] = useState(0)

  const refresh = useCallback(() => setRefreshTick(t => t + 1), [])

  if (splash) return <SplashScreen onEnter={() => setSplash(false)} />

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>⬡</span>
            <span style={styles.logoText}>Veil</span>
            <NetworkToggle networkKey={networkKey} setNetworkKey={setNetworkKey} />
          </div>
          <div style={styles.headerRight}>
            <span style={styles.tagline}>Compliant Private Payments · Stellar · ZK Groth16</span>
            {network.poolContract ? (
              <a
                href={`${network.explorerBase}/contract/${network.poolContract}`}
                target="_blank"
                rel="noreferrer"
                style={styles.contractLink}
              >
                {network.poolContract.slice(0, 8)}…{network.poolContract.slice(-6)}
              </a>
            ) : (
              <span style={styles.comingSoon}>Mainnet coming soon</span>
            )}
            <ConnectWallet />
          </div>
        </div>
      </header>

      <div style={styles.layout}>
        <main style={styles.main}>
          <TabBar tab={tab} setTab={setTab} />
          <div style={styles.panel}>
            {network.poolContract === null ? (
              <MainnetPlaceholder />
            ) : (
              <>
                {tab === 'deposit'  && <DepositPanel onDeposited={refresh} />}
                {tab === 'withdraw' && <WithdrawPanel onWithdrawn={refresh} />}
                {tab === 'how'      && <HowItWorks />}
              </>
            )}
          </div>
        </main>
        <aside style={styles.aside}>
          {network.poolContract && (
            <PoolStatus
              rpcUrl={network.rpcUrl}
              contractId={network.poolContract}
              refreshTick={refreshTick}
            />
          )}
        </aside>
      </div>
    </div>
  )
}

function NetworkToggle({ networkKey, setNetworkKey }) {
  return (
    <div style={styles.netToggle}>
      {['testnet', 'mainnet'].map(k => (
        <button
          key={k}
          onClick={() => setNetworkKey(k)}
          style={{ ...styles.netBtn, ...(networkKey === k ? styles.netBtnActive : {}) }}
        >
          {k}
        </button>
      ))}
    </div>
  )
}

function TabBar({ tab, setTab }) {
  const tabs = [
    { id: 'deposit',  label: '① Deposit' },
    { id: 'withdraw', label: '② Withdraw' },
    { id: 'how',      label: 'How it works' },
  ]
  return (
    <div style={styles.tabBar}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function MainnetPlaceholder() {
  return (
    <div style={styles.mainnetMsg}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🔜</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Mainnet coming soon</div>
      <div style={{ fontSize: 14, color: 'var(--muted)' }}>Switch to Testnet to try Veil today.</div>
    </div>
  )
}

function HowItWorks() {
  const steps = [
    { icon: '🔑', title: 'Generate a private note', body: 'A random nullifier + secret are generated locally. The commitment = Poseidon(nullifier, secret, amount) is computed and sent on-chain. Only you hold the note.' },
    { icon: '🏦', title: 'Deposit into the pool', body: 'You transfer 1 XLM to the pool contract and register your commitment as a leaf in the Merkle tree.' },
    { icon: '✅', title: 'ASP approves your note', body: 'The Association Set Provider (compliance operator) adds your commitment to the approval Merkle tree. This is the KYC/AML gate.' },
    { icon: '🔒', title: 'Generate a ZK proof', body: 'Your browser proves: (1) your commitment is in the pool tree, (2) in the ASP tree, (3) the nullifier is correct, and (4) the proof is bound to your recipient address. No server involved.' },
    { icon: '⚡', title: 'Verify on Stellar & withdraw', body: "The pool contract verifies the Groth16 proof using Stellar's native BLS12-381 host functions (Protocol 26). If valid and the nullifier is unspent, funds go to the recipient." },
  ]
  return (
    <div>
      <h2 style={styles.sectionTitle}>Privacy + Compliance, proven together</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 28, lineHeight: 1.7 }}>
        Veil breaks the on-chain link between depositor and recipient while enforcing
        regulatory compliance through a zero-knowledge proof.
      </p>
      <div style={styles.steps}>
        {steps.map((s, i) => (
          <div key={i} style={styles.step}>
            <div style={styles.stepIcon}>{s.icon}</div>
            <div>
              <div style={styles.stepTitle}>{s.title}</div>
              <div style={styles.stepBody}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={styles.circuitBox}>
        <div style={styles.circuitTitle}>ZK Stack</div>
        <div style={styles.circuitGrid}>
          {[
            ['Circuit',         'Circom 2.1.6 · ShieldedTransfer(20)'],
            ['Curve',           'BLS12-381 (-p bls12381)'],
            ['Proof system',    'Groth16'],
            ['Hash function',   'Poseidon(2) / Poseidon(3)'],
            ['On-chain verifier','Soroban SDK 26 · bls12_381 host fns'],
            ['Merkle depth',    '20 levels · ~1M deposits capacity'],
          ].map(([k, v]) => (
            <div key={k} style={styles.circuitRow}>
              <span style={styles.circuitKey}>{k}</span>
              <span style={styles.circuitVal}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <NetworkProvider>
      <WalletProvider>
        <AppInner />
      </WalletProvider>
    </NetworkProvider>
  )
}

const styles = {
  app: { minHeight: '100vh', display: 'flex', flexDirection: 'column' },
  header: { borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 10 },
  headerInner: { maxWidth: 1200, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  logo: { display: 'flex', alignItems: 'center', gap: 10 },
  logoIcon: { fontSize: 22, color: 'var(--accent)' },
  logoText: { fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px', color: '#e2e8f0' },
  netToggle: { display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', marginLeft: 4 },
  netBtn: { padding: '3px 10px', fontSize: 11, fontWeight: 600, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' },
  netBtnActive: { background: 'rgba(124,58,237,0.2)', color: 'var(--accent)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  tagline: { fontSize: 13, color: 'var(--muted)' },
  contractLink: { fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--cyan)', textDecoration: 'none', padding: '3px 8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)', borderRadius: 6 },
  comingSoon: { fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' },
  layout: { flex: 1, maxWidth: 1200, margin: '0 auto', width: '100%', padding: '24px 16px', display: 'flex', gap: 24, alignItems: 'flex-start' },
  main: { flex: 1, minWidth: 0 },
  aside: { width: 320, flexShrink: 0, position: 'sticky', top: 72 },
  panel: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 28 },
  tabBar: { display: 'flex', gap: 4, marginBottom: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 },
  tab: { flex: 1, padding: '8px 12px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, fontWeight: 500 },
  tabActive: { background: 'var(--surface2)', color: 'var(--text)', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' },
  mainnetMsg: { textAlign: 'center', padding: '60px 0' },
  sectionTitle: { fontSize: 18, fontWeight: 700, marginBottom: 12, color: '#e2e8f0' },
  steps: { display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 28 },
  step: { display: 'flex', gap: 14, padding: 16, background: 'var(--surface2)', borderRadius: 10, border: '1px solid var(--border)' },
  stepIcon: { fontSize: 22, flexShrink: 0, marginTop: 1 },
  stepTitle: { fontWeight: 600, color: '#e2e8f0', marginBottom: 4 },
  stepBody: { fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 },
  circuitBox: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 },
  circuitTitle: { fontSize: 13, fontWeight: 600, color: 'var(--accent)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' },
  circuitGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
  circuitRow: { display: 'flex', gap: 12, alignItems: 'baseline' },
  circuitKey: { fontSize: 12, color: 'var(--muted)', width: 130, flexShrink: 0 },
  circuitVal: { fontSize: 13, fontFamily: 'var(--mono)', color: '#e2e8f0' },
}
