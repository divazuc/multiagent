import { useState, useEffect } from 'react'
import { botById } from './bots.js'

export default function InterviewCard({ api, bots = null, bot = null, showToast, onSuggested }) {
  const [questions, setQuestions] = useState(null)
  const [drafts, setDrafts] = useState({})      // id -> text
  const [busy, setBusy] = useState({})          // id -> true while sending
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(false)

  useEffect(() => {
    api.getInterviewQuestions?.().then(r => setQuestions(r.questions ?? [])).catch(() => setQuestions([]))
  }, [api])

  if (!questions) return null
  const visible = questions.filter(q => !bot || q.bot === bot || q.bot == null).slice(0, 3)

  async function send(q) {
    const text = (drafts[q.id] ?? '').trim()
    if (!text) return
    setBusy(b => ({ ...b, [q.id]: true }))
    try {
      const { item } = await api.answerInterviewQuestion(q.id, text)
      setQuestions(prev => prev.filter(x => x.id !== q.id))
      onSuggested?.(item)
      showToast('נוסח מלוטש נוסף להצעות למטה — אישור אחד והוא במאגר ✓')
    } catch {
      showToast('הליטוש נכשל — התשובה שלך נשמרה, נסו שוב עוד רגע')
    } finally {
      setBusy(b => ({ ...b, [q.id]: false }))
    }
  }

  async function skip(q) {
    setQuestions(prev => prev.filter(x => x.id !== q.id))
    try { await api.dismissInterviewQuestion(q.id) } catch { /* optimistic */ }
  }

  async function generate() {
    setGenerating(true); setGenError(false)
    try {
      const { questions: fresh } = await api.generateInterviewQuestions(bot)
      if (fresh.length) setQuestions(prev => [...fresh, ...prev])
      else showToast('לא נמצאו שאלות חדשות שעוד לא כוסו — המאגר שלך מקיף 👏')
    } catch {
      setGenError(true)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="iv-card">
      <div className="iv-head">
        <h3>🌐 שאלות מהשטח</h3>
        <span>לקוחות שואלים את זה ברשת — ענו בשפה חופשית, ואנחנו נהפוך את זה לתשובה מוכנה במאגר</span>
      </div>

      {visible.map(q => {
        const meta = botById(bots, q.bot)
        return (
          <div key={q.id} className="iv-q">
            <div className="iv-q-text">
              {meta && !bot && <span className="fq-bot-tag" style={{ '--bot-color': meta.color }}>{meta.icon} {meta.name}</span>}
              {q.text}
            </div>
            <textarea
              rows={2}
              placeholder="ענו כאן בחופשיות — גם שורה אחת מספיקה, אנחנו כבר ננסח"
              value={drafts[q.id] ?? q.raw_answer ?? ''}
              onChange={e => setDrafts(d => ({ ...d, [q.id]: e.target.value }))}
            />
            <div className="iv-actions">
              <button className="cd-qa" onClick={() => skip(q)}>דלג</button>
              <button className="cd-qa cd-qa-primary" disabled={busy[q.id] || !(drafts[q.id] ?? '').trim()}
                      onClick={() => send(q)}>
                {busy[q.id] ? 'מנסח…' : 'שלח לניסוח ←'}
              </button>
            </div>
          </div>
        )
      })}

      {visible.length === 0 && (
        <div className="iv-empty">עניתם על כל השאלות הפתוחות{bot ? ' בזון הזה' : ''} — שלפו חדשות 👇</div>
      )}

      <button className="iv-generate" onClick={generate} disabled={generating}>
        {generating ? '✨ שולף שאלות מהרשת…' : '✨ שלפו שאלות חדשות'}
      </button>
      {genError && <div className="iv-gen-error">השליפה לא הצליחה הפעם — נסו שוב עוד רגע</div>}
    </section>
  )
}
