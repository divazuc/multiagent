import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 12 guided questions to extract business owner's voice ─────────────────────
export const DEMO_QUESTIONS = [
  // Category 1: Business voice
  {
    key: 'intro_own_words',
    category: 'הקול שלך / Your voice',
    question: 'ספר בכמה מילים מה העסק שלך עושה ומה מייחד אותך מאחרים.',
    hint: 'דבר חופשי, כמו שהיית מספר לחבר — לא כמו פרסומת.',
    example: 'אנחנו עושים... מה שמייחד אותנו זה...',
  },
  {
    key: 'intro_to_lead',
    category: 'הקול שלך / Your voice',
    question: 'לקוח חדש שואל: "מה אתם עושים בדיוק?" — מה אתה עונה לו בוואטסאפ?',
    hint: 'כתוב ממש כמו שהיית כותב ללקוח — כולל אימוג\'י אם אתה משתמש.',
    example: 'שלום! אנחנו...',
  },
  {
    key: 'why_choose_you',
    category: 'הקול שלך / Your voice',
    question: 'לקוח שואל: "למה לבחור דווקא בכם?" — מה אתה עונה?',
    hint: 'תן תשובה אמיתית, לא שיווקית מדי.',
    example: null,
  },

  // Category 2: FAQ responses
  {
    key: 'pricing_answer',
    category: 'שאלות נפוצות / FAQ',
    question: 'לקוח שואל: "כמה זה עולה?" — מה אתה עונה?',
    hint: 'אם המחיר תלוי בפרמטרים — הראה איך אתה מסביר את זה.',
    example: null,
  },
  {
    key: 'availability_answer',
    category: 'שאלות נפוצות / FAQ',
    question: 'לקוח שואל: "מתי אתה פנוי?" — מה אתה עונה?',
    hint: 'כולל איך אתה מציע לתאם.',
    example: null,
  },
  {
    key: 'proof_answer',
    category: 'שאלות נפוצות / FAQ',
    question: 'לקוח שואל: "אפשר לראות עבודות קודמות / המלצות?" — מה אתה עונה?',
    hint: 'גם אם אין לך — איך אתה מתמודד עם זה?',
    example: null,
  },

  // Category 3: Objections
  {
    key: 'objection_price',
    category: 'התנגדויות / Objections',
    question: 'לקוח אומר: "יקר לי" — מה אתה עונה?',
    hint: 'תגובה אמיתית, לא ספרי מכירות. איך אתה באמת מגיב?',
    example: null,
  },
  {
    key: 'objection_thinking',
    category: 'התנגדויות / Objections',
    question: 'לקוח אומר: "אני צריך לחשוב על זה" — מה אתה עונה?',
    hint: 'זה קורה כל הזמן — מה הנוסחה שלך?',
    example: null,
  },

  // Category 4: CTA style
  {
    key: 'cta_style',
    category: 'סגירה / CTA',
    question: 'כשאתה רוצה שלקוח יקבע תור / יתקשר / יקנה — מה אתה כותב לו?',
    hint: 'תן דוגמה של הודעה שאתה שולח כשאתה רוצה לקדם לפעולה.',
    example: null,
  },
  {
    key: 'followup_style',
    category: 'סגירה / CTA',
    question: 'לקוח התעניין אבל לא מתקדם — איך אתה פונה אליו שוב?',
    hint: 'הודעת המעקב האופיינית שלך.',
    example: null,
  },

  // Category 5: Free-form
  {
    key: 'cold_lead_message',
    category: 'דוגמת שיחה / Sample',
    question: 'כתוב הודעה שלמה ללקוח שרק שלח: "שלום, ראיתי פרסומת שלכם, אני מתעניין"',
    hint: 'כתוב ממש כאילו אתה עונה עכשיו — זו ההזדמנות שלך ללמד את הסוכן.',
    example: null,
  },
  {
    key: 'confirm_booking',
    category: 'דוגמת שיחה / Sample',
    question: 'לקוח סגר איתך תור / עסקה — כתוב הודעת אישור שאתה שולח לו.',
    hint: 'כולל כל הפרטים שאתה בדרך כלל כותב.',
    example: null,
  },
];

// ── Voice extraction ───────────────────────────────────────────────────────────
export async function extractVoice(answers) {
  const qa = DEMO_QUESTIONS.map(q => {
    const ans = answers[q.key];
    if (!ans) return null;
    return `שאלה (${q.category}): ${q.question}\nתשובת בעל העסק: ${ans}`;
  }).filter(Boolean).join('\n\n');

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `אתה מנתח את הקול של בעל עסק ישראלי כדי לתכנת סוכן AI שיישמע כמוהו.

בהתבסס על התשובות הבאות, ספק ניתוח קצר בJSON:

${qa}

החזר JSON בלבד (ללא markdown) בפורמט:
{
  "tone": ["warm"|"professional"|"direct"|"friendly"|"casual"],
  "answer_length": "short"|"medium"|"detailed",
  "emoji_style": "none"|"light"|"natural"|"free",
  "language_mix": "hebrew_only"|"hebrew_english_mix",
  "formality": "formal"|"semi_formal"|"casual",
  "signature_phrases": ["עד 3 ביטויים אופייניים שחוזרים"],
  "cta_style": "תיאור קצר של איך הוא מוביל לפעולה",
  "objection_style": "תיאור קצר של איך הוא מתמודד עם התנגדויות",
  "voice_summary": "משפט אחד שמסכם את הקול שלו"
}`
    }]
  });

  try {
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return null;
  }
}

// ── Demo agent runner ──────────────────────────────────────────────────────────
export async function runDemo({ message, session_id, context }) {
  try {
    const { supabase } = await import('../lib/supabase.js');

    // Load current draft to know which question we're on
    const { data: draftRow } = await supabase
      .from('setup_drafts')
      .select('draft_setup_data, current_setup_stage')
      .eq('session_id', session_id)
      .maybeSingle();

    const draft = draftRow?.draft_setup_data ?? {};
    const demoAnswers = draft.demo_answers ?? {};
    const total = DEMO_QUESTIONS.length;

    if (message === 'start') {
      // Initialize draft
      await supabase.from('setup_drafts').upsert(
        { session_id, business_id: context.business_id, draft_setup_data: { ...draft, demo_answers: demoAnswers }, updated_at: new Date().toISOString() },
        { onConflict: 'session_id' }
      );
    } else if (message) {
      // The user's message answers the first still-unanswered question
      const current = DEMO_QUESTIONS.find(q => !demoAnswers[q.key]);
      if (current) {
        demoAnswers[current.key] = message;
        await supabase.from('setup_drafts').upsert(
          {
            session_id,
            business_id: context.business_id,
            draft_setup_data: { ...draft, demo_answers: demoAnswers },
            current_setup_stage: `demo_${current.key}`,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'session_id' }
        );
      }
    }

    // Next unanswered question — computed AFTER saving the current answer
    const nextQuestion = DEMO_QUESTIONS.find(q => !demoAnswers[q.key]);

    if (!nextQuestion) {
      // All answered — extract voice and complete
      const voice = await extractVoice(demoAnswers);

      if (voice && context.business_id) {
        const persona = {
          tone: voice.tone ?? [],
          answer_length: voice.answer_length ?? 'medium',
          emoji_style: voice.emoji_style ?? 'light',
          formality: voice.formality ?? 'semi_formal',
          language_mix: voice.language_mix ?? 'hebrew_only',
          signature_phrases: voice.signature_phrases ?? [],
          cta_style: voice.cta_style ?? '',
          objection_style: voice.objection_style ?? '',
          voice_summary: voice.voice_summary ?? '',
          extracted_from_demo: true,
        };

        await supabase.from('business_profiles')
          .update({ persona, updated_at: new Date().toISOString() })
          .eq('business_id', context.business_id);

        await supabase.from('sessions')
          .update({ session_mode: 'live', updated_at: new Date().toISOString() })
          .eq('session_id', session_id);
      }

      return {
        status: 'success',
        result: {
          response: `🎉 מעולה! סיימנו.\n\nניתחתי את כל התשובות שלך וכיוונתי את הסוכן לדבר בדיוק כמוך.\n\n${voice?.voice_summary ?? ''}\n\nהסוכן מוכן לשיחות אמיתיות.`,
          is_done: true,
          voice_profile: voice,
          next_question_index: total,
          total_questions: total,
        }
      };
    }

    const displayIndex = DEMO_QUESTIONS.indexOf(nextQuestion) + 1;

    const response = `*שאלה ${displayIndex}/${total} — ${nextQuestion.category}*\n\n${nextQuestion.question}${nextQuestion.hint ? `\n\n_💡 ${nextQuestion.hint}_` : ''}`;

    return {
      status: 'success',
      result: {
        response,
        next_question: nextQuestion.key,
        next_question_index: displayIndex,
        total_questions: total,
        is_done: false,
      }
    };

  } catch (e) {
    return { status: 'error', error: e.message };
  }
}
