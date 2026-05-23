import { NavLink } from 'react-router-dom'
import { ChevronLeft, ChevronRight, CircuitBoard, Database, Gauge, Home, Settings } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { useShellStore } from '../../stores/shellStore'

const nav = [
  { label: 'Sessions', path: '/', icon: Home },
  { label: 'Monitor', path: '/monitor', icon: Gauge },
  { label: 'Vivado', path: '/vivado', icon: CircuitBoard },
  { label: 'Knowledge', path: '/knowledge', icon: Database },
  { label: 'Settings', path: '/settings', icon: Settings },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const navCollapsed = useShellStore((s) => s.navCollapsed)
  const toggleNavCollapsed = useShellStore((s) => s.toggleNavCollapsed)

  return (
    <div className={`app-shell ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <aside className="nav-rail" aria-label="Main navigation">
        <div className="nav-top">
          <div className="nav-header">
            <div className="brand">
              <BrandMark fill={navCollapsed} />
              <span className="brand-label">Synthia</span>
            </div>
          </div>
          <div className="nav-collapse-bar">
            <button
              type="button"
              className="nav-collapse-btn"
              onClick={toggleNavCollapsed}
              aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={navCollapsed ? 'Expand' : 'Collapse'}
            >
              {navCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
        </div>
        <nav className="nav-items">
          {nav.map((item) => (
            <NavLink
              key={item.label}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <item.icon size={16} />
              <span className="nav-item-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="nav-footer">
          <div className="user-card">
            <span className="avatar">SY</span>
            <span className="nav-footer-label">Engineer</span>
          </div>
          <div className="nav-version">v0.3.0</div>
        </div>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  )
}
