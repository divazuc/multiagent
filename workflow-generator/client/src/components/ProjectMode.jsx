import { useState } from 'react'
import { apiAnalyzeSpec, apiGenerateProject, apiImportProject } from '../hooks/useWorkflow'

const STEPS = ['spec', 'map', 'generate', 'import']

export default function ProjectMode() {
  const [step, setStep] = useState('spec')
  const [spec, setSpec] = useState('')
  const [slug, setSlug] = useState('')
  const [workflowMap, setWorkflowMap] = useState(null)
  const [generated, setGenerated] = useState(null)
  const [importResults, setImportResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function slugify(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  async function handleAnalyze() {
    if (!spec.trim() || !slug.trim()) return
    setLoading(true)
    setError(null)
    try {
      const map = await apiAnalyzeSpec(spec)
      setWorkflowMap(map)
      if (!slug && map.projectName) setSlug(slugify(map.projectName))
      setStep('map')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGenerateProject(slug, spec, workflowMap)
      setGenerated(data)
      setStep('generate')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    setLoading(true)
    setError(null)
    try {
      const workflows = generated.results.map(r => ({
        name: r.spec.name,
        role: r.spec.role,
        workflow: r.workflow
      }))
      const data = await apiImportProject(slug, workflows)
      setImportResults(data)
      setStep('import')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownload(workflow, name) {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleReset() {
    setStep('spec')
    setSpec('')
    setSlug('')
    setWorkflowMap(null)
    setGenerated(null)
    setImportResults(null)
    setError(null)
  }

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[
          { id: 'spec', label: '1. Spec' },
          { id: 'map', label: '2. Review map' },
          { id: 'generate', label: '3. Generate' },
          { id: 'import', label: '4. Import' }
        ].map((s, i) => {
          const idx = STEPS.indexOf(step)
          const done = STEPS.indexOf(s.id) < idx
          const active = s.id === step
          return (
            <div key={s.id} className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-1 rounded ${
                active ? 'bg-indigo-600 text-white' :
                done ? 'bg-green-100 text-green-700' :
                'bg-slate-100 text-slate-400'
              }`}>{s.label}</span>
              {i < 3 && <span className="text-slate-300">→</span>}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Step 1: Spec input */}
      {step === 'spec' && (
        <div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Project slug
            </label>
            <input
              className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              placeholder="e.g. customer-onboarding"
              value={slug}
              onChange={e => setSlug(slugify(e.target.value))}
            />
            <p className="text-xs text-slate-400 mt-1">Used for the project folder name. Lowercase, hyphens only.</p>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Project spec
            </label>
            <textarea
              className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 font-mono"
              rows={14}
              placeholder="Paste your project spec here..."
              value={spec}
              onChange={e => setSpec(e.target.value)}
            />
          </div>
          <button
            onClick={handleAnalyze}
            disabled={loading || !spec.trim() || !slug.trim()}
            className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Analyzing...' : 'Analyze spec →'}
          </button>
        </div>
      )}

      {/* Step 2: Review workflow map */}
      {step === 'map' && workflowMap && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Proposed workflow system</h3>
          <p className="text-xs text-slate-400 mb-4">Review before generating. Claude will build each workflow with awareness of the others.</p>

          {workflowMap.gaps?.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Gaps in your spec</div>
              <ul className="text-sm text-amber-700 space-y-1">
                {workflowMap.gaps.map((g, i) => <li key={i}>• {g}</li>)}
              </ul>
              <p className="text-xs text-amber-600 mt-2">You can continue anyway or go back and update your spec.</p>
            </div>
          )}

          <div className="space-y-3 mb-6">
            {workflowMap.workflows?.map((wf, i) => (
              <div key={i} className={`border rounded-xl p-4 ${wf.role === 'supervisor' ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${wf.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {wf.role}
                  </span>
                  <span className="font-semibold text-sm text-slate-800">{wf.name}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2">{wf.purpose}</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <div><span className="font-semibold">Trigger:</span> {wf.trigger}</div>
                  <div><span className="font-semibold">Inputs:</span> {wf.inputs}</div>
                  <div className="col-span-2"><span className="font-semibold">Outputs:</span> {wf.outputs}</div>
                  {wf.calls?.length > 0 && (
                    <div className="col-span-2"><span className="font-semibold">Calls:</span> {wf.calls.join(', ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? `Generating ${workflowMap.workflows?.length} workflows...` : `Generate ${workflowMap.workflows?.length} workflows →`}
            </button>
            <button onClick={() => setStep('spec')} className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300">
              Back
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Generated workflows */}
      {step === 'generate' && generated && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Generated workflows</h3>
          <p className="text-xs text-slate-400 mb-4">All workflows saved to <code className="bg-slate-100 px-1 rounded">projects/{slug}/workflows/</code></p>

          <div className="space-y-3 mb-6">
            {generated.results?.map((item, i) => (
              <div key={i} className="border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${item.spec.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {item.spec.role}
                    </span>
                    <span className="font-semibold text-sm text-slate-800">{item.spec.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${item.validation.valid ? 'text-green-600' : 'text-red-500'}`}>
                      {item.validation.valid ? 'Valid' : `${item.validation.errors.length} error(s)`}
                    </span>
                    <button
                      onClick={() => handleDownload(item.workflow, item.spec.name)}
                      className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200"
                    >
                      Download
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500">{item.summary}</p>
                {!item.validation.valid && (
                  <div className="mt-2 text-xs text-red-600 space-y-0.5">
                    {item.validation.errors.map((e, j) => <div key={j}>• {e}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleImport}
              disabled={loading}
              className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Importing to n8n...' : 'Import all to n8n →'}
            </button>
            <button onClick={() => generated.results?.forEach(r => handleDownload(r.workflow, r.spec.name))} className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300">
              Download all
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Import results */}
      {step === 'import' && importResults && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Import complete</h3>
          <p className="text-xs text-slate-400 mb-4">n8n IDs saved to <code className="bg-slate-100 px-1 rounded">projects/{slug}/manifest.json</code></p>

          <div className="space-y-3 mb-6">
            {importResults.results?.map((r, i) => (
              <div key={i} className={`border rounded-xl p-4 ${r.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${r.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {r.role}
                    </span>
                    <span className="font-semibold text-sm text-slate-800">{r.name}</span>
                  </div>
                  {r.success && r.workflowUrl && (
                    <a href={r.workflowUrl} target="_blank" rel="noreferrer"
                      className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-indigo-700">
                      Open in n8n
                    </a>
                  )}
                </div>
                {!r.success && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
                {r.success && r.n8nId && (
                  <div className="mt-1 text-xs text-slate-400">ID: {r.n8nId}</div>
                )}
              </div>
            ))}
          </div>

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 mb-4">
            <strong>Next step:</strong> Open each sub-workflow in n8n and copy its ID from the URL. Then open the supervisor workflow and update the Execute Sub-workflow nodes with the correct IDs.
          </div>

          <button onClick={handleReset} className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300">
            Start new project
          </button>
        </div>
      )}
    </div>
  )
}
