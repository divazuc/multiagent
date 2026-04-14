export default function ModeTab({ mode, onChange }) {
  const tabs = [
    { id: 'build', label: 'Build new workflow' },
    { id: 'edit', label: 'Edit existing workflow' }
  ]
  return (
    <div className="flex border-b border-slate-200 bg-slate-50">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-7 py-4 text-sm font-semibold transition-colors ${
            mode === tab.id
              ? 'text-indigo-600 border-b-2 border-indigo-600 -mb-px bg-white'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
