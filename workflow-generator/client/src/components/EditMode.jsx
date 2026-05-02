import { useState } from 'react'
import { apiEdit, apiListN8nWorkflows, apiGetN8nWorkflow } from '../hooks/useWorkflow'

export default function EditMode({ onResult, onError, loading, setLoading }) {
  const [source, setSource] = useState('upload')
  const [loadedWorkflow, setLoadedWorkflow] = useState(null)
  const [changeDescription, setChangeDescription] = useState('')
  const [workflowList, setWorkflowList] = useState(null)
  const [listLoading, setListLoading] = useState(false)

  function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        setLoadedWorkflow(JSON.parse(evt.target.result))
      } catch {
        onError('Could not parse the uploaded file as JSON. Make sure it is a valid n8n workflow export.')
      }
    }
    reader.readAsText(file)
  }

  async function handleLoadList() {
    setListLoading(true)
    try {
      const list = await apiListN8nWorkflows()
      setWorkflowList(list)
    } catch (err) {
      onError(`Could not reach n8n: ${err.message}`)
    } finally {
      setListLoading(false)
    }
  }

  async function handleSelectWorkflow(id) {
    setListLoading(true)
    try {
      const wf = await apiGetN8nWorkflow(id)
      setLoadedWorkflow(wf)
      setWorkflowList(null)
    } catch (err) {
      onError(err.message)
    } finally {
      setListLoading(false)
    }
  }

  async function handleApply() {
    if (!loadedWorkflow || !changeDescription.trim()) return
    setLoading(true)
    try {
      const result = await apiEdit(loadedWorkflow, changeDescription)
      onResult(result)
    } catch (err) {
      onError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Source selector */}
      <div className="flex gap-3 mb-5">
        {[{ id: 'upload', label: 'Upload .json file' }, { id: 'connect', label: 'Pick from n8n' }].map(opt => (
          <button
            key={opt.id}
            onClick={() => { setSource(opt.id); setLoadedWorkflow(null); setWorkflowList(null) }}
            className={`flex-1 border-2 rounded-xl p-4 text-left transition-colors ${
              source === opt.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className={`font-semibold text-sm ${source === opt.id ? 'text-indigo-700' : 'text-slate-700'}`}>{opt.label}</div>
          </button>
        ))}
      </div>

      {/* Upload source */}
      {source === 'upload' && !loadedWorkflow && (
        <label className="block border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 transition-colors mb-5">
          <div className="text-slate-500 text-sm">Drag & drop or <span className="text-indigo-600 font-semibold">browse</span></div>
          <input type="file" accept=".json" className="hidden" onChange={handleFileUpload} />
        </label>
      )}

      {/* Pick from n8n */}
      {source === 'connect' && !loadedWorkflow && (
        <div className="mb-5">
          {!workflowList ? (
            <button
              onClick={handleLoadList}
              disabled={listLoading}
              className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              {listLoading ? 'Loading...' : 'Load my n8n workflows'}
            </button>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200">
                Select a workflow
              </div>
              {workflowList.length === 0 && (
                <div className="px-4 py-3 text-sm text-slate-400">No workflows found in your n8n instance.</div>
              )}
              {workflowList.map(wf => (
                <button
                  key={wf.id}
                  onClick={() => handleSelectWorkflow(wf.id)}
                  disabled={listLoading}
                  className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 border-b last:border-b-0 border-slate-100 disabled:opacity-50"
                >
                  {wf.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loaded workflow badge */}
      {loadedWorkflow && (
        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-5">
          <span className="text-green-500 font-bold text-lg">+</span>
          <div>
            <div className="font-semibold text-sm text-slate-700">{loadedWorkflow.name || 'Unnamed workflow'}</div>
            <div className="text-xs text-slate-400">{(loadedWorkflow.nodes || []).length} nodes</div>
          </div>
          <button onClick={() => setLoadedWorkflow(null)} className="ml-auto text-xs text-indigo-600 font-semibold">Change</button>
        </div>
      )}

      {/* Change description */}
      {loadedWorkflow && (
        <>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            What do you want to change?
          </label>
          <textarea
            className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 transition-colors"
            rows={4}
            placeholder='e.g. "Add a Slack notification after the classifier step"'
            value={changeDescription}
            onChange={e => setChangeDescription(e.target.value)}
          />
          <button
            onClick={handleApply}
            disabled={loading || !changeDescription.trim()}
            className="mt-3 bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Applying...' : 'Apply changes'}
          </button>
        </>
      )}
    </div>
  )
}
