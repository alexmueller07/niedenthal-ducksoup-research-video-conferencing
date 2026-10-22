import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen,
  RefreshCw,
  Search,
  FileText,
  Download,
  ExternalLink,
  Database,
} from 'lucide-react'
import { parse } from 'csv-parse/browser/esm/sync'
import { PageHeading } from '../components/SuiteShell'
import { useSessionArchive } from '../components/SessionArchiveProvider'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'
import {
  DATA_CATEGORIES,
  catalogFromFiles,
  downloadBlob,
  formatBytes,
} from '../lib/sessionData'
import type { SessionCatalog, SessionDataFile } from '../../shared/sessionData'

type Preview = {
  file: SessionDataFile
  text?: string
  originalText?: string
  rows?: string[][]
  url?: string
}

export default function SessionDataPage() {
  const [native, setNative] = useState(false)
  const {
    catalog,
    setCatalog,
    sessionId,
    setSessionId,
    category,
    setCategory,
    query,
    setQuery,
    filesRef,
  } = useSessionArchive()
  const [rowQuery, setRowQuery] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingFile, setLoadingFile] = useState('')
  const folderRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const session = catalog?.sessions.find((s) => s.id === sessionId)
  const files = session?.files || []
  const visible = files.filter(
    (f) =>
      f.category === category &&
      f.relativePath.toLowerCase().includes(query.toLowerCase()),
  )

  function loadCatalog(next: SessionCatalog) {
    request.current++
    setCatalog(next)
    setSessionId(next.sessions[0]?.id || '')
    setPreview(null)
    setLoadingFile('')
    setError('')
  }
  async function refresh(choose = false) {
    setBusy(true)
    setError('')
    try {
      const next = await ipcInvoke<SessionCatalog>(
        choose ? 'suite:choose-data' : 'suite:catalog',
      )
      if (next) {
        filesRef.current.clear()
        loadCatalog(next)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    setNative(hasIpc())
    if (hasIpc() && !catalog) void refresh()
  }, [])
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url)
    },
    [preview],
  )
  useEffect(
    () => () => {
      request.current++
    },
    [],
  )

  function importFolder(selected: FileList | null) {
    if (!selected) return
    const imported = catalogFromFiles(
      Array.from(selected).filter((f) =>
        /\.(csv|json|txt|mp4|webm|m4a|wav|mp3|ogg|png|jpe?g)$/i.test(f.name),
      ),
    )
    filesRef.current = imported.fileMap
    loadCatalog(imported.catalog)
  }
  function changeSession(id: string) {
    request.current++
    setSessionId(id)
    setPreview(null)
    setError('')
    setLoadingFile('')
    setRowQuery('')
  }
  async function inspect(file: SessionDataFile) {
    const token = ++request.current
    setError('')
    setLoadingFile(file.relativePath)
    setRowQuery('')
    setPreview(null)
    try {
      const local = filesRef.current.get(`${sessionId}/${file.relativePath}`)
      if (!/\.(csv|json|txt)$/i.test(file.relativePath)) {
        if (local) setPreview({ file, url: URL.createObjectURL(local) })
        else await ipcInvoke('suite:open-file', sessionId, file.relativePath)
        return
      }
      if (file.size > 5 * 1024 * 1024)
        throw new Error(
          'File exceeds the 5 MB preview limit. Open it externally for full analysis.',
        )
      const text = local
        ? await local.text()
        : await ipcInvoke<string>(
            'suite:read-text',
            sessionId,
            file.relativePath,
          )
      if (token !== request.current) return
      if (text == null)
        throw new Error('File is unavailable. Open the session folder again.')
      const rows = /\.csv$/i.test(file.relativePath)
        ? (parse(text, {
            bom: true,
            skip_empty_lines: true,
            relax_column_count: true,
            to: 201,
          }) as string[][])
        : undefined
      const display = /\.json$/i.test(file.relativePath)
        ? JSON.stringify(JSON.parse(text), null, 2)
        : text
      setPreview({ file, text: display, originalText: text, rows })
    } catch (e) {
      if (token === request.current) setError(String(e))
    } finally {
      if (token === request.current) setLoadingFile('')
    }
  }
  const rows = useMemo(
    () =>
      preview?.rows
        ?.slice(1)
        .filter((r) =>
          r.join(' ').toLowerCase().includes(rowQuery.toLowerCase()),
        ) || [],
    [preview, rowQuery],
  )
  const numeric = useMemo(() => {
    if (!preview?.rows?.length) return []
    return preview.rows[0]
      .map((name, i) => {
        const values = rows
          .map((r) => r[i])
          .filter((v) => v?.trim() && Number.isFinite(Number(v)))
          .map(Number)
        return { name, values }
      })
      .filter((c) => c.values.length > 1 && c.values.length === rows.length)
      .slice(0, 4)
  }, [preview, rows])

  return (
    <main className="suite-content">
      <PageHeading
        title="Session Data"
        eyebrow="Session archive"
        action={
          <div className="suite-row">
            {native && (
              <button
                className="suite-btn icon"
                title="Refresh sessions"
                aria-label="Refresh sessions"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={17} />
              </button>
            )}
            <button
              className="suite-btn primary"
              disabled={busy}
              onClick={() =>
                native ? void refresh(true) : folderRef.current?.click()
              }
            >
              <FolderOpen size={16} />
              {busy ? 'Reading folder...' : 'Open folder'}
            </button>
          </div>
        }
      >
        <p>Recordings and study outputs, grouped by session.</p>
      </PageHeading>
      <input
        ref={folderRef}
        type="file"
        hidden
        multiple
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          importFolder(e.target.files)
          e.target.value = ''
        }}
        aria-label="Open session folder"
      />
      {error && (
        <p role="alert" className="suite-notice suite-error">
          {error}
        </p>
      )}
      {catalog?.warnings.map((w) => (
        <p className="suite-notice" key={w}>
          {w}
        </p>
      ))}
      {catalog?.root && (
        <p
          className="suite-muted"
          style={{ fontSize: 12, marginBottom: 24, overflowWrap: 'anywhere' }}
        >
          <FolderOpen size={14} className="inline mr-2" />
          {catalog.root}{' '}
          <span className="suite-badge" style={{ marginLeft: 12 }}>
            {catalog.sessions.length} sessions
          </span>
        </p>
      )}
      {!catalog?.sessions.length ? (
        <div className="suite-empty">
          <Database size={34} />
          <h2>No sessions loaded</h2>
          <p>
            Open a saved session folder or a folder containing multiple
            sessions.
          </p>
        </div>
      ) : (
        <div className="suite-data-layout">
          <aside aria-label="Saved sessions" className="suite-session-list">
            {catalog.sessions.map((s) => (
              <button
                key={s.id}
                aria-pressed={s.id === sessionId}
                onClick={() => changeSession(s.id)}
              >
                {s.id === '.' ? catalog.root.split(/[\\/]/).pop() : s.id}
                <small>
                  {s.files.length} files ·{' '}
                  {formatBytes(s.files.reduce((n, f) => n + f.size, 0))}
                </small>
              </button>
            ))}
          </aside>
          <section style={{ minWidth: 0 }}>
            <div
              className="suite-tabs"
              role="tablist"
              aria-label="Data categories"
            >
              {DATA_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={category === c.id}
                  onClick={() => {
                    setCategory(c.id)
                    setPreview(null)
                    request.current++
                    setLoadingFile('')
                  }}
                >
                  {c.label}{' '}
                  <span style={{ opacity: 0.65 }}>
                    {' '}
                    {files.filter((f) => f.category === c.id).length}
                  </span>
                </button>
              ))}
            </div>
            <label className="suite-row" style={{ marginBottom: 18 }}>
              <Search size={16} />
              <input
                className="suite-input"
                style={{ flex: 1 }}
                placeholder="Find a file..."
                aria-label="Find a file"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="suite-table-wrap">
              <table className="suite-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Modified</th>
                    {native && <th>Open</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => (
                    <tr key={f.relativePath}>
                      <td>
                        <button onClick={() => void inspect(f)}>
                          <FileText size={14} className="inline mr-2" />
                          {f.relativePath}
                        </button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {formatBytes(f.size)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {new Date(f.modifiedAt).toLocaleString()}
                      </td>
                      {native && (
                        <td>
                          <button
                            title={`Open ${f.relativePath} externally`}
                            aria-label={`Open ${f.relativePath} externally`}
                            onClick={() =>
                              void ipcInvoke(
                                'suite:open-file',
                                sessionId,
                                f.relativePath,
                              ).catch((e) => setError(String(e)))
                            }
                          >
                            <ExternalLink size={16} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visible.length && (
              <p className="suite-muted" style={{ padding: 24 }}>
                No{' '}
                {DATA_CATEGORIES.find(
                  (c) => c.id === category,
                )?.label.toLowerCase()}{' '}
                files in this session.
              </p>
            )}
            {loadingFile && (
              <p className="suite-muted" role="status">
                Opening {loadingFile}...
              </p>
            )}
            {preview && (
              <div className="suite-preview">
                <div
                  className="suite-row"
                  style={{ justifyContent: 'space-between', marginBottom: 16 }}
                >
                  <h2 style={{ overflowWrap: 'anywhere' }}>
                    {preview.file.relativePath}
                  </h2>
                  {preview.text !== undefined && (
                    <button
                      className="suite-btn"
                      onClick={() =>
                        downloadBlob(
                          filesRef.current.get(
                            `${sessionId}/${preview.file.relativePath}`,
                          ) ||
                            new Blob([preview.originalText || ''], {
                              type: 'text/plain',
                            }),
                          preview.file.relativePath.split('/').pop() ||
                            'export.txt',
                        )
                      }
                    >
                      <Download size={15} />
                      Export file
                    </button>
                  )}
                </div>
                {preview.rows ? (
                  <>
                    <div className="suite-row" style={{ marginBottom: 15 }}>
                      <input
                        className="suite-input"
                        placeholder="Filter preview rows..."
                        aria-label="Filter preview rows"
                        value={rowQuery}
                        onChange={(e) => setRowQuery(e.target.value)}
                      />
                      <span className="suite-muted" style={{ fontSize: 11 }}>
                        {rows.length} matching rows · preview limited to the
                        first 200
                      </span>
                    </div>
                    {numeric.length > 0 && (
                      <div className="suite-row" style={{ marginBottom: 16 }}>
                        {numeric.map((c) => (
                          <span className="suite-badge" key={c.name}>
                            {c.name}: {Math.min(...c.values).toFixed(2)} to{' '}
                            {Math.max(...c.values).toFixed(2)}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      className="suite-table-wrap"
                      style={{ maxHeight: 420 }}
                    >
                      <table className="suite-table">
                        <thead>
                          <tr>
                            {preview.rows[0]?.map((h, i) => (
                              <th key={i}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((v, j) => (
                                <td
                                  key={j}
                                  style={{
                                    minWidth: 100,
                                    maxWidth: 350,
                                    overflowWrap: 'anywhere',
                                  }}
                                >
                                  {v.length > 400 ? `${v.slice(0, 400)}...` : v}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : preview.text !== undefined ? (
                  <pre>{preview.text}</pre>
                ) : /\.(mp4|webm)$/i.test(preview.file.relativePath) ? (
                  <video controls src={preview.url} />
                ) : /\.(png|jpe?g)$/i.test(preview.file.relativePath) ? (
                  <img
                    src={preview.url}
                    alt={preview.file.relativePath}
                    style={{ maxWidth: '100%', maxHeight: 450 }}
                  />
                ) : (
                  <audio controls src={preview.url} />
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  )
}
