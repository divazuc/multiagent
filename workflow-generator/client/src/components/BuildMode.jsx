import { useState } from 'react'
import { apiGenerate } from '../hooks/useWorkflow'

export default function BuildMode({ onResult, onError, loading, setLoading }) {
  const [description, setDescription] = useState('')

  async function handleGenerate() {
    if (!description.trim()) return
    setLoading(true)
    try {
      const result = await apiGenerate(description)
      onResult(result)
    } catch (err) {
      onError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
        Describe your workflow
      </label>
      <textarea
        className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 transition-colors"
        rows={5}
        placeholder='e.g. "When someone submits a form on my site, send me a Slack message and add a row to my Google Sheet"'
        value={description}
        onChange={e => setDescription(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
      />
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={handleGenerate}
          disabled={loading || !description.trim()}
          className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Generating...' : 'Generate workflow'}
        </button>
        <span className="text-xs text-slate-400">Cmd + Enter to generate</span>
      </div>
    </div>
  )
}
