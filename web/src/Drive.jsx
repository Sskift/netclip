import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lang } from './lib/i18n.js'
import { formatBytes } from './lib/time.js'
import * as Icon from './components/Icons.jsx'
import './drive.css'

const tr = (zh, en) => lang === 'zh' ? zh : en
const listUrl = (id) => `/api/drive/entries${id ? `?parent=${id}` : ''}`
const downloadUrl = (entry) => `/api/drive/entries/${entry.id}/download`
const dateOf = (time) => new Date(time).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
const errorText = (error) => {
  if (/already exists/.test(error.message)) return tr('同一文件夹里已有这个名字，请换一个。', 'This name is already used in this folder.')
  if (/Failed to fetch|NetworkError/.test(error.message)) return tr('连接中断，请检查 Tailscale 连接后重试。', 'Connection lost. Check Tailscale and try again.')
  return error.message
}
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
  const data = await res.json()
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status })
  return data
}
function FileGlyph({ entry, large }) {
  const ext = entry.name.split('.').pop().toLowerCase()
  const type = entry.kind === 'folder' ? 'folder' : /^(png|jpe?g|webp|gif|heic)$/.test(ext) ? 'image' : /^(zip|rar|7z|tar|gz)$/.test(ext) ? 'archive' : /^(mp4|mov|mp3|wav)$/.test(ext) ? 'media' : 'document'
  return <span className={`nd-glyph nd-glyph--${type}${large ? ' nd-glyph--large' : ''}`}>
    {entry.kind === 'folder' ? <Icon.Folder /> : type === 'image' ? <Icon.Image /> : <Icon.File />}
  </span>
}

export default function Drive({ active = true, folderId, onNavigate }) {
  const currentFolder = useRef(folderId), currentActive = useRef(active)
  currentFolder.current = folderId; currentActive.current = active
  const [data, setData] = useState({ entries: [], breadcrumbs: [], stats: {}, maxUploadBytes: 512 * 1024 * 1024 })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [view, setView] = useState(() => localStorage.getItem('nc.drive.view') || 'list')
  const [sort, setSort] = useState('name')
  const [selected, setSelected] = useState(new Set())
  const [dialog, setDialog] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState([])
  const [connected, setConnected] = useState(false)
  const [moveFolder, setMoveFolder] = useState(null)
  const [moveData, setMoveData] = useState({ entries: [], breadcrumbs: [] })
  const input = useRef(null), requests = useRef(new Map()), generation = useRef(0), dragDepth = useRef(0)

  const navigate = useCallback((id) => {
    onNavigate(id); setQuery(''); setSelected(new Set()); setMenu(null)
  }, [onNavigate])
  const refresh = useCallback(async () => {
    const ticket = ++generation.current
    try {
      const next = await api(listUrl(folderId))
      if (ticket === generation.current) { setData(next); setLoading(false) }
    } catch (error) {
      if (ticket !== generation.current) return
      if (error.status === 404 && folderId && currentActive.current) { navigate(null); return }
      setNotice(errorText(error)); setLoading(false)
    }
  }, [folderId, navigate])
  useEffect(() => { if (active) { setLoading(true); refresh() } }, [active, refresh])
  useEffect(() => {
    if (!active) return
    const stream = new EventSource('/api/events')
    stream.addEventListener('drive', refresh)
    stream.onopen = () => { setConnected(true); refresh() }
    stream.onerror = () => setConnected(false)
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { stream.close(); document.removeEventListener('visibilitychange', visible) }
  }, [active, refresh])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6500)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!active) return
    const close = (e) => { if (!e.target.closest('.nd-menu, .nd-more')) setMenu(null) }
    const escape = (e) => { if (e.key === 'Escape') { setMenu(null); if (!busy) setDialog(null) } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [active, busy])
  useEffect(() => {
    if (dialog?.type !== 'move') return
    let active = true
    setMoveData({ entries: [], breadcrumbs: [] })
    api(listUrl(moveFolder)).then((v) => { if (active) setMoveData(v) }).catch((e) => { if (active) setFormError(errorText(e)) })
    return () => { active = false }
  }, [dialog, moveFolder])
  useEffect(() => {
    setSelected((old) => new Set([...old].filter((id) => data.entries.some((e) => e.id === id))))
  }, [data.entries])

  const entries = useMemo(() => data.entries.filter((e) => e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return sort === 'updated' ? b.updatedAt - a.updatedAt : sort === 'size' ? b.bytes - a.bytes : a.name.localeCompare(b.name, lang, { numeric: true })
  }), [data.entries, query, sort])
  const chosen = data.entries.filter((e) => selected.has(e.id))
  const current = data.breadcrumbs.at(-1)
  const toggle = (id) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next })
  const openDialog = (type, targets = []) => { setMenu(null); setFormError(''); setName(type === 'rename' ? targets[0].name : ''); setMoveFolder(null); setDialog({ type, targets }) }
  const showMenu = (e, entry) => {
    const box = e.currentTarget.getBoundingClientRect()
    setMenu({ entry, x: Math.max(8, Math.min(box.right - 188, innerWidth - 196)), y: box.bottom + 160 > innerHeight ? Math.max(8, box.top - 152) : box.bottom + 6 })
  }
  const patch = (entry, body) => api(`/api/drive/entries/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) })
  async function submit(event) {
    event?.preventDefault(); setBusy(true); setFormError('')
    try {
      if (dialog.type === 'create') await api('/api/drive/folders', { method: 'POST', body: JSON.stringify({ name, parentId: folderId }) })
      if (dialog.type === 'rename') await patch(dialog.targets[0], { name })
      if (dialog.type === 'move' || dialog.type === 'delete') {
        const results = await Promise.allSettled(dialog.targets.map((entry) => dialog.type === 'move'
          ? patch(entry, { parentId: moveFolder }) : api(`/api/drive/entries/${entry.id}`, { method: 'DELETE' })))
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length) throw failed[0].reason
      }
      setSelected(new Set()); setDialog(null)
      setNotice(tr('已完成', 'Done'))
    } catch (error) { setFormError(errorText(error)) }
    finally { setBusy(false); refresh() }
  }
  async function uploadFiles(fileList) {
    const destination = folderId
    const batch = [...fileList].map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, name: file.name, progress: 0, state: 'waiting' }))
    setUploads((old) => [...old.filter((u) => !['done', 'error', 'cancelled'].includes(u.state)), ...batch])
    const update = (id, next) => setUploads((old) => old.map((u) => u.id === id ? { ...u, ...next } : u))
    for (const job of batch) {
      if (job.file.size > data.maxUploadBytes) {
        update(job.id, { state: 'error', error: tr('文件超过上传上限', 'File exceeds the upload limit') }); continue
      }
      update(job.id, { state: 'uploading' })
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest(); requests.current.set(job.id, xhr)
          xhr.open('POST', `/api/drive/upload${destination ? `?parent=${destination}` : ''}`)
          xhr.setRequestHeader('Content-Type', 'application/octet-stream')
          xhr.setRequestHeader('X-Filename', encodeURIComponent(job.file.name))
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) update(job.id, { progress: Math.round(e.loaded / e.total * 100) }) }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve()
            else { let message; try { message = JSON.parse(xhr.responseText).error } catch {} reject(new Error(message || tr('上传失败，请重试', 'Upload failed. Try again.'))) }
          }
          xhr.onerror = () => reject(new Error(tr('网络中断，请重试', 'Connection lost. Try again.')))
          xhr.onabort = () => reject(Object.assign(new Error(tr('已取消', 'Cancelled')), { cancelled: true }))
          xhr.send(job.file)
        })
        update(job.id, { state: 'done', progress: 100 })
      } catch (error) { update(job.id, { state: error.cancelled ? 'cancelled' : 'error', error: errorText(error) }) }
      finally { requests.current.delete(job.id) }
    }
    if (currentActive.current && currentFolder.current === destination) refresh()
  }
  const crumbs = (items, go) => <nav className="nd-crumbs" aria-label={tr('文件夹路径', 'Folder path')}>
    <button type="button" onClick={() => go(null)}>{tr('全部文件', 'All files')}</button>
    {items.map((p) => <span key={p.id}><Icon.Chevron /><button type="button" onClick={() => go(p.id)} title={p.name}>{p.name}</button></span>)}
  </nav>
  const activeUploads = uploads.filter((u) => u.state === 'uploading' || u.state === 'waiting').length

  return <div className="nd-app" onDragEnter={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth.current++; setDragging(true) } }}
    onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault() }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
    onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files) }}>
    <aside className="nd-sidebar">
      <div className="nd-workspace"><span className="nd-avatar">N</span><div><strong>{tr('我的空间', 'My space')}</strong><small>{tr('随时存取，自由整理', 'Your files, across devices')}</small></div></div>
      <nav className="nd-nav">
        <button className="nd-nav-active" onClick={() => navigate(null)}><Icon.Folder />{tr('全部文件', 'All files')}<span>{data.stats.files || 0}</span></button>
      </nav>
      <div className="nd-storage"><Icon.Cloud /><strong>{formatBytes(data.stats.bytes || 0)}</strong><span>{tr('已使用空间', 'Stored in your drive')}</span><p>{tr('文件长期保存，不会自动过期。', 'Files stay here until you delete them.')}</p></div>
      <div className="nd-network"><i className={connected ? 'is-online' : ''} />{connected ? tr('设备间自动同步', 'Synced across devices') : tr('正在连接…', 'Connecting…')}</div>
    </aside>
    <main className="nd-main">
      <header className="nd-topbar">
        {crumbs(data.breadcrumbs, navigate)}
        <label className="nd-search"><Icon.Search /><input value={query} onChange={(e) => { setQuery(e.target.value); setSelected(new Set()) }} placeholder={tr('搜索当前文件夹', 'Search this folder')} aria-label={tr('搜索当前文件夹', 'Search this folder')} />{query && <button onClick={() => setQuery('')} aria-label={tr('清除搜索', 'Clear search')}><Icon.Close /></button>}</label>
      </header>
      <section className="nd-heading">
        <div><div className="nd-eyebrow">NETCLIP DRIVE</div><h1>{current?.name || tr('我的文件', 'My files')}</h1><p>{tr('让每份文件都有自己的位置。', 'A place for everything you want to keep.')}</p></div>
        <div className="nd-heading-actions"><button className="nd-button" onClick={() => openDialog('create')}><Icon.FolderPlus />{tr('新建文件夹', 'New folder')}</button><button className="nd-button nd-primary" onClick={() => input.current.click()}><Icon.Upload />{tr('上传文件', 'Upload files')}</button></div>
        <input ref={input} type="file" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} />
      </section>
      <div className="nd-toolbar">
        {selected.size ? <div className="nd-selection"><strong>{tr(`已选择 ${selected.size} 项`, `${selected.size} selected`)}</strong><button onClick={() => openDialog('move', chosen)}><Icon.Move />{tr('移动', 'Move')}</button><button onClick={() => openDialog('delete', chosen)}><Icon.Trash />{tr('删除', 'Delete')}</button><button className="nd-clear" onClick={() => setSelected(new Set())} aria-label={tr('取消选择', 'Clear selection')}><Icon.Close /></button></div>
          : <span className="nd-count">{tr(`${entries.length} 个项目`, `${entries.length} items`)}</span>}
        <div className="nd-view-tools"><select aria-label={tr('排序', 'Sort by')} value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">{tr('按名称', 'Name')}</option><option value="updated">{tr('最近修改', 'Last modified')}</option><option value="size">{tr('按大小', 'Size')}</option></select><div className="nd-view-toggle">{['list', 'grid'].map((v) => <button key={v} className={view === v ? 'is-active' : ''} aria-label={v === 'list' ? tr('列表视图', 'List view') : tr('网格视图', 'Grid view')} aria-pressed={view === v} onClick={() => { setView(v); localStorage.setItem('nc.drive.view', v) }}>{v === 'list' ? <Icon.List /> : <Icon.Grid />}</button>)}</div></div>
      </div>
      <div className="nd-content" aria-busy={loading}>
        {loading ? <div className="nd-empty"><span className="nc-spinner" /><p>{tr('正在打开文件夹…', 'Opening folder…')}</p></div> : !entries.length ? <div className="nd-empty"><div className="nd-empty-icon">{query ? <Icon.Search /> : <Icon.Folder />}</div><h2>{query ? tr('没有找到匹配的文件', 'No matching files') : tr('从这里开始整理文件', 'Make room for your files')}</h2><p>{query ? tr('试试其他文件名。', 'Try a different filename.') : tr('拖入文件，或创建你的第一个文件夹。', 'Drop files here, or create your first folder.')}</p>{!query && <button className="nd-button nd-primary" onClick={() => input.current.click()}><Icon.Upload />{tr('选择文件上传', 'Choose files')}</button>}</div>
          : view === 'list' ? <div className="nd-table" role="table" aria-label={tr('文件列表', 'Files')}>
            <div className="nd-row nd-table-head" role="row"><label><input type="checkbox" aria-label={tr('全选', 'Select all')} checked={entries.length > 0 && entries.every((e) => selected.has(e.id))} onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.id)) : new Set())} /></label><span>{tr('名称', 'Name')}</span><span className="nd-size">{tr('大小', 'Size')}</span><span className="nd-date">{tr('修改时间', 'Modified')}</span><span /></div>
            {entries.map((entry) => <div className={`nd-row${selected.has(entry.id) ? ' is-selected' : ''}`} key={entry.id} role="row">
              <label><input type="checkbox" aria-label={tr(`选择 ${entry.name}`, `Select ${entry.name}`)} checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} /></label>
              <div className="nd-file-name"><FileGlyph entry={entry} />{entry.kind === 'folder' ? <button title={entry.name} onClick={() => navigate(entry.id)}>{entry.name}</button> : <a title={entry.name} href={downloadUrl(entry)} download={entry.name}>{entry.name}</a>}</div>
              <span className="nd-size">{entry.kind === 'folder' ? '—' : formatBytes(entry.bytes)}</span><span className="nd-date">{dateOf(entry.updatedAt)}</span>
              <div className="nd-row-actions">{entry.kind === 'file' && <a href={downloadUrl(entry)} download={entry.name} aria-label={tr(`下载 ${entry.name}`, `Download ${entry.name}`)}><Icon.Download /></a>}<button className="nd-more" aria-label={tr(`更多操作 ${entry.name}`, `More actions ${entry.name}`)} onClick={(e) => showMenu(e, entry)}><Icon.More /></button></div>
            </div>)}
          </div> : <div className="nd-grid">{entries.map((entry) => <article key={entry.id} className={`nd-card${selected.has(entry.id) ? ' is-selected' : ''}`}>
            <div className="nd-card-top"><input type="checkbox" aria-label={tr(`选择 ${entry.name}`, `Select ${entry.name}`)} checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} /><button className="nd-more" aria-label={tr(`更多操作 ${entry.name}`, `More actions ${entry.name}`)} onClick={(e) => showMenu(e, entry)}><Icon.More /></button></div>
            {entry.kind === 'folder' ? <button className="nd-card-link" onClick={() => navigate(entry.id)}><FileGlyph entry={entry} large /><strong>{entry.name}</strong></button> : <a className="nd-card-link" href={downloadUrl(entry)} download={entry.name}><FileGlyph entry={entry} large /><strong>{entry.name}</strong></a>}
            <footer><span>{entry.kind === 'folder' ? tr('文件夹', 'Folder') : formatBytes(entry.bytes)}</span><span>{dateOf(entry.updatedAt)}</span></footer>
          </article>)}</div>}
      </div>
      <footer className="nd-bottom-note"><Icon.Cloud />{tr('存放在你的云盘中 · 长期保留', 'Stored in your drive · No automatic expiry')}<span>{tr(`单文件上限 ${formatBytes(data.maxUploadBytes)}`, `Up to ${formatBytes(data.maxUploadBytes)} per file`)}</span></footer>
    </main>
    {menu && <div className="nd-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      {menu.entry.kind === 'file' && <a role="menuitem" href={downloadUrl(menu.entry)} download={menu.entry.name} onClick={() => setMenu(null)}><Icon.Download />{tr('下载', 'Download')}</a>}
      <button role="menuitem" onClick={() => openDialog('rename', [menu.entry])}><Icon.Edit />{tr('重命名', 'Rename')}</button><button role="menuitem" onClick={() => openDialog('move', [menu.entry])}><Icon.Move />{tr('移动到…', 'Move to…')}</button><button role="menuitem" className="nd-danger-text" onClick={() => openDialog('delete', [menu.entry])}><Icon.Trash />{tr('删除', 'Delete')}</button>
    </div>}
    {dialog && <div className="nd-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) setDialog(null) }}><section className="nd-dialog" role="dialog" aria-modal="true" aria-labelledby="nd-dialog-title">
      <header><h2 id="nd-dialog-title">{dialog.type === 'create' ? tr('新建文件夹', 'New folder') : dialog.type === 'rename' ? tr('重命名', 'Rename') : dialog.type === 'move' ? tr('移动到文件夹', 'Move to folder') : tr('删除所选项目', 'Delete selected items')}</h2><button disabled={busy} onClick={() => setDialog(null)} aria-label={tr('关闭', 'Close')}><Icon.Close /></button></header>
      <form onSubmit={submit}>
        {(dialog.type === 'create' || dialog.type === 'rename') && <label className="nd-name-field"><span>{tr('名称', 'Name')}</span><input autoFocus required value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} placeholder={tr('输入名称', 'Enter a name')} /></label>}
        {dialog.type === 'delete' && <div className="nd-delete-description"><p>{tr(`确定删除 ${dialog.targets.length === 1 ? `“${dialog.targets[0].name}”` : `${dialog.targets.length} 个项目`}？`, `Delete ${dialog.targets.length === 1 ? `“${dialog.targets[0].name}”` : `${dialog.targets.length} items`}?`)}</p><small>{tr('文件夹中的内容也会一并删除，此操作无法撤销。', 'Folders and their contents will be permanently deleted.')}</small></div>}
        {dialog.type === 'move' && <div className="nd-move-picker">{crumbs(moveData.breadcrumbs, setMoveFolder)}<div>{moveData.entries.filter((e) => e.kind === 'folder' && !dialog.targets.some((target) => target.id === e.id)).map((entry) => <button type="button" key={entry.id} onClick={() => setMoveFolder(entry.id)}><Icon.Folder /><span>{entry.name}</span><Icon.Chevron /></button>)}{!moveData.entries.some((e) => e.kind === 'folder' && !dialog.targets.some((t) => t.id === e.id)) && <p>{tr('没有子文件夹，可直接移动到这里。', 'No subfolders. You can move items here.')}</p>}</div></div>}
        {formError && <p className="nd-form-error" role="alert">{formError}</p>}
        <footer><button className="nd-button" type="button" disabled={busy} onClick={() => setDialog(null)}>{tr('取消', 'Cancel')}</button><button className={`nd-button ${dialog.type === 'delete' ? 'nd-danger' : 'nd-primary'}`} disabled={busy || ((dialog.type === 'create' || dialog.type === 'rename') && !name.trim())} type="submit">{busy ? tr('处理中…', 'Working…') : dialog.type === 'move' ? tr('移动到这里', 'Move here') : dialog.type === 'delete' ? tr('删除', 'Delete') : tr('保存', 'Save')}</button></footer>
      </form>
    </section></div>}
    {!!uploads.length && <section className="nd-uploads" aria-label={tr('上传任务', 'Uploads')}><header><strong>{activeUploads ? tr(`正在上传 ${activeUploads} 个文件`, `Uploading ${activeUploads} files`) : tr('上传任务', 'Uploads')}</strong><button onClick={() => setUploads((old) => old.filter((u) => ['uploading', 'waiting'].includes(u.state)))} aria-label={tr('清除已完成任务', 'Clear completed uploads')}><Icon.Close /></button></header><div className="nd-upload-list">{uploads.map((u) => <div className="nd-upload" key={u.id}><Icon.File /><div><strong title={u.name}>{u.name}</strong><span>{u.state === 'done' ? tr('已保存', 'Saved') : u.state === 'waiting' ? tr('等待上传', 'Waiting') : u.state === 'uploading' ? (u.progress === 100 ? tr('正在保存…', 'Saving…') : `${u.progress}%`) : u.error}</span>{u.state === 'uploading' && <progress value={u.progress} max="100" />}</div>{u.state === 'uploading' && <button onClick={() => requests.current.get(u.id)?.abort()} aria-label={tr(`取消上传 ${u.name}`, `Cancel upload ${u.name}`)}><Icon.Close /></button>}</div>)}</div></section>}
    {dragging && <div className="nd-drop-overlay"><Icon.Upload /><h2>{tr('松手上传到当前文件夹', 'Drop files into this folder')}</h2><p>{current?.name || tr('全部文件', 'All files')}</p></div>}
    {notice && <div className="nd-toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label={tr('关闭', 'Close')}><Icon.Close /></button></div>}
  </div>
}
