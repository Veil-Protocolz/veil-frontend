import { useWallet } from '../WalletContext'

export default function ConnectWallet() {
  const { address, connecting, error, connect, disconnect } = useWallet()

  if (address) {
    return (
      <div style={s.connected}>
        <span style={s.dot} />
        <span style={s.addr} title={address}>
          {address.slice(0, 4)}…{address.slice(-4)}
        </span>
        <button style={s.disconnectBtn} onClick={disconnect} title="Disconnect">✕</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button style={s.btn} onClick={connect} disabled={connecting}>
        {connecting ? '⟳ Connecting…' : '⬡ Connect Wallet'}
      </button>
      {error && <div style={s.error}>{error}</div>}
    </div>
  )
}

const s = {
  btn: {
    padding: '7px 14px',
    borderRadius: 8,
    border: '1px solid rgba(124,58,237,0.5)',
    background: 'rgba(124,58,237,0.1)',
    color: '#a78bfa',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  connected: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(16,185,129,0.3)',
    background: 'rgba(16,185,129,0.08)',
  },
  dot: {
    width: 7, height: 7,
    borderRadius: '50%',
    background: '#10b981',
    boxShadow: '0 0 6px #10b981',
    flexShrink: 0,
  },
  addr: {
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    color: '#10b981',
    fontWeight: 600,
  },
  disconnectBtn: {
    background: 'none',
    border: 'none',
    color: '#475569',
    cursor: 'pointer',
    fontSize: 12,
    padding: '0 2px',
    lineHeight: 1,
  },
  error: {
    fontSize: 11,
    color: '#ef4444',
    maxWidth: 200,
    textAlign: 'right',
  },
}
