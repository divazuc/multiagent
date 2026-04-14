import DiffView from './DiffView'
import TestRunner from './TestRunner'

export default function WorkflowOutput({ result, onRefine }) {
  const { workflow, summary, nodes_used = [], validation, diff } = result

  function handleDownload() {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(workflow.name || 'workflow').replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
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
        </div>
      </div>
    </div>
  )
}
