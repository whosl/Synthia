import { Route, Routes } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import ProjectsPage from '../pages/ProjectsPage'
import ProjectExpandRedirect from '../pages/ProjectExpandRedirect'
import TerminalPage from '../pages/TerminalPage'
import MonitorPage from '../pages/MonitorPage'
import RunDetailPage from '../pages/RunDetailPage'
import VivadoPage from '../pages/VivadoPage'
import KnowledgeBasePage from '../pages/KnowledgeBasePage'
import EvolutionPage from '../pages/EvolutionPage'
import SettingsPage from '../pages/SettingsPage'

export function AppRouter() {
  return <AppShell>
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects/:projectId" element={<ProjectExpandRedirect />} />
      <Route path="/term" element={<TerminalPage />} />
      <Route path="/monitor" element={<MonitorPage />} />
      <Route path="/monitor/runs/:runId" element={<RunDetailPage />} />
      <Route path="/vivado" element={<VivadoPage />} />
      <Route path="/kb" element={<KnowledgeBasePage />} />
      <Route path="/knowledge" element={<KnowledgeBasePage mode="knowledge" />} />
      <Route path="/evolution" element={<EvolutionPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  </AppShell>
}
