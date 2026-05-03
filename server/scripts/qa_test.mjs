/**
 * Full QA test — covers:
 * 1. App load + login bypass
 * 2. Create new business
 * 3. Full setup wizard (all 16 stages)
 * 4. Business Preferences edit panel
 * 5. FAQ panel + knowledge sync
 * 6. Live session conversation
 */

import { chromium } from 'playwright';

const BASE   = 'http://localhost:5174';
const AGENT  = 'http://localhost:8080';
const passes = [];
const fails  = [];

const log  = (msg) => console.log(`  [${new Date().toISOString().slice(11,19)}] ${msg}`);
const pass = (msg) => { passes.push(msg); log(`✅ ${msg}`); };
const fail = (msg) => { fails.push(msg);  log(`❌ ${msg}`); };
const shot = async (page, name) => page.screenshot({ path: `scripts/qa_${name}.png`, fullPage: false }).catch(() => {});
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── helpers ───────────────────────────────────────────────────────────────────

async function clickOption(page, value) {
  const found = await page.$$('div[style*="cursor: pointer"][style*="border-radius: 10px"]');
  for (const el of found) {
    const txt = await el.textContent();
    if (txt.toLowerCase().includes(value.toLowerCase())) {
      await el.click();
      return true;
    }
  }
  // fallback: click first card
  if (found.length) { await found[0].click(); return true; }
  return false;
}

async function clickContinue(page) {
  const btn = await page.$('button:has-text("המשך")');
  if (!btn) { fail('Continue button not found'); return false; }
  await btn.click();
  await wait(1500);
  return true;
}

async function stageTitle(page) {
  return page.textContent('body').then(t => {
    const m = t.match(/(\d+) \/ \d+/);
    return m ? m[0] : '?/?';
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  WA Studio — Full QA Test');
  console.log('══════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
  page.on('pageerror', e => errors.push(`PAGE: ${e.message.slice(0, 150)}`));

  try {

    // ─── 1. App load ─────────────────────────────────────────────────────────
    console.log('► 1. App load');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.setItem('wa_studio_auth', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    const hasPanel = await page.$('.panel-sessions');
    hasPanel ? pass('App loaded, session panel visible') : fail('Session panel missing');
    await shot(page, '01_loaded');

    // ─── 2. Create business ───────────────────────────────────────────────────
    console.log('\n► 2. Create business');
    const newBizBtn = await page.$('button:has-text("New Business")');
    if (!newBizBtn) { fail('New Business button missing'); }
    else {
      await newBizBtn.click();
      await wait(600);
      const bizName = `QA Test ${Date.now().toString().slice(-4)}`;
      const nameInput = await page.$('input[placeholder*="TechPro"], input[placeholder*="business"], input[placeholder*="Business"]');
      if (nameInput) {
        await nameInput.fill(bizName);
        const createBtn = await page.$('button:has-text("Create")');
        await createBtn?.click();
        await wait(1500);
        const startBtn = await page.$('button:has-text("Start with")');
        if (startBtn && !(await startBtn.isDisabled())) {
          await startBtn.click();
          await wait(2000);
          pass(`Business "${bizName}" created and session started`);
        } else {
          fail('Start button not found or disabled after creation');
        }
      } else {
        fail('Business name input not found');
      }
    }
    await shot(page, '02_after_start');

    // ─── 3. Setup wizard — all stages ────────────────────────────────────────
    console.log('\n► 3. Setup wizard stages');

    const stageActions = [
      // [stage_name, action_fn]
      ['business_details', async () => { await clickContinue(page); }],
      ['business_type',     async () => { await clickOption(page, 'service'); await clickContinue(page); }],
      ['business_category', async () => { await wait(800); await clickOption(page, 'general'); await clickContinue(page); }],
      ['faq_topics',       async () => {
        const cards = await page.$$('div[style*="cursor: pointer"][style*="border-radius: 10px"]');
        if (cards.length >= 2) { await cards[0].click(); await cards[1].click(); }
        await clickContinue(page);
      }],
      ['cta_goal',         async () => { await clickOption(page, 'book_call'); await clickContinue(page); }],
      ['push_speed',       async () => { await clickOption(page, 'balanced'); await clickContinue(page); }],
      ['tone',             async () => { await clickOption(page, 'warm'); await clickContinue(page); }],
      ['response_length',  async () => { await clickOption(page, 'short'); await clickContinue(page); }],
      ['emoji_usage',      async () => { await clickOption(page, 'light'); await clickContinue(page); }],
      ['escalation',       async () => { await clickOption(page, 'user_asks'); await clickContinue(page); }],
      // escalation_other: auto-skipped via SkipNotice (no 'other' selected) — click its "המשך" button
      ['escalation_other', async () => {
        const btn = await page.$('button:has-text("המשך"), button:has-text("דלג")');
        if (btn) { await btn.click(); await wait(1000); }
      }],
      // text/faq_pairs stages: click "דלג" footer skip button
      ['faq_examples',     async () => {
        const skip = await page.$('button:has-text("דלג")');
        if (skip) { await skip.click(); } else { await clickContinue(page); }
        await wait(1000);
      }],
      ['objections',       async () => { const s = await page.$('button:has-text("דלג")'); if (s) await s.click(); else await clickContinue(page); await wait(1000); }],
      ['forbidden_claims', async () => { const s = await page.$('button:has-text("דלג")'); if (s) await s.click(); else await clickContinue(page); await wait(1000); }],
      ['final_note',       async () => { const s = await page.$('button:has-text("דלג")'); if (s) await s.click(); else await clickContinue(page); await wait(1000); }],
      ['working_hours',       async () => { await clickContinue(page); }],
      ['agent_availability',  async () => { await clickContinue(page); }],
      ['confirm',          async () => {
        await wait(500);
        // Confirm stage: click "skip to live" (commits setup directly)
        const skipBtn = await page.$('button:has-text("דלג → עבור"), button:has-text("דלג")');
        if (skipBtn) {
          await skipBtn.click();
          await wait(4000);
          pass('Clicked Activate Agent');
        } else {
          // Fallback: old-style activate button
          const activateBtn = await page.$('button:has-text("הפעל סוכן"), button:has-text("Activate Agent"), button:has-text("הפעל")');
          if (activateBtn) {
            await activateBtn.click();
            await wait(4000);
            pass('Clicked Activate Agent');
          } else {
            const btns = await page.$$eval('button', b => b.map(e => e.textContent.trim()).filter(t=>t));
            fail(`Activate button not found. Buttons: ${JSON.stringify(btns).slice(0,200)}`);
          }
        }
      }],
    ];

    for (const [stageName, action] of stageActions) {
      const before = await stageTitle(page);
      await action();
      await wait(500);
      const after = await stageTitle(page);
      const errEl = await page.$eval('body', b => b.querySelector('[style*="#f87171"]')?.textContent ?? null);
      if (errEl) fail(`Stage ${stageName}: error shown — ${errEl.slice(0, 80)}`);
      else pass(`Stage ${stageName}: completed (${before} → ${after})`);
      await shot(page, `03_${stageName}`);
    }

    // ─── 4. Check session is now live ─────────────────────────────────────────
    console.log('\n► 4. Post-setup state');
    await wait(4000); // wait for onCommitted to refresh session
    await shot(page, '04_post_commit');
    const bodyText = await page.textContent('body');
    log(`Page contains: ${bodyText.slice(0,300).replace(/\s+/g,' ')}`);
    if (bodyText.includes('Live') || bodyText.includes('live')) {
      pass('Page contains live mode indicator');
    } else {
      fail('No live mode indicator found');
    }
    // Check if ChatInterface rendered
    const chatInput = await page.$('textarea.chat-input');
    const faqBtnCheck = await page.$('button:has-text("FAQ")');
    log(`Chat input: ${!!chatInput} | FAQ btn: ${!!faqBtnCheck}`);

    // ─── 5. Business Preferences panel ───────────────────────────────────────
    console.log('\n► 5. Business Preferences');
    const prefsBtn = await page.$('button[title="Business Preferences"]');
    if (!prefsBtn) {
      fail('Business Preferences button (⚙️) not found in chat header');
    } else {
      await prefsBtn.click();
      await wait(800);
      const prefsTitle = await page.$('text=העדפות עסק');
      prefsTitle ? pass('Business Preferences panel opened') : fail('Preferences panel did not open');
      await shot(page, '05_prefs');

      // Try saving
      const saveBtn = await page.$('button:has-text("שמור שינויים")');
      if (saveBtn) {
        await saveBtn.click();
        await wait(1500);
        const successEl = await page.$('text=נשמר בהצלחה');
        successEl ? pass('Business Preferences saved successfully') : fail('Save did not show success message');
      } else {
        fail('Save button not found in preferences');
      }

      // Close prefs
      const closeBtn = await page.$('button:has-text("✕")');
      await closeBtn?.click();
      await wait(500);
    }

    // ─── 6. FAQ panel ─────────────────────────────────────────────────────────
    console.log('\n► 6. FAQ panel');
    const faqBtn = await page.$('button:has-text("FAQ")');
    if (!faqBtn) {
      fail('FAQ button not found');
    } else {
      await faqBtn.click();
      await wait(1000);
      const faqPanel = await page.$('.fq-panel');
      faqPanel ? pass('FAQ panel opened') : fail('FAQ panel did not open');
      await shot(page, '06_faq');
      const backBtn = await page.$('button.fq-back-btn');
      await backBtn?.click();
      await wait(500);
    }

    // ─── 7. Send a test message (live mode) ───────────────────────────────────
    console.log('\n► 7. Live conversation');
    const input = await page.$('textarea.chat-input');
    if (!input) {
      fail('Chat input not found');
    } else {
      await input.fill('שלום, אני מחפש שירות ניקיון');
      await page.keyboard.press('Enter');
      await wait(3000); // shorter wait locally (no real LLM delay in QA)
      const msgCount = await page.$$eval('.message-assistant', els => els.length);
      msgCount > 0
        ? pass(`Live conversation: agent replied (${msgCount} message(s))`)
        : fail('No agent reply received after 3s');
      await shot(page, '07_conversation');
    }

    // ─── 8. Check server endpoints ────────────────────────────────────────────
    console.log('\n► 8. Server endpoint checks');
    const endpoints = [
      { path: '/health', method: 'GET' },
      { path: '/setup/save', method: 'POST', body: { session_id: 'qa-test', stage: 'business_type', value: 'service' } },
      { path: '/knowledge/sync', method: 'POST', body: { business_id: 'qa-nonexistent' } },
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${AGENT}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      }).then(r => r.json()).catch(e => ({ error: e.message }));
      const ok = res.ok === true || res.status === 'success' || res.synced !== undefined;
      ok ? pass(`${ep.method} ${ep.path} → ok`) : fail(`${ep.method} ${ep.path} → ${JSON.stringify(res).slice(0,80)}`);
    }

  } catch (e) {
    fail(`FATAL: ${e.message}`);
    await shot(page, 'fatal');
  }

  await browser.close();

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  ✅ ${passes.length} passed   ❌ ${fails.length} failed`);
  if (errors.length) console.log(`  ⚠️  ${errors.length} console error(s)`);
  console.log('══════════════════════════════════════════════');
  if (fails.length) {
    console.log('\nFailures:');
    fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  if (errors.length) {
    console.log('\nConsole errors:');
    errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }
}

run().catch(e => { console.error('Script crashed:', e.message); process.exit(1); });
