import { BrowserRouter } from 'react-router-dom'
import { Providers } from './providers'
import { AppRouter } from './router'
import '../styles/global.css'
import '../styles/sessions.css'
import '../styles/terminal.css'
import '../styles/monitor.css'
import '../styles/knowledge.css'
import '../styles/projects.css'
import '../styles/evolution.css'

export default function App() {
  return <Providers><BrowserRouter><AppRouter /></BrowserRouter></Providers>
}
