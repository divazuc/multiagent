import { useState } from 'react'
import { apiTestWorkflow, apiDeleteWorkflow, apiGetLastExecution } from '../hooks/useWorkflow'

export default function TestRunner({ workflow }) {
  const [testResult, setTestResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [execResult, setExecResult] = useState(null)
  const [execLoading, setExecLoading] = useState(false)

  async function handleTest() {
    setLoading(true)
    setTestResult(null)
    setExecResult(null)
    setDeleted(false)
    try {
      const result = await apiTestWorkflow(workflow)
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleCheckExecution() {
    if (!testResult?.importedId) return
    setExecLoading(true)
    try {
      const result = await apiGetLastExecution(testResult.importedId)
      setExecResult(result)
    } catch (err) {
      setExecResult({ found: false, message: err.message })
    } finally {
      setExecLoading(false)
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
        {loading ? 'Importing...' : 'Test in n8n'}
      </button>

      {testResult && !deleted && (
        <div className={`mt-3 rounded-lg p-4 text-sm border ${testResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className={`font-semibold mb-1 ${testResult.success ? 'text-green-700' : 'text-red-700'}`}>
            {testResult.success ? 'Imported successfully' : 'Import failed'}
          </div>
          {testResult.message && <div className="text-slate-600 text-xs mb-3">{testResult.message}</div>}
          {testResult.error && <div className="text-red-600 text-xs">{testResult.error}</div>}

          {testResult.success && (
            <div className="flex flex-wrap gap-2 mb-3">
              {testResult.workflowUrl && (
                <a
                  href={testResult.workflowUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-indigo-700"
                >
                  Open in n8n
                </a>
              )}
              <button
                onClick={handleCheckExecution}
                disabled={execLoading}
                className="text-xs bg-white border border-slate-300 px-3 py-1.5 rounded font-semibold text-slate-600 hover:border-indigo-400 hover:text-indigo-600 disabled:opacity-50"
              >
                {execLoading ? 'Checking...' : 'Check execution result'}
              </button>
            </div>
          )}

          {/* Execution result */}
          {execResult && (
            <div className={`rounded-lg px-3 py-2 text-xs mb-3 ${
              !execResult.found ? 'bg-slate-100 text-slate-500' :
              execResult.status === 'success' ? 'bg-green-100 text-green-700 border border-green-200' :
              'bg-red-100 text-red-700 border border-red-200'
            }`}>
              {!execResult.found ? (
                execResult.message
              ) : (
                <>
                  <div className="font-semibold mb-1">
                    {execResult.status === 'success' ? 'Last run: passed' : `Last run: ${execResult.status}`}
                  </div>
                  {execResult.startedAt && (
                    <div className="text-xs opacity-75">Started: {new Date(execResult.startedAt).toLocaleString()}</div>
                  )}
                  {execResult.error && (
                    <div className="mt-1 font-mono text-xs">{execResult.error}</div>
                  )}
                </>
              )}
            </div>
          )}

          {testResult.importedId && (
            <div className="flex gap-2 items-center">
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="text-xs bg-white border border-slate-200 px-3 py-1.5 rounded font-semibold text-slate-600 hover:border-red-300 hover:text-red-600"
              >
                {deleteLoading ? 'Deleting...' : 'Delete from n8n'}
              </button>
              <span className="text-xs text-slate-400">or keep it</span>
            </div>
          )}
        </div>
      )}

      {deleted && (
        <div className="mt-3 text-sm text-slate-500">Workflow deleted from n8n.</div>
      )}
    </div>
  )
}
