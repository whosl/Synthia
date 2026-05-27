import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { ProtectedRoute } from '../components/auth/ProtectedRoute'
import { AppShell } from '../components/layout/AppShell'
import LoginPage from '../pages/LoginPage'
import ProjectsPage from '../pages/ProjectsPage'
import ProjectImportPage from '../pages/ProjectImportPage'
import ProjectExpandRedirect from '../pages/ProjectExpandRedirect'
import TerminalPage from '../pages/TerminalPage'
import MonitorPage from '../pages/MonitorPage'
import ConnectorsPage from '../pages/ConnectorsPage'
import VivadoConnectorPage from '../pages/connectors/VivadoConnectorPage'
import RunDetailPage from '../pages/RunDetailPage'
import KnowledgeShell from '../pages/knowledge/KnowledgeShell'
import SettingsPage from '../pages/SettingsPage'
import SessionsPage from '../pages/SessionsPage'
import RunsPage from '../pages/RunsPage'
import ReportsPage from '../pages/ReportsPage'
import ReportDetailPage from '../pages/ReportDetailPage'
import SessionDetailPage from '../pages/SessionDetailPage'
import ApprovalsPage from '../pages/ApprovalsPage'
import BenchmarksPage from '../pages/BenchmarksPage'
import BenchmarkSuiteDetailPage from '../pages/BenchmarkSuiteDetailPage'
import HardwarePage from '../pages/HardwarePage'
import ProgramFlowPage from '../pages/ProgramFlowPage'

function MonitorRunRedirect() {
  const { runId = '' } = useParams()
  return <Navigate to={`/runs/${runId}`} replace />
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppShell>
              <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects/import" element={<ProjectImportPage />} />
      <Route path="/projects/:projectId" element={<ProjectExpandRedirect />} />

      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
      <Route path="/term" element={<TerminalPage />} />

      <Route path="/runs" element={<RunsPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
      <Route path="/monitor/runs/:runId" element={<MonitorRunRedirect />} />

      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/reports/:reportId" element={<ReportDetailPage />} />

      <Route path="/approvals" element={<ApprovalsPage />} />
      <Route path="/approvals/:approvalId" element={<ApprovalsPage />} />

      <Route path="/benchmarks" element={<BenchmarksPage />} />
      <Route path="/benchmarks/:suiteId" element={<BenchmarkSuiteDetailPage />} />

      <Route path="/hardware" element={<HardwarePage />} />
      <Route path="/hardware/:targetId/program" element={<ProgramFlowPage />} />

      <Route path="/connectors" element={<ConnectorsPage />} />
      <Route path="/connectors/vivado" element={<VivadoConnectorPage />} />
      <Route path="/vivado" element={<Navigate to="/connectors/vivado" replace />} />

      <Route path="/monitor" element={<MonitorPage />} />

      <Route path="/knowledge/*" element={<KnowledgeShell />} />
      <Route path="/kb" element={<Navigate to="/knowledge/evolution" replace />} />
      <Route path="/evolution" element={<Navigate to="/knowledge/evolution" replace />} />

      <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </AppShell>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}
