import { useState } from 'react'
import DiffView from './DiffView'
import TestRunner from './TestRunner'
import { apiListProjects, apiSaveProjectWorkflow } from '../hooks/useWorkflow'

export default function WorkflowOutput({ result, onRefine }) {
  const { workflow, summary, nodes_used = [], validation, diff } = result

  const [saveState, setSaveState] = useState('idle') // idle | selecting | saving | saved | error
  const [projects, setProjects] = useState(null)
  const [saveSlug, setSaveSlug] = useState('')
  const [saveName, setSaveName] = useState(workflow.name || '')
  const [saveRole, setSaveRole] = useState('sub')
  const [saveError, setSaveError] = useState(null)

  function handleDownload() {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(workflow.name || 'workflow').replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleOpenSave() {
    setSaveState('selecting')
    setSaveError(null)
    if (!projects) {
      try {
        const list = await apiListProjects()
        setProjects(list)
        if (list.length > 0) setSaveSlug(list[0].slug)
      } catch (err) {
        setSaveError(`Could not load projects: ${err.message}`)
        setSaveState('error')
      }
    }
  }

  async function handleSave() {
    if (!saveSlug || !saveName.trim()) return
    setSaveState('saving')
    setSaveError(null)
    try {
      await apiSaveProjectWorkflow(saveSlug, saveName.trim(), saveRole, workflow)
      setSaveState('saved')
    } catch (err) {
      setSaveError(err.message)
      setSaveState('error')
    }
  }

  return (
    <div className="mt-6 border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-5 py-3 border-b border-slate-200 flex items-center gap-2">
        <span className="text-green-500 font-bold">+</span>
        <span className="text-sm font-semibold text-slate-700">
          {diff ? 'Changes applied & validated' : 'Workflow generated & validated'}
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 leading-relaxed">
          <span className="font-semibold">What this does: </span>{summary}
        </div>

        <div className="flex gap-2 flex-wrap">
          <span className="bg-green-100 text-green-700 text-xs font-semibold px-3 py-1 rounded-full">Schema valid</span>
          <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full">
            {(workflow.nodes || []).length} nodes
          </span>
          {nodes_used.length > 0 && (
            <span className="bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1 rounded-full">
              {nodes_used.join(', ')}
            </span>
          )}
        </div>

        {diff && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">What changed</div>
            <DiffView diff={diff} />
          </div>
        )}

        <div className="flex gap-3 flex-wrap">
          <button
            onClick={handleDownload}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            Download .json
          </button>
          <TestRunner workflow={workflow} />
          <button
            onClick={onRefine}
            className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 transition-colors"
          >
            Refine
          </button>
          {saveState === 'idle' && (
            <button
              onClick={handleOpenSave}
              className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 transition-colors"
            >
              Save to project
            </button>
          )}
          {saveState === 'saved' && (
            <span className="text-sm font-semibold text-green-600 self-center">Saved to project</span>
          )}
        </div>

        {(saveState === 'selecting' || saveState === 'saving' || saveState === 'error') && (
          <div className="border border-slate-200 rounded-lg p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Save to project</div>

            {projects && projects.length === 0 && (
              <p className="text-sm text-slate-400">No projects found. Create a project in the Project tab first.</p>
            )}

            {projects && projects.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Project</label>
                    <select
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                      value={saveSlug}
                      onChange={e => setSaveSlug(e.target.value)}
                    >
                      {projects.map(p => (
                        <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Role</label>
                    <select
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                      value={saveRole}
                      onChange={e => setSaveRole(e.target.value)}
                    >
                      <option value="sub">Sub</option>
                      <option value="supervisor">Supervisor</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Workflow name</label>
                  <input
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                    value={saveName}
                    onChange={e => setSaveName(e.target.value)}
                  />
                </div>
                {saveError && (
                  <div className="text-xs text-red-600">{saveError}</div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saveState === 'saving' || !saveSlug || !saveName.trim()}
                    className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saveState === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setSaveState('idle'); setSaveError(null) }}
                    className="bg-white text-slate-600 border border-slate-200 px-5 py-2 rounded-lg text-sm font-semibold hover:border-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
