import { useState } from 'react'
import { apiTestWorkflow, apiDeleteWorkflow } from '../hooks/useWorkflow'

export default function TestRunner({ workflow }) {
  const [testResult, setTestResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleted, setDeleted] = useState(false)

  async function handleTest() {
    setLoading(true)
    setTestResult(null)
    try {
      const result = await apiTestWorkflow(workflow)
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
      await apiDeleteWorkflow(testResult.importedId)
      setDeleted(true)
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    } finally {
      setDeleteLoading(false)
    }
  }

  return (
    <div className="inline-flex flex-col">
      <button
        onClick={handleTest}
        disabled={loading}
        className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Testing...' : 'Test in n8n'}
      </button>

      {testResult && !deleted && (
        <div className={`mt-3 rounded-lg p-4 text-sm border ${testResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className={`font-semibold mb-1 ${testResult.success ? 'text-green-700' : 'text-red-700'}`}>
            {testResult.success ? 'Test passed' : 'Test failed'}
          </div>
          {testResult.error && <div className="text-red-600 text-xs">{testResult.error}</div>}
          {testResult.message && <div className="text-slate-600 text-xs">{testResult.message}</div>}
          {testResult.importedId && (
            <div className="mt-3 flex gap-2 items-center">
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="text-xs bg-white border border-slate-200 px-3 py-1.5 rounded font-semibold text-slate-600 hover:border-red-300 hover:text-red-600"
              >
                {deleteLoading ? 'Deleting...' : 'Delete test import'}
              </button>
              <span className="text-xs text-slate-400">or keep it in n8n</span>
            </div>
          )}
        </div>
      )}

      {deleted && (
        <div className="mt-3 text-sm text-slate-500">Test workflow deleted from n8n.</div>
      )}
    </div>
  )
}
