import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { fetchOverview, fetchConversationHistory } from '../lib/supabase'

const STATUS_LABELS = {
  new_lead: '🆕 ליד חדש', in_conversation: '💬 בשיחה',
  cta_triggered: '📅 CTA הופעל', followup_sent: '🔁 פולואפ נשלח',
  converted: '✅ הומר', cold: '🥶 קר', not_relevant: '❌ לא רלוונטי',
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function hoursFromConversations(total) {
  return Math.round(total * 0.08 * 10) / 10 // ~5 min avg per conversation
}

export default function Overview({ businessId, businessName }) {
  const [data, setData]       = useState(null)
  const [chartData, setChart] = useState([])
  const [loading, setLoading] = useState(true)
  const month = currentMonth()

  useEffect(() => {
    if (!businessId) return
    Promise.all([
      fetchOverview(businessId, month),
      fetchConversationHistory(businessId),
    ]).then(([overview, messages]) => {
      setData(overview)

      // Build weekly chart from messages
      const byDay = {}
      messages.forEach(m => {
        const day = m.created_at?.slice(0, 10)
        if (day) byDay[day] = (byDay[day] || 0) + 1
      })
      const days = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-14)
        .map(([date, count]) => ({ date: date.slice(5), count }))
      setChart(days)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [businessId])

  if (!businessId) return <div className="empty">בחר עסק להצגת נתונים</div>
  if (loading) return <div className="loading">טוען...</div>
  if (!data)   return <div className="empty">אין נתונים</div>

  const hours = hoursFromConversations(data.total_leads)
  const convRate = data.total_leads > 0
    ? Math.round((data.converted / data.total_leads) * 100)
    : 0
  const billing = data.billing

  return (
    <div>
      <div className="page-title">סקירה כללית / Overview</div>

      {/* Hero — hours saved */}
      <div className="hero-banner">
        <div className="hero-icon">⏱️</div>
        <div>
          <div className="hero-title">הסוכן חסך לך ~{hours} שעות החודש</div>
          <div className="hero-sub">
            {data.total_leads} שיחות טופלו אוטומטית — זמן שחזר אליך
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">לידים החודש</div>
          <div className="kpi-value">{data.total_leads}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">בשיחה פעילה</div>
          <div className="kpi-value">{data.in_conversation}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">CTA הופעל</div>
          <div className="kpi-value">{data.cta_triggered}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">הומרו</div>
          <div className="kpi-value" style={{ color: 'var(--accent)' }}>{data.converted}</div>
          <div className="kpi-sub">{convRate}% מכלל הלידים</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">לידים קרים</div>
          <div className="kpi-value" style={{ color: '#9ca3af' }}>{data.cold}</div>
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="section-hd">שיחות לפי יום / Daily conversations</div>
          <ResponsiveContainer width="100%" height={window.innerWidth < 768 ? 140 : 180}>
            <BarChart data={chartData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text)' }}
              />
              <Bar dataKey="count" fill="var(--accent)" radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Billing */}
      {billing?.status === 'success' && (
        <div className="card">
          <div className="section-hd">עלויות וואטסאפ / WhatsApp usage — {month}</div>
          <div className="billing-row">
            <span>שיחות נכנסות (user-initiated)</span>
            <span style={{ fontWeight: 600 }}>{billing.user_initiated}</span>
          </div>
          <div className="billing-row">
            <span>פולואפים שנשלחו (business-initiated)</span>
            <span style={{ fontWeight: 600 }}>{billing.business_initiated}</span>
          </div>
          <div className="billing-row">
            <span>נותר בחינם החודש</span>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{billing.free_tier_remaining} שיחות</span>
          </div>
          <div className="billing-row">
            <span>עלות משוערת</span>
            <span style={{ fontWeight: 700 }}>
              {billing.estimated_cost_ils > 0 ? `₪${billing.estimated_cost_ils}` : 'חינם ✓'}
            </span>
          </div>
          <div className="billing-note">
            * חישוב הערכתי לפי תעריפי Meta. החשבון המדויק מופיע ב-Meta Business Manager.
          </div>
        </div>
      )}
    </div>
  )
}
