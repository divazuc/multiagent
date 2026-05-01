import { chromium } from 'playwright';

const BASE   = 'http://localhost:5175';
const errors = [];
const log    = (msg) => console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
const shot   = async (page, name) => page.screenshot({ path: `scripts/shot_${name}.png` });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await ctx.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(`CONSOLE: ${msg.text().slice(0,200)}`);
      log(`❌ Console: ${msg.text().slice(0,100)}`);
    }
  });
  page.on('pageerror', err => {
    errors.push(`PAGE ERROR: ${err.message}`);
    log(`❌ Page error: ${err.message.slice(0,100)}`);
  });
  page.on('requestfailed', req => {
    if (!req.url().includes('log/error')) {
      errors.push(`NET FAIL: ${req.method()} ${req.url().slice(0,100)}`);
      log(`❌ Net fail: ${req.url().slice(0,80)}`);
    }
  });

  try {
    // 1. Load + bypass login
    log('Loading app...');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.setItem('wa_studio_auth', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    await shot(page, '01_loaded');
    log('✓ App loaded');

    // 2. Click "+ New Business (test)"
    const newBizBtn = await page.waitForSelector('button:has-text("New Business")', { timeout: 5000 });
    await newBizBtn.click();
    await page.waitForTimeout(800);
    await shot(page, '02_after_new_biz');
    log('✓ Clicked New Business — form appeared');

    // 3. Fill business name (unique per run)
    const bizName = `PW Test ${Date.now().toString().slice(-5)}`;
    const nameInput = await page.$('input[placeholder*="TechPro"], input[placeholder*="business"], input[placeholder*="Business"]');
    if (nameInput) {
      await nameInput.fill(bizName);
      log(`✓ Filled business name: ${bizName}`);
    } else {
      log('⚠️  Business name input not found');
    }

    // 4. Click Create
    const createBtn = await page.$('button:has-text("Create")');
    if (createBtn) {
      await createBtn.click();
      await page.waitForTimeout(2000);
      await shot(page, '03_after_create');
      log('✓ Clicked Create');
    } else {
      log('⚠️  Create button not found');
    }

    // 5. Click Start button (says "Start with [biz name]")
    const startBtn = await page.$('button:has-text("Start with"), button:has-text("Start Session"), button:has-text("התחל")');
    if (startBtn) {
      const label = await startBtn.textContent();
      const isDisabled = await startBtn.isDisabled();
      log(`Start button: "${label.trim()}" | disabled: ${isDisabled}`);
      if (!isDisabled) {
        await startBtn.click();
        await page.waitForTimeout(2500);
        await shot(page, '04_after_start');
        log('✓ Clicked Start');
      } else {
        log('⚠️  Start button is disabled');
      }
    } else {
      log('⚠️  Start button not found');
    }

    // 6. Check wizard appeared
    await shot(page, '05_wizard_check');
    const bodyText = await page.textContent('body');

    if (bodyText.includes('סוג העסק') || bodyText.includes('Business type')) {
      log('✓ Setup wizard visible');
    } else {
      log('⚠️  Setup wizard not visible — page content: ' + bodyText.slice(0, 200));
    }

    // 6. Find and click first option card
    await page.waitForTimeout(500);
    const cards = await page.$$('div[style*="cursor: pointer"][style*="border-radius: 10px"]');
    log(`Found ${cards.length} option cards`);

    if (cards.length > 0) {
      await cards[0].click();
      await page.waitForTimeout(300);
      log('✓ Clicked first card (Service)');

      // 7. Click Continue
      const continueBtn = await page.$$eval('button', btns => {
        const b = btns.find(b => b.textContent.includes('המשך') || b.textContent.includes('Continue'));
        return b ? b.textContent : null;
      });
      log(`Continue button text: ${continueBtn}`);

      const btn = await page.$('button:has-text("המשך")');
      if (btn) {
        await btn.click();
        await page.waitForTimeout(2000);
        await shot(page, '05_after_continue');
        log('✓ Clicked Continue');

        // Check for errors
        const errVisible = await page.$eval('body', b => {
          const el = b.querySelector('[style*="#f87171"]');
          return el ? el.textContent : null;
        });
        if (errVisible) {
          errors.push(`UI ERROR: ${errVisible}`);
          log(`❌ Error shown: ${errVisible}`);
        } else {
          log('✓ No error after continue');
        }

        // Check stage advanced
        const newCards = await page.$$('div[style*="cursor: pointer"][style*="border-radius: 10px"]');
        log(`After advance: ${newCards.length} cards (should be different from first stage)`);
        await shot(page, '06_stage2');

        const newText = await page.textContent('body');
        if (newText.includes('FAQ') || newText.includes('שואלים')) {
          log('✓ Stage advanced to FAQ topics');
        } else {
          log('⚠️  Stage may not have advanced — body: ' + newText.slice(100, 300));
        }
      } else {
        log('⚠️  Continue button not found');
        const allBtns = await page.$$eval('button', b => b.map(e => e.textContent.trim()).filter(t => t));
        log('All buttons: ' + JSON.stringify(allBtns));
      }
    }

  } catch (e) {
    log(`❌ FATAL: ${e.message}`);
    errors.push(`FATAL: ${e.message}`);
    await shot(page, 'fatal_error');
  }

  await browser.close();

  console.log('\n══════════════════════════════════════');
  if (errors.length === 0) {
    console.log('✅ All steps passed — no errors found');
  } else {
    console.log(`❌ ${errors.length} issue(s) found:`);
    errors.forEach((e, i) => console.log(`  ${i+1}. ${e}`));
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
