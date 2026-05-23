import { NavLink } from 'react-router-dom'
import { Bot, ChevronLeft, ChevronRight, CircuitBoard, Database, Gauge, Home, Settings, TerminalSquare } from 'lucide-react'
import { useShellStore } from '../../stores/shellStore'

const nav = [
  { label: 'Sessions', path: '/', icon: Home },
  { label: 'Terminal', path: '/term', icon: TerminalSquare },
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
        <div className="brand">
          <span className="brand-mark"><Bot size={15} /></span>
          <span className="brand-label">EdAgent</span>
        </div>
        <nav className="nav-items">
          {nav.map((item) => (
            <NavLink
              key={item.label}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              title={navCollapsed ? item.label : undefined}
            >
              <item.icon size={16} />
              <span className="nav-item-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="nav-footer">
          <div className="user-card">
            <span className="avatar">EA</span>
            <span className="nav-footer-label">Engineer</span>
          </div>
          <div className="nav-version">v0.3.0</div>
        </div>
        <button
          type="button"
          className="nav-collapse-btn"
          onClick={toggleNavCollapsed}
          aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={navCollapsed ? 'Expand' : 'Collapse'}
        >
          {navCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  )
}
