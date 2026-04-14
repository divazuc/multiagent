import { useState } from 'react'
import { apiTestWorkflow, apiDeleteWorkflow } from '../hooks/useWorkflow'

export default function TestRunner({ workflow }) {
  const [show, setShow] = useState(false)
  const [n8nUrl, setN8nUrl] = useState('')
  const [n8nApiKey, setN8nApiKey] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleted, setDeleted] = useState(false)

  async function handleTest() {
    if (!n8nUrl || !n8nApiKey) return
    setLoading(true)
    setTestResult(null)
    try {
      const result = await apiTestWorkflow(n8nUrl, n8nApiKey, workflow)
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (!testResult?.importedId) return
    setDeleteLoading(true)
    try {
      await apiDeleteWorkflow(n8nUrl, n8nApiKey, testResult.importedId)
      setDeleted(true)
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    } finally {
      setDeleteLoading(false)
    }
  }

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 transition-colors"
      >
        Test in n8n
      </button>
    )
  }

  return (
    <div className="mt-4 border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 border-b border-slate-200">
        Safe test run — imports as inactive, no live webhooks fire
      </div>
      <div className="p-4 space-y-3">
        <input
          className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          placeholder="n8n URL (e.g. http://localhost:5678)"
          value={n8nUrl}
          onChange={e => setN8nUrl(e.target.value)}
        />
        <input
          type="password"
          className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          placeholder="n8n API key"
          value={n8nApiKey}
          onChange={e => setN8nApiKey(e.target.value)}
        />
        <button
          onClick={handleTest}
          disabled={loading || !n8nUrl || !n8nApiKey}
          className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          {loading ? 'Running test...' : 'Run test'}
        </button>

        {testResult && !deleted && (
          <div className={`rounded-lg p-4 text-sm ${testResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            <div className={`font-semibold mb-1 ${testResult.success ? 'text-green-700' : 'text-red-700'}`}>
              {testResult.success ? 'Test passed' : 'Test failed'}
            </div>
            {testResult.error && <div className="text-red-600 text-xs">{testResult.error}</div>}
            {testResult.importedId && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteLoading}
                  className="text-xs bg-white border border-slate-200 px-3 py-1.5 rounded font-semibold text-slate-600 hover:border-red-300 hover:text-red-600"
                >
                  {deleteLoading ? 'Deleting...' : 'Delete test import'}
                </button>
                <span className="text-xs text-slate-400 self-center">or keep it in n8n</span>
              </div>
            )}
          </div>
        )}

        {deleted && (
          <div className="text-sm text-slate-500">Test workflow deleted from n8n.</div>
        )}
      </div>
    </div>
  )
}
