import { useState, useEffect, useCallback } from 'react'
import { listRuns, getRunSteps } from '../lib/supabase.js'

const STATUS_COLOR = { success: '#00a884', error: '#f87171', running: '#f59e0b' }
const STEP_COLOR   = { success: '#00a884', error: '#f87171' }

export default function RunsPanel({ activeSession }) {
  const [runs, setRuns]           = useState([])
  const [selected, setSelected]   = useState(null)
  const [loading, setLoading]     = useState(false)
  const [expandedStep, setExpanded] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listRuns(activeSession?.session_id ?? null)
      setRuns(data)
    } catch {
      // keep previous runs on transient failure
    } finally {
      setLoading(false)
    }
  }, [activeSession?.session_id])

  useEffect(() => { load() }, [load])

  async function loadSteps(run) {
    if (selected?.id === run.id) { setSelected(null); return }
    const steps = await getRunSteps(run.id).catch(() => [])
    setSelected({ ...run, steps })
    setExpanded(null)
  }

  return (
    <div className="panel panel-db" style={{ minWidth: 320 }}>
      <div className="panel-header">
        <span>Runs {activeSession ? `· ${activeSession.session_id}` : '(all)'}</span>
        <button className="icon-btn" onClick={load} title="Refresh" disabled={loading}>
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {runs.length === 0 && !loading && (
          <div style={{ padding: '20px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
            No runs yet. Send a message to see execution logs here.
          </div>
        )}

        {runs.map(run => (
          <div key={run.id}>
            {/* Run row */}
            <div
              onClick={() => loadSteps(run)}
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                background: selected?.id === run.id ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                  {run.session_id}
                </span>
                <span style={{ fontSize: 10, color: STATUS_COLOR[run.status] ?? 'var(--text-muted)', fontWeight: 600 }}>
                  {run.status}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                <span>{run.session_mode ?? '—'}</span>
                {run.total_duration_ms && <span>{run.total_duration_ms}ms</span>}
                <span style={{ marginLeft: 'auto' }}>{fmtTime(run.created_at)}</span>
              </div>
              {run.final_response && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {run.final_response}
                </div>
              )}
              {run.error && (
                <div style={{ fontSize: 11, color: '#f87171', marginTop: 3 }}>{run.error}</div>
              )}
            </div>

            {/* Steps detail */}
            {selected?.id === run.id && (
              <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                {(selected.steps ?? []).map((step, i) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--border-bright)' }}>
                    {/* Step header */}
                    <div
                      onClick={() => setExpanded(expandedStep === i ? null : i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 14px', cursor: 'pointer',
                        background: expandedStep === i ? 'var(--surface-2)' : 'transparent',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STEP_COLOR[step.status] ?? '#8696a0', flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 11, flex: 1 }}>{step.step}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{step.duration_ms}ms</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{expandedStep === i ? '▲' : '▼'}</span>
                    </div>

                    {/* Step payload */}
                    {expandedStep === i && (
                      <div style={{ padding: '0 14px 8px' }}>
                        {step.error && (
                          <div style={{ color: '#f87171', fontSize: 11, marginBottom: 6 }}>Error: {step.error}</div>
                        )}
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>OUTPUT</div>
                        <pre style={{
                          fontSize: 10, fontFamily: 'var(--font-mono)',
                          background: 'var(--bg)', borderRadius: 4, padding: 8,
                          overflowX: 'auto', color: 'var(--text-dim)',
                          maxHeight: 200, overflowY: 'auto',
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>
                          {JSON.stringify(step.output, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
