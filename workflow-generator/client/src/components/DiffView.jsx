export default function DiffView({ diff }) {
  if (!diff) return null
  const { added = [], removed = [], connectionsAdded = [], connectionsRemoved = [] } = diff
  const hasChanges = added.length || removed.length || connectionsAdded.length || connectionsRemoved.length

  if (!hasChanges) return (
    <div className="text-sm text-slate-500 italic">No structural changes detected.</div>
  )

  return (
    <div className="font-mono text-xs space-y-1">
      {added.map(n => <div key={n} className="text-green-700">+ Added node: {n}</div>)}
      {removed.map(n => <div key={n} className="text-red-600">- Removed node: {n}</div>)}
      {connectionsAdded.map(c => <div key={c} className="text-green-700">+ Added connection: {c}</div>)}
      {connectionsRemoved.map(c => <div key={c} className="text-red-600">- Removed connection: {c}</div>)}
    </div>
  )
}
