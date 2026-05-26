import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EvolutionPage from '../EvolutionPage'
import KbCandidatesPage from './KbCandidatesPage'
import RetrievalAuditPage from './RetrievalAuditPage'

export default function KnowledgeShell() {
  const { t } = useTranslation()
  const location = useLocation()
  const tabs = [
    { to: '/knowledge/evolution', label: t('nav.evolution') },
    { to: '/knowledge/candidates', label: t('knowledge.candidates') },
    { to: '/knowledge/retrieval', label: t('knowledge.retrieval') },
  ]

  if (location.pathname === '/knowledge' || location.pathname === '/knowledge/') {
    return <Navigate to="/knowledge/evolution" replace />
  }

  return (
    <div className="page">
      <nav style={{ display: 'flex', gap: 12, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            style={({ isActive }) => ({
              color: isActive ? 'var(--accent)' : 'var(--muted)',
              fontWeight: isActive ? 600 : 400,
              textDecoration: 'none',
            })}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="evolution" element={<EvolutionPage />} />
        <Route path="candidates" element={<KbCandidatesPage />} />
        <Route path="retrieval" element={<RetrievalAuditPage />} />
      </Routes>
    </div>
  )
}

