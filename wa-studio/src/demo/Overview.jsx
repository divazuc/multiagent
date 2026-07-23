import { useState, useEffect, useMemo, useRef } from 'react'

// Chart palette — validated (dataviz six checks, light surface):
// categorical: teal #0d9488 / bronze #b45309 / violet #6d28d9
// bar pair:    in-hours #0d9488 / after-hours #4338ca
const DOMAIN_META = [
  { key: 'treatments', label: 'טיפולי אסתטיקה', color: '#0d9488' },
  { key: 'hair', label: 'השתלות שיער וגבות', color: '#b45309' },
  { key: 'doctors', label: 'הכשרת רופאים', color: '#6d28d9' },
]
const BAR_IN = '#0d9488'
const BAR_AFTER = '#4338ca'

const nis = (n) => Math.round(n).toLocaleString('he-IL') + ' ₪'

function useCountUp(target, ms = 900) {
  const [value, setValue] = useState(0)
  const started = useRef(false)
  useEffect(() => {
    if (target == null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || started.current) {
      setValue(target); return
    }
    started.current = true
    const t0 = performance.now()
    let raf
    const tick = (t) => {
      const p = Math.min((t - t0) / ms, 1)
      setValue(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return value
}

// ── Daily activity bars: in-hours + after-hours stacked ─────────────────────
function ActivityBars({ daily }) {
  const [hover, setHover] = useState(null)
  const W = 640, H = 190, PAD_B = 26, PAD_T = 10
  const max = Math.max(...daily.map(d => d.messages), 1)
  const bw = W / daily.length
  const barW = Math.max(Math.min(bw - 2, 16), 3)

  const y = (v) => (H - PAD_B) - (v / max) * (H - PAD_B - PAD_T)

  // Month-start / weekly tick labels
  const ticks = daily.filter((d, i) => i % 7 === 0)

  return (
    <div className="ov-chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ov-bars" role="img" aria-label="פעילות הסוכן לפי יום">
        {[0.5, 1].map(f => (
          <line key={f} x1="0" x2={W} y1={y(max * f)} y2={y(max * f)} className="ov-grid" />
        ))}
        {daily.map((d, i) => {
          const x = i * bw + (bw - barW) / 2
          const inHours = d.messages - d.after_hours
          const hIn = (H - PAD_B) - y(inHours)
          const hAfter = (H - PAD_B) - y(d.after_hours)
          const yIn = y(inHours)
          return (
            <g key={d.date}
               onMouseEnter={() => setHover({ ...d, i, x: i * bw + bw / 2 })}>
              {/* hit target wider than the mark */}
              <rect x={i * bw} y={PAD_T} width={bw} height={H - PAD_B - PAD_T} fill="transparent" />
              {inHours > 0 && (
                <rect x={x} y={yIn} width={barW} height={Math.max(hIn, 2)} rx="2"
                      fill={BAR_IN} opacity={hover && hover.i !== i ? 0.45 : 1} />
              )}
              {d.after_hours > 0 && (
                <rect x={x} y={yIn - hAfter - 2} width={barW} height={Math.max(hAfter, 2)} rx="2"
                      fill={BAR_AFTER} opacity={hover && hover.i !== i ? 0.45 : 1} />
              )}
            </g>
          )
        })}
        {ticks.map(d => (
          <text key={d.date} x={daily.indexOf(d) * bw + bw / 2} y={H - 8} className="ov-tick">
            {new Date(d.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}
          </text>
        ))}
      </svg>
      {hover && (
        <div className="ov-tooltip" style={{ insetInlineStart: `${(hover.x / W) * 100}%` }}>
          <b>{new Date(hover.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })}</b>
          <span>{hover.messages} תשובות · {hover.conversations} שיחות</span>
          {hover.after_hours > 0 && <span className="ov-tooltip-after">{hover.after_hours} מחוץ לשעות הפעילות</span>}
        </div>
      )}
      <div className="ov-legend">
        <span className="ov-legend-item"><i style={{ background: BAR_IN }} />בשעות הפעילות</span>
        <span className="ov-legend-item"><i style={{ background: BAR_AFTER }} />מחוץ לשעות</span>
      </div>
    </div>
  )
}

// ── Domain donut: the three-bots story ──────────────────────────────────────
function DomainDonut({ domains, total }) {
  const [hover, setHover] = useState(null)
  const R = 62, STROKE = 26, C = 2 * Math.PI * R
  const entries = DOMAIN_META.map(m => ({ ...m, value: domains[m.key] || 0 })).filter(e => e.value > 0)
  let offset = 0

  return (
    <div className="ov-donut-wrap">
      <div className="ov-donut-svg">
        <svg viewBox="0 0 160 160" role="img" aria-label="התפלגות תחומי פנייה">
          <g transform="rotate(-90 80 80)">
            {entries.map(e => {
              const frac = e.value / total
              const seg = (
                <circle key={e.key} cx="80" cy="80" r={R} fill="none"
                  stroke={e.color} strokeWidth={hover === e.key ? STROKE + 4 : STROKE}
                  strokeDasharray={`${Math.max(frac * C - 2, 1)} ${C}`}
                  strokeDashoffset={-offset * C}
                  opacity={hover && hover !== e.key ? 0.4 : 1}
                  style={{ transition: 'stroke-width .15s, opacity .15s', cursor: 'default' }}
                  onMouseEnter={() => setHover(e.key)} onMouseLeave={() => setHover(null)} />
              )
              offset += frac
              return seg
            })}
          </g>
          <text x="80" y="76" textAnchor="middle" className="ov-donut-num">{total.toLocaleString('he-IL')}</text>
          <text x="80" y="94" textAnchor="middle" className="ov-donut-sub">שיחות</text>
        </svg>
      </div>
      <ul className="ov-donut-legend">
        {entries.map(e => (
          <li key={e.key}
              className={hover && hover !== e.key ? 'dim' : ''}
              onMouseEnter={() => setHover(e.key)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: e.color }} />
            <span className="ov-dl-label">{e.label}</span>
            <span className="ov-dl-val">{e.value} · {Math.round((e.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Signature: ROI meter — system cost vs value produced ────────────────────
function RoiMeter({ saved, cost }) {
  const roi = saved / cost
  const scaleMax = Math.max(Math.ceil(roi) + 1, 3)
  const pct = (v) => Math.min((v / (scaleMax * cost)) * 100, 100)
  return (
    <div className="ov-meter" role="img"
         aria-label={`המערכת החזירה פי ${roi.toFixed(1)} מעלותה החודשית`}>
      <div className="ov-meter-head">
        <span>עלות המערכת מול הערך שהיא מייצרת</span>
        <span className="ov-meter-badge">‏פי {roi.toFixed(1)} מהעלות</span>
      </div>
      <div className="ov-meter-rail">
        <div className="ov-meter-fill" style={{ width: `${pct(saved)}%` }} />
        <div className="ov-meter-cost" style={{ insetInlineStart: `${pct(cost)}%` }}>
          <label>עלות: {nis(cost)}</label>
        </div>
        {Array.from({ length: scaleMax - 1 }, (_, i) => i + 2).map(m => (
          <span key={m} className="ov-meter-tick" style={{ insetInlineStart: `${pct(cost * m)}%` }}>×{m}</span>
        ))}
      </div>
    </div>
  )
}

export default function Overview({ api }) {
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let dead = false
    setStats(null); setError(false)
    api.getOverviewStats(days)
      .then(s => { if (!dead) setStats(s) })
      .catch(() => { if (!dead) setError(true) })
    return () => { dead = true }
  }, [api, days])

  const money = useMemo(() => {
    if (!stats) return null
    const { totals, config } = stats
    const labor = totals.messages * config.minutes_per_reply / 60 * config.hourly_cost_ils
    const cost = config.monthly_cost_ils * (stats.days / 30)
    return { labor, cost, roi: labor / cost }
  }, [stats])

  const heroValue = useCountUp(money ? Math.round(money.labor / 10) * 10 : null)

  if (error) return <div className="ov-empty-card">לא הצלחנו לטעון את הנתונים — נסו לרענן את העמוד</div>
  if (!stats) return <div className="ov-empty-card ov-loading">טוען נתונים…</div>

  const { totals, daily, domains, avg_reply_ms, config } = stats
  const hasData = totals.messages > 0

  if (!hasData) {
    return (
      <div className="ov-empty-card">
        <div className="ov-empty-icon">📊</div>
        <h2>הנתונים מתחילים להיאסף</h2>
        <p>מהשיחה הראשונה שהסוכן ינהל, תראו כאן בדיוק כמה זמן וכסף המערכת חוסכת לעסק.</p>
      </div>
    )
  }

  const afterPct = Math.round((totals.after_hours_messages / totals.messages) * 100)
  const replySeconds = avg_reply_ms ? Math.max(Math.round(avg_reply_ms / 1000), 1) : null

  return (
    <div className="ov-page">
      {/* range selector */}
      <div className="ov-range" role="tablist" aria-label="טווח זמן">
        {[7, 30, 90].map(d => (
          <button key={d} role="tab" aria-selected={days === d}
                  className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
            {d} ימים
          </button>
        ))}
      </div>

      {/* hero: money saved */}
      <section className="ov-hero">
        <div className="ov-hero-main">
          <div className="ov-hero-label">שווי עבודת המענה שהמערכת ביצעה ב-{stats.days} הימים האחרונים</div>
          <div className="ov-hero-number">{nis(heroValue)}</div>
          <div className="ov-hero-formula">
            {totals.messages.toLocaleString('he-IL')} תשובות ללקוחות · ‏~{config.minutes_per_reply} דק׳ למענה ידני · ‏{nis(config.hourly_cost_ils)} לשעת נציגה
          </div>
        </div>
        <div className="ov-hero-side">
          <div className="ov-hero-chip">
            <b>{totals.after_hours_sessions}</b>
            <span>שיחות שנפתחו מחוץ לשעות הפעילות — פניות שאף אחד לא היה עונה להן</span>
          </div>
          <div className="ov-hero-chip">
            <b>{totals.cta_sessions}</b>
            <span>לידים שהתקדמו לתיאום ייעוץ או השאירו פרטים</span>
          </div>
        </div>
        <RoiMeter saved={money.labor} cost={money.cost} />
      </section>

      {/* KPI tiles */}
      <section className="ov-tiles" aria-label="מדדים">
        <div className="ov-tile">
          <div className="ov-tile-val">{totals.conversations.toLocaleString('he-IL')}</div>
          <div className="ov-tile-label">שיחות שנוהלו</div>
          <div className="ov-tile-sub">{totals.messages.toLocaleString('he-IL')} תשובות נשלחו</div>
        </div>
        <div className="ov-tile">
          <div className="ov-tile-val">{replySeconds ? `${replySeconds} שנ׳` : 'מיידי'}</div>
          <div className="ov-tile-label">זמן מענה ראשון</div>
          <div className="ov-tile-sub">זמינות מלאה, 24/7</div>
        </div>
        <div className="ov-tile">
          <div className="ov-tile-val">{afterPct}%</div>
          <div className="ov-tile-label">מהפעילות מחוץ לשעות</div>
          <div className="ov-tile-sub">ערבים, סופי שבוע וחגים</div>
        </div>
        <div className="ov-tile">
          <div className="ov-tile-val">{totals.escalations.toLocaleString('he-IL')}</div>
          <div className="ov-tile-label">הועברו לנציגה אנושית</div>
          <div className="ov-tile-sub">בדיוק לפי הכללים שהוגדרו</div>
        </div>
      </section>

      {/* charts */}
      <div className="ov-charts">
        <section className="ov-card">
          <h3>פעילות הסוכן לפי יום</h3>
          <ActivityBars daily={daily} />
        </section>
        <section className="ov-card">
          <h3>התפלגות תחומי פנייה</h3>
          <div className="ov-card-sub">הבוט המרכזי מזהה את התחום ומנתב כל שיחה</div>
          <DomainDonut domains={domains} total={totals.conversations} />
        </section>
      </div>
    </div>
  )
}
