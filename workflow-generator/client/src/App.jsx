import { useState } from 'react'
import ModeTab from './components/ModeTab'
import BuildMode from './components/BuildMode'
import EditMode from './components/EditMode'
import WorkflowOutput from './components/WorkflowOutput'

export default function App() {
  const [mode, setMode] = useState('build')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function handleResult(res) {
    setResult(res)
    setError(null)
  }

  function handleError(err) {
    setError(err)
    setResult(null)
  }

  function handleRefine() {
    setResult(null)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <h1 className="text-xl font-bold text-slate-800">n8n Workflow Generator</h1>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <ModeTab mode={mode} onChange={m => { setMode(m); setResult(null); setError(null) }} />

          <div className="p-6">
            {mode === 'build' ? (
              <BuildMode
                onResult={handleResult}
                onError={handleError}
                loading={loading}
                setLoading={setLoading}
              />
            ) : (
              <EditMode
                onResult={handleResult}
                onError={handleError}
                loading={loading}
                setLoading={setLoading}
              />
            )}

            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </div>
            )}

            {result && (
              <WorkflowOutput result={result} onRefine={handleRefine} />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
