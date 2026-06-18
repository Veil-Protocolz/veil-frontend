import { useEffect, useState } from 'react'

export default function SplashScreen({ onEnter }) {
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60)
    return () => clearTimeout(t)
  }, [])

  function enter() {
    setLeaving(true)
    setTimeout(onEnter, 600)
  }

  return (
    <div style={{ ...s.root, opacity: leaving ? 0 : visible ? 1 : 0, transform: leaving ? 'scale(1.03)' : 'scale(1)', transition: 'opacity 0.6s ease, transform 0.6s ease' }}>
      {/* Animated grid background */}
      <div style={s.grid} />
      {/* Radial glow */}
      <div style={s.glow} />

      <div style={s.content}>
        {/* Logo */}
        <div style={s.logoRow}>
          <Hexagon />
          <span style={s.logoText}>Veil</span>
        </div>

        {/* Tagline */}
        <h1 style={s.headline}>
          Private Payments.<br />
          <span style={s.headlineAccent}>Compliant by proof.</span>
        </h1>
        <p style={s.sub}>
          A zero-knowledge shielded pool on Stellar — deposits are public,
          withdrawals are anonymous, compliance is enforced by cryptographic proof.
          No trust. No exceptions.
        </p>

        {/* Proof badges */}
        <div style={s.badges}>
          {[
            { label: 'BLS12-381', desc: 'Elliptic curve' },
            { label: 'Groth16', desc: 'Proof system' },
            { label: 'Poseidon', desc: 'Hash function' },
            { label: 'Soroban', desc: 'On-chain verifier' },
          ].map(b => (
            <div key={b.label} style={s.badge}>
              <span style={s.badgeLabel}>{b.label}</span>
              <span style={s.badgeDesc}>{b.desc}</span>
            </div>
          ))}
        </div>

        {/* Flow diagram */}
        <div style={s.flow}>
          <FlowStep icon="🏦" label="Deposit" sub="public" />
          <FlowArrow />
          <FlowStep icon="🔒" label="ZK Proof" sub="off-chain" accent />
          <FlowArrow />
          <FlowStep icon="⚡" label="Verify" sub="on-chain" />
          <FlowArrow />
          <FlowStep icon="👤" label="Withdraw" sub="anonymous" />
        </div>

        {/* CTA */}
        <button style={s.cta} onClick={enter} onMouseEnter={e => e.currentTarget.style.boxShadow = '0 0 40px rgba(124,58,237,0.6), 0 0 80px rgba(124,58,237,0.2)'} onMouseLeave={e => e.currentTarget.style.boxShadow = '0 0 24px rgba(124,58,237,0.35)'}>
          Launch App
          <span style={s.ctaArrow}>→</span>
        </button>

        <p style={s.network}>
          <span style={s.dot} /> Live on Stellar Testnet · Protocol 26
        </p>
      </div>

      {/* Bottom bar */}
      <div style={s.bottomBar}>
        <span>Built for Stellar ZK Hackathon 2026</span>
        <span style={s.sep}>·</span>
        <a
          href="https://stellar.expert/explorer/testnet/contract/CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW"
          target="_blank"
          rel="noreferrer"
          style={s.bottomLink}
        >
          Contract ↗
        </a>
      </div>
    </div>
  )
}

function Hexagon() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
      <polygon
        points="22,2 40,12 40,32 22,42 4,32 4,12"
        fill="rgba(124,58,237,0.15)"
        stroke="#7c3aed"
        strokeWidth="1.5"
      />
      <polygon
        points="22,9 35,16.5 35,27.5 22,35 9,27.5 9,16.5"
        fill="rgba(124,58,237,0.08)"
        stroke="rgba(124,58,237,0.5)"
        strokeWidth="1"
      />
      <circle cx="22" cy="22" r="5" fill="#7c3aed" opacity="0.9" />
    </svg>
  )
}

function FlowStep({ icon, label, sub, accent }) {
  return (
    <div style={{ ...s.flowStep, ...(accent ? s.flowStepAccent : {}) }}>
      <span style={s.flowIcon}>{icon}</span>
      <span style={{ ...s.flowLabel, ...(accent ? { color: '#e2e8f0' } : {}) }}>{label}</span>
      <span style={{ ...s.flowSub, ...(accent ? { color: 'var(--accent)' } : {}) }}>{sub}</span>
    </div>
  )
}

function FlowArrow() {
  return (
    <div style={s.flowArrow}>
      <svg width="24" height="12" viewBox="0 0 24 12" fill="none">
        <path d="M0 6h20M14 1l6 5-6 5" stroke="rgba(124,58,237,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

const s = {
  root: {
    position: 'fixed', inset: 0, zIndex: 100,
    background: '#08080f',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  grid: {
    position: 'absolute', inset: 0,
    backgroundImage: `
      linear-gradient(rgba(124,58,237,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124,58,237,0.04) 1px, transparent 1px)
    `,
    backgroundSize: '48px 48px',
    maskImage: 'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
    WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
  },
  glow: {
    position: 'absolute',
    top: '30%', left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 600, height: 400,
    background: 'radial-gradient(ellipse, rgba(124,58,237,0.12) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  content: {
    position: 'relative', zIndex: 1,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', textAlign: 'center',
    padding: '0 24px',
    maxWidth: 680,
  },
  logoRow: {
    display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28,
  },
  logoText: {
    fontSize: 42, fontWeight: 800,
    letterSpacing: '-2px', color: '#e2e8f0',
  },
  headline: {
    fontSize: 'clamp(28px, 5vw, 48px)',
    fontWeight: 800,
    lineHeight: 1.2,
    color: '#e2e8f0',
    letterSpacing: '-1px',
    marginBottom: 18,
  },
  headlineAccent: {
    background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  },
  sub: {
    fontSize: 16, color: '#64748b',
    lineHeight: 1.7, marginBottom: 36,
    maxWidth: 520,
  },
  badges: {
    display: 'flex', gap: 8, flexWrap: 'wrap',
    justifyContent: 'center', marginBottom: 40,
  },
  badge: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '8px 16px',
    background: 'rgba(124,58,237,0.06)',
    border: '1px solid rgba(124,58,237,0.2)',
    borderRadius: 8,
    gap: 2,
  },
  badgeLabel: {
    fontSize: 13, fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace",
    color: '#a78bfa',
  },
  badgeDesc: { fontSize: 11, color: '#475569' },
  flow: {
    display: 'flex', alignItems: 'center', gap: 4,
    marginBottom: 44, flexWrap: 'wrap', justifyContent: 'center',
  },
  flowStep: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '12px 16px', borderRadius: 10,
    background: '#0f0f1a', border: '1px solid #1e1e35',
    minWidth: 80,
  },
  flowStepAccent: {
    background: 'rgba(124,58,237,0.08)',
    border: '1px solid rgba(124,58,237,0.3)',
    boxShadow: '0 0 20px rgba(124,58,237,0.1)',
  },
  flowIcon: { fontSize: 20 },
  flowLabel: { fontSize: 12, fontWeight: 600, color: '#94a3b8' },
  flowSub: { fontSize: 10, color: '#475569' },
  flowArrow: { flexShrink: 0, padding: '0 2px', marginTop: -8 },
  cta: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '14px 36px', borderRadius: 10,
    background: 'linear-gradient(135deg, #7c3aed, #5b21b6)',
    border: 'none', color: '#fff',
    fontSize: 16, fontWeight: 700, cursor: 'pointer',
    letterSpacing: '-0.3px',
    boxShadow: '0 0 24px rgba(124,58,237,0.35)',
    transition: 'box-shadow 0.2s ease, transform 0.15s ease',
    marginBottom: 20,
  },
  ctaArrow: { fontSize: 18 },
  network: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 12, color: '#475569',
  },
  dot: {
    display: 'inline-block', width: 7, height: 7,
    borderRadius: '50%', background: '#10b981',
    boxShadow: '0 0 6px #10b981',
  },
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTop: '1px solid #1e1e35',
    padding: '12px 24px',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    gap: 12, fontSize: 12, color: '#334155',
  },
  sep: { color: '#1e1e35' },
  bottomLink: { color: '#475569', textDecoration: 'none' },
}
