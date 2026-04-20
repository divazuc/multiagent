export const CATEGORIES = {
  pricing:      'תמחור',
  scheduling:   'שעות ולוח זמנים',
  booking:      'הזמנה ורישום',
  services:     'שירותים ומוצרים',
  location:     'מיקום ונגישות',
  cancellation: 'ביטול ושינויים',
  trial:        'ניסיון והיכרות',
  general:      'כללי',
}

export const ARCHETYPES = {
  studio:  'סטודיו',
  service: 'שירות',
  other:   'אחר',
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES)

export const FAQ_STARTERS_BY_CATEGORY = {
  pricing: [
    { question: 'כמה זה עולה?',                        archetypes: [] },
    { question: 'יש מנוי חודשי או כרטיסייה?',           archetypes: ['studio'] },
    { question: 'יש אפשרות לתשלומים?',                  archetypes: ['service'] },
    { question: 'יש הנחה לקבוצה / לחבר שמביא חבר?',     archetypes: ['studio'] },
  ],
  scheduling: [
    { question: 'מה שעות הפעילות?',       archetypes: [] },
    { question: 'יש שיעורים בסופ"ש?',     archetypes: ['studio'] },
    { question: 'אפשר לקבוע פגישה בערב?', archetypes: ['service'] },
  ],
  booking: [
    { question: 'מתי אפשר להתחיל?',    archetypes: [] },
    { question: 'איך נרשמים לשיעור?',  archetypes: ['studio'] },
    { question: 'איך קובעים פגישה?',   archetypes: ['service'] },
    { question: 'צריך להירשם מראש?',   archetypes: [] },
  ],
  cancellation: [
    { question: 'אפשר לבטל או לשנות פגישה?',            archetypes: ['service'] },
    { question: 'אפשר לבטל שיעור? מה מדיניות הביטולים?', archetypes: ['studio'] },
    { question: 'מה קורה אם לא הגעתי?',                  archetypes: [] },
  ],
  services: [
    { question: 'איך התהליך עובד?',          archetypes: ['service'] },
    { question: 'אילו שיעורים מוצעים?',      archetypes: ['studio'] },
    { question: 'אפשר לראות עבודות קודמות?', archetypes: ['service'] },
    { question: 'עבדתם כבר עם מקרים דומים?', archetypes: ['service'] },
  ],
  location: [
    { question: 'איפה אתם נמצאים?',            archetypes: [] },
    { question: 'יש חניה?',                    archetypes: [] },
    { question: 'יש מקלחות במקום?',            archetypes: ['studio'] },
    { question: 'אפשר להגיע בתחבורה ציבורית?', archetypes: [] },
  ],
  trial: [
    { question: 'יש שיעור ניסיון?',                  archetypes: ['studio'] },
    { question: 'אפשר שיחת היכרות לפני שמתחייבים?', archetypes: ['service'] },
    { question: 'זה מתאים גם למתחילים?',            archetypes: ['studio'] },
  ],
  general: [
    { question: 'מה צריך להביא לשיעור ראשון?', archetypes: ['studio'] },
    { question: 'כמה זמן נמשך שיעור?',         archetypes: ['studio'] },
    { question: 'כמה זמן זה לוקח?',            archetypes: ['service'] },
    { question: 'מה צריך להכין מראש?',         archetypes: ['service'] },
    { question: 'יש ליווי לאורך כל התהליך?',  archetypes: ['service'] },
  ],
}

export function filterStartersForArchetype(archetype) {
  const valid = ARCHETYPE_KEYS.includes(archetype)
  const out = []
  for (const [category, items] of Object.entries(FAQ_STARTERS_BY_CATEGORY)) {
    for (const item of items) {
      const universal = item.archetypes.length === 0
      const match = valid && item.archetypes.includes(archetype)
      if (universal || match) {
        out.push({ category, question: item.question, archetypes: item.archetypes })
      }
    }
  }
  return out
}
