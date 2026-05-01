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
  booking: 'הזמנות',
  service: 'שירות',
  product: 'מוצר',
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES)

export const FAQ_STARTERS_BY_CATEGORY = {
  pricing: [
    {
      question: 'כמה זה עולה?',
      answer: 'המחירים שלנו משתנים בהתאם לסוג השירות. נשמח לשלוח לך הצעת מחיר מותאמת — רק תגיד לנו מה אתה צריך 😊',
      archetypes: [],
    },
    {
      question: 'יש מנוי חודשי או כרטיסייה?',
      answer: 'כן! יש לנו מספר אפשרויות — מנוי חודשי, כרטיסיית שיעורים, ותשלום חד-פעמי. נשמח לפרט.',
      archetypes: ['booking'],
    },
    {
      question: 'יש אפשרות לתשלומים?',
      answer: 'בהחלט! אנחנו מציעים תשלום בפריסה נוחה. צרו קשר ונסדר יחד את האפשרות המתאימה לכם.',
      archetypes: ['service'],
    },
    {
      question: 'יש הנחה לקבוצה / לחבר שמביא חבר?',
      answer: 'כן, יש לנו מסלול חבר מביא חבר! צרו קשר ונפרט את התנאים 😊',
      archetypes: ['booking'],
    },
    {
      question: 'האם המחיר כולל מע"מ?',
      answer: 'כל המחירים המצוינים הם כולל מע"מ, אלא אם צוין אחרת.',
      archetypes: [],
    },
  ],
  scheduling: [
    {
      question: 'מה שעות הפעילות?',
      answer: 'אנחנו פעילים ראשון עד חמישי 9:00–18:00. בסופ"ש — נא לבדוק איתנו מראש.',
      archetypes: [],
    },
    {
      question: 'יש שיעורים בסופ"ש?',
      answer: 'יש שיעורים גם בשישי בבוקר! ניתן לראות את הלוח המלא בדף שלנו או לשלוח הודעה לפרטים.',
      archetypes: ['booking'],
    },
    {
      question: 'אפשר לקבוע פגישה בערב?',
      answer: 'כן! יש לנו זמינות גם בשעות הערב עד 20:00 בימים מסוימים. שלחו הודעה ונבדוק יחד.',
      archetypes: ['service'],
    },
    {
      question: 'כמה זמן מראש צריך לקבוע?',
      answer: 'בדרך כלל מספיק יום-יומיים מראש, אך בעונה עמוסה עדיף להזמין שבוע מראש.',
      archetypes: [],
    },
  ],
  booking: [
    {
      question: 'מתי אפשר להתחיל?',
      answer: 'אפשר להתחיל מוקדם ככל שתרצו! שלחו הודעה ונבדוק יחד את התאריך הנוח לכם.',
      archetypes: [],
    },
    {
      question: 'איך נרשמים לשיעור?',
      answer: 'ניתן להירשם דרך ההודעה הזו, דרך האתר שלנו, או להתקשר ישירות. נשמח לעזור!',
      archetypes: ['booking'],
    },
    {
      question: 'איך קובעים פגישה?',
      answer: 'פשוט מאוד — שלחו לנו הודעה עם השם שלכם והתאריכים הנוחים לכם ונחזור אליכם לאישור.',
      archetypes: ['service'],
    },
    {
      question: 'צריך להירשם מראש?',
      answer: 'כן, מומלץ להירשם מראש כדי להבטיח מקום. לפעמים יש ביטולים של רגע אחרון — כדאי לשאול!',
      archetypes: [],
    },
  ],
  cancellation: [
    {
      question: 'אפשר לבטל או לשנות פגישה?',
      answer: 'כן, ניתן לבטל או לשנות פגישה עד 24 שעות לפני המועד ללא עלות. ביטול מאוחר יותר עשוי לחייב דמי ביטול.',
      archetypes: ['service'],
    },
    {
      question: 'אפשר לבטל שיעור? מה מדיניות הביטולים?',
      answer: 'ניתן לבטל עד 4 שעות לפני השיעור. ביטול מאוחר יותר ינוכה מהכרטיסייה/מנוי.',
      archetypes: ['booking'],
    },
    {
      question: 'מה קורה אם לא הגעתי?',
      answer: 'היעדרות ללא הודעה מראש נחשבת כשיעור שנוצל. אנחנו ממליצים תמיד להודיע מראש.',
      archetypes: [],
    },
    {
      question: 'אפשר להעביר תור לחבר?',
      answer: 'בהחלט! ניתן להעביר תור לחבר בתיאום מראש. שלחו פרטים ונאשר.',
      archetypes: [],
    },
  ],
  services: [
    {
      question: 'איך התהליך עובד?',
      answer: 'מתחילים בשיחת היכרות קצרה, מגדירים את הצרכים שלכם, ואז אנחנו מציעים פתרון מותאם. כל הדרך — ליווי צמוד.',
      archetypes: ['service'],
    },
    {
      question: 'אילו שיעורים מוצעים?',
      answer: 'אנחנו מציעים מגוון שיעורים לכל הרמות — מתחילים ועד מתקדמים. שלחו הודעה לקבלת הלוח המלא.',
      archetypes: ['booking'],
    },
    {
      question: 'אפשר לראות עבודות קודמות?',
      answer: 'בהחלט! יש לנו תיק עבודות מרשים — שלחו הודעה ואשלח לכם דוגמאות רלוונטיות לתחום שלכם.',
      archetypes: ['service'],
    },
    {
      question: 'עבדתם כבר עם מקרים דומים?',
      answer: 'כן, יש לנו ניסיון רב עם מקרים דומים. נשמח לשתף כמה דוגמאות ולספר על התוצאות.',
      archetypes: ['service'],
    },
    {
      question: 'מה מיוחד בשירות שלכם?',
      answer: 'הגישה האישית שלנו — כל לקוח מקבל טיפול מותאם, לא פתרון גנרי. אנחנו כאן לטווח הארוך.',
      archetypes: [],
    },
  ],
  location: [
    {
      question: 'איפה אתם נמצאים?',
      answer: 'אנחנו נמצאים ב-[כתובת]. שלחו הודעה ואשלח לכם פין מדויק ב-Waze / Google Maps 📍',
      archetypes: [],
    },
    {
      question: 'יש חניה?',
      answer: 'כן! יש חניה ציבורית בקרבת מקום. נשמח לשלוח הוראות הגעה מפורטות.',
      archetypes: [],
    },
    {
      question: 'יש מקלחות במקום?',
      answer: 'כן, יש מקלחות ולוקרים. מומלץ להביא מגבת ושמפו.',
      archetypes: ['booking'],
    },
    {
      question: 'אפשר להגיע בתחבורה ציבורית?',
      answer: 'בהחלט! קרוב לתחנות אוטובוס ורכבת. שלחו הודעה ואעזור בתכנון המסלול.',
      archetypes: [],
    },
  ],
  trial: [
    {
      question: 'יש שיעור ניסיון?',
      answer: 'כן! שיעור ניסיון ראשון במחיר מיוחד. שלחו הודעה ונקבע לכם 😊',
      archetypes: ['booking'],
    },
    {
      question: 'אפשר שיחת היכרות לפני שמתחייבים?',
      answer: 'בהחלט! שיחת היכרות קצרה של 15 דקות — ללא עלות וללא התחייבות. שלחו הודעה לתיאום.',
      archetypes: ['service'],
    },
    {
      question: 'זה מתאים גם למתחילים?',
      answer: 'לגמרי! אנחנו מקבלים כל רמה בברכה ומתאימים את הגישה לכל אחד.',
      archetypes: ['booking'],
    },
    {
      question: 'כמה זמן לוקח לראות תוצאות?',
      answer: 'זה תלוי בסוג השירות ובמקרה הספציפי, אך בדרך כלל הלקוחות מרגישים הבדל תוך כמה שבועות.',
      archetypes: ['service'],
    },
  ],
  general: [
    {
      question: 'מה צריך להביא לשיעור ראשון?',
      answer: 'בגדים נוחים, בקבוק מים ורצון טוב 😄 כל השאר אצלנו!',
      archetypes: ['booking'],
    },
    {
      question: 'כמה זמן נמשך שיעור?',
      answer: 'שיעור רגיל נמשך 60 דקות. יש גם שיעורי 45 דקות וסדנאות מיוחדות — תלוי בסוג.',
      archetypes: ['booking'],
    },
    {
      question: 'כמה זמן זה לוקח?',
      answer: 'משך הטיפול/פרויקט משתנה בהתאם להיקף. בשיחת היכרות נוכל לתת לכם הערכה מדויקת.',
      archetypes: ['service'],
    },
    {
      question: 'מה צריך להכין מראש?',
      answer: 'כמעט כלום! אנחנו מנחים אתכם בכל שלב. אם יש מסמכים רלוונטיים — כדאי להכין מראש.',
      archetypes: ['service'],
    },
    {
      question: 'יש ליווי לאורך כל התהליך?',
      answer: 'כן! אנחנו איתכם מהרגע הראשון ועד הסוף — כולל מענה לשאלות בין פגישות.',
      archetypes: ['service'],
    },
    {
      question: 'איך יוצרים קשר?',
      answer: 'הכי מהיר — ממש כאן בוואטסאפ! אפשר גם במייל או בטלפון בשעות הפעילות.',
      archetypes: [],
    },
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
        out.push({ category, question: item.question, answer: item.answer ?? '', archetypes: item.archetypes })
      }
    }
  }
  return out
}
