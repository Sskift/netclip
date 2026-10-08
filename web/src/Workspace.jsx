import { useCallback, useEffect, useState } from 'react'
import App from './App.jsx'
import Drive from './Drive.jsx'
import * as Icon from './components/Icons.jsx'
import './workspace.css'

const readLocation = () => {
  const params = new URLSearchParams(location.search)
  const id = Number(params.get('folder'))
  return {
    view: location.pathname.startsWith('/drive') || params.get('view') === 'drive' ? 'drive' : 'clipboard',
    folder: Number.isSafeInteger(id) && id > 0 ? id : null,
  }
}
const viewUrl = (view, folder) => view === 'drive' ? `/?view=drive${folder ? `&folder=${folder}` : ''}` : '/'

export default function Workspace() {
  const [view, setView] = useState(() => readLocation().view)
  const [folderId, setFolderId] = useState(() => readLocation().folder)
  const [driveVisited, setDriveVisited] = useState(() => readLocation().view === 'drive')

  useEffect(() => {
    // Old bookmarks open the same workspace with Drive selected.
    if (location.pathname.startsWith('/drive')) history.replaceState({}, '', viewUrl('drive', readLocation().folder))
    const back = () => {
      const next = readLocation()
      setView(next.view)
      if (next.view === 'drive') { setFolderId(next.folder); setDriveVisited(true) }
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])

  const selectView = (next) => {
    if (next === view) return
    setView(next)
    if (next === 'drive') setDriveVisited(true)
    history.pushState({}, '', viewUrl(next, folderId))
  }
  const navigateFolder = useCallback((id) => {
    setFolderId(id)
    history.pushState({}, '', viewUrl('drive', id))
  }, [])

  return <div className="nw-workspace">
    <header className="nw-header nc-chrome">
      <div className="nw-brand"><img src="/icon.svg" alt="" /><strong>netclip</strong></div>
      <div className="nw-tabs" role="tablist" aria-label="Workspace">
        {['clipboard', 'drive'].map((tab) => <button key={tab} id={`tab-${tab}`} role="tab"
          aria-selected={view === tab} aria-controls={`panel-${tab}`} tabIndex={view === tab ? 0 : -1}
          onClick={() => selectView(tab)} onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault(); e.stopPropagation()
              const next = e.key === 'Home' ? 'clipboard' : e.key === 'End' ? 'drive' : tab === 'clipboard' ? 'drive' : 'clipboard'
              selectView(next); document.getElementById(`tab-${next}`)?.focus()
            }
          }}>
          {tab === 'clipboard' ? <Icon.Copy /> : <Icon.Cloud />}{tab === 'clipboard' ? 'Clipboard' : 'Drive'}
        </button>)}
      </div>
      <span className="nw-tagline">Your shared space</span>
    </header>
    <section id="panel-clipboard" className="nw-panel" role="tabpanel" aria-labelledby="tab-clipboard" hidden={view !== 'clipboard'}>
      <App active={view === 'clipboard'} onOpenDrive={() => selectView('drive')} />
    </section>
    <section id="panel-drive" className="nw-panel" role="tabpanel" aria-labelledby="tab-drive" hidden={view !== 'drive'}>
      {driveVisited && <Drive active={view === 'drive'} folderId={folderId} onNavigate={navigateFolder} />}
    </section>
  </div>
}
