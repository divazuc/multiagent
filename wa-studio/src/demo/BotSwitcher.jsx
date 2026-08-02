import { botById } from './bots.js'

export default function BotSwitcher({ bots, active, onSelect }) {
  if (!bots?.length) return null
  const activeBot = botById(bots, active)
  return (
    <div className="bs-bar" role="tablist" aria-label="בחירת בוט">
      <button
        role="tab" aria-selected={!active}
        className={`bs-card ${!active ? 'on' : ''}`}
        onClick={() => onSelect(null)}
      >
        <span className="bs-icon">🏠</span>
        <span className="bs-name">מרכז</span>
        <span className="bs-panel">כל הבוטים יחד</span>
      </button>
      {bots.map(b => (
        <button
          key={b.id} role="tab" aria-selected={active === b.id}
          className={`bs-card ${active === b.id ? 'on' : ''}`}
          style={{ '--bot-color': b.color }}
          onClick={() => onSelect(b.id)}
        >
          <span className="bs-icon">{b.icon}</span>
          <span className="bs-name">{b.name}</span>
          <span className="bs-panel">
            <i className="bs-dot" aria-hidden="true" /> {b.panel}
          </span>
        </button>
      ))}
      {activeBot && (
        <div className="bs-active-note">
          מציג את הזון של <b>{activeBot.name}</b> בלבד
        </div>
      )}
    </div>
  )
}
