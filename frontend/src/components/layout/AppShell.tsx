import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  CircuitBoard,
  Gauge,
  Home,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useShellStore } from '../../stores/shellStore'

const nav = [
  { key: 'nav.projects', path: '/', icon: Home },
  { key: 'nav.monitor', path: '/monitor', icon: Gauge },
  { key: 'nav.vivado', path: '/vivado', icon: CircuitBoard },
  { key: 'nav.evolution', path: '/evolution', icon: Sparkles },
  { key: 'nav.settings', path: '/settings', icon: Settings },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const isTerminalRoute = location.pathname === '/term'
  const navCollapsed = useShellStore((s) => s.navCollapsed)
  const toggleNavCollapsed = useShellStore((s) => s.toggleNavCollapsed)

  return (
    <div className={`app-shell ${navCollapsed ? 'nav-collapsed' : ''}${isTerminalRoute ? ' shell-terminal' : ''}`}>
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
