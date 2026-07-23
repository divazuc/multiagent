// Bot-policy catalogs — common escalation scenarios and forbidden topics.
// Selected labels are stored as strings in business_profiles.guardrails
// (escalation_points / forbidden_topics + *_custom free text) and are fed
// verbatim into the conversation agent's prompts.

export const ESCALATION_OPTIONS = [
  'שאלת מחיר / בקשת הצעת מחיר',
  'בקשה מפורשת לדבר עם נציג אנושי',
  'תלונה או לקוח כועס',
  'שאלה רפואית או רגישה',
  'בקשת ביטול או החזר כספי',
  'שאלה משפטית או חוזית',
  'עסקה גדולה / ליד VIP',
]

export const FORBIDDEN_OPTIONS = [
  'מסירת מחירים, הנחות ותנאי תשלום',
  'ייעוץ רפואי אישי',
  'ייעוץ משפטי',
  'התחייבות לתוצאות או לאחריות',
  'התחייבות לזמינות תור / מועד אספקה',
  'התבטאות על מתחרים',
  'שיתוף פרטים של לקוחות אחרים',
]

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
