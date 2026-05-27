import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  BarChart3,
  Cpu,
  ChevronLeft,
  ChevronRight,
  CircuitBoard,
  Gauge,
  Home,
  ListTodo,
  Plug,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
} from 'lucide-react'
import { useShellStore } from '../../stores/shellStore'

const nav = [
  { key: 'nav.projects', path: '/', icon: Home },
  { key: 'nav.sessions', path: '/sessions', icon: ListTodo },
  { key: 'nav.runs', path: '/runs', icon: Gauge },
  { key: 'nav.reports', path: '/reports', icon: ScrollText },
  { key: 'nav.approvals', path: '/approvals', icon: Shield },
  { key: 'nav.benchmarks', path: '/benchmarks', icon: BarChart3 },
  { key: 'nav.hardware', path: '/hardware', icon: Cpu },
  { key: 'nav.monitor', path: '/monitor', icon: Gauge },
  { key: 'nav.connectors', path: '/connectors', icon: Plug },
  { key: 'nav.vivado', path: '/vivado', icon: CircuitBoard },
  { key: 'nav.evolution', path: '/evolution', icon: Sparkles },
  { key: 'nav.settings', path: '/settings', icon: Settings },
]

function routeLabel(pathname: string, t: (k: string) => string): string {
  if (pathname === '/' || pathname.startsWith('/projects')) return t('nav.projects')
  if (pathname.startsWith('/term')) return 'Terminal'
  if (pathname.startsWith('/sessions')) return t('nav.sessions')
  if (pathname.startsWith('/runs')) return t('nav.runs')
  if (pathname.startsWith('/reports')) return t('nav.reports')
  if (pathname.startsWith('/approvals')) return t('nav.approvals')
  if (pathname.startsWith('/benchmarks')) return t('nav.benchmarks')
  if (pathname.startsWith('/hardware')) return t('nav.hardware')
  if (pathname.startsWith('/monitor')) return t('nav.monitor')
  if (pathname.startsWith('/connectors')) return t('nav.connectors')
  if (pathname.startsWith('/settings')) return t('nav.settings')
  if (pathname.startsWith('/knowledge') || pathname.startsWith('/evolution')) return t('nav.evolution')
  return pathname
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const isTerminalRoute = location.pathname === '/term'
  const navCollapsed = useShellStore((s) => s.navCollapsed)
  const toggleNavCollapsed = useShellStore((s) => s.toggleNavCollapsed)

  return (
    <div
      className={[
        'app-shell',
        navCollapsed ? 'nav-collapsed' : '',
        isTerminalRoute ? 'shell-terminal' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="app-topbar">
        <div className="topbar-brand">Synthia</div>
        <div className="topbar-context">{routeLabel(location.pathname, t)}</div>
        <div className="topbar-status">
          <span className="muted" style={{ fontSize: 11 }}>
            ⌘K
          </span>
        </div>
      </header>

      <aside className="nav-rail" aria-label={t('nav.projects')}>
        <div className="nav-top">
          <div className="nav-header">
            <div className="brand">
              <span className="brand-label">{t('app.brand')}</span>
            </div>
          </div>
          <div className="nav-collapse-bar">
            <button
              type="button"
              className="nav-collapse-btn"
              onClick={toggleNavCollapsed}
              aria-label={navCollapsed ? t('projects.expand') : t('projects.collapse')}
              title={navCollapsed ? t('projects.expand') : t('projects.collapse')}
            >
              {navCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
        </div>
        <nav className="nav-items">
          {nav.map((item) => {
            const label = t(item.key)
            return (
              <NavLink
                key={item.key}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                title={label}
              >
                <item.icon size={16} />
                <span className="nav-item-label">{label}</span>
              </NavLink>
            )
          })}
        </nav>
        <div className="nav-footer">
          <div className="user-card">
            <span className="avatar">SY</span>
            <span className="nav-footer-label">{t('app.userRole')}</span>
          </div>
          <div className="nav-version">{t('app.version')}</div>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  )
}
