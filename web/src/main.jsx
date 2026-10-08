import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import Drive from './Drive.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {location.pathname === '/drive' || location.pathname.startsWith('/drive/') ? <Drive /> : <App />}
  </StrictMode>,
)
