import { NavLink } from 'react-router-dom'
import { Bot, CircuitBoard, Database, Gauge, Home, Settings, TerminalSquare } from 'lucide-react'

const nav = [
  { label: 'Sessions', path: '/', icon: Home },
  { label: 'Terminal', path: '/term', icon: TerminalSquare },
  { label: 'Monitor', path: '/monitor', icon: Gauge },
  { label: 'Vivado', path: '/vivado', icon: CircuitBoard },
  { label: 'Knowledge', path: '/knowledge', icon: Database },
  { label: 'Settings', path: '/settings', icon: Settings },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell">
    <aside className="nav-rail">
      <div className="brand"><span className="brand-mark"><Bot size={16} /></span><span>EdAgent‑Vivado</span></div>
      <nav className="nav-items">
        {nav.map((item) => <NavLink key={item.label} to={item.path} end={item.path === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <item.icon size={16} /> <span>{item.label}</span>
        </NavLink>)}
      </nav>
      <div className="nav-footer">
        <div className="user-card"><span className="avatar">EA</span><span>engineer</span></div>
        <div>v0.3.0</div>
      </div>
    </aside>
    <main className="app-main">{children}</main>
  </div>
}
