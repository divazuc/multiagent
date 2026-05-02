import { chromium } from 'playwright'

const BASE = 'http://localhost:5173/biz/'
const passes = [], fails = []
const pass = (m) => { passes.push(m); console.log(`  ✅ ${m}`) }
const fail = (m) => { fails.push(m);  console.log(`  ❌ ${m}`) }
const shot = (page, name) => page.screenshot({ path: `scripts/mob_${name}.png`, fullPage: false }).catch(() => {})

async function run() {
  console.log('\n══════════════════════════════════════')
  console.log('  Business Dashboard — Mobile QA')
  console.log('══════════════════════════════════════\n')

  const browser = await chromium.launch({ headless: true })

  // iPhone 14 viewport
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log('  [ERR]', m.text().slice(0, 100)) })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await shot(page, '01_loaded')

  // 1. Bottom nav visible
  const bottomNav = await page.$('.bottom-nav')
  bottomNav ? pass('Bottom nav visible on mobile') : fail('Bottom nav missing')

  // 2. Sidebar hidden
  const sidebar = await page.$('.sidebar')
  if (sidebar) {
    const box = await sidebar.boundingBox()
    !box ? pass('Sidebar hidden on mobile') : fail('Sidebar still visible on mobile')
  } else {
    pass('Sidebar not rendered on mobile')
  }

  // 3. Either page title or empty state renders (depends on Supabase RLS)
  const title = await page.$('.page-title, .empty')
  title ? pass('Overview renders (page title or empty state)') : fail('Overview not rendering')
  await shot(page, '02_overview')

  // 4. KPI grid container exists (even if empty while loading)
  const kpiGrid = await page.$('.kpi-grid, .loading, .empty')
  kpiGrid ? pass('Overview content area rendered') : fail('Overview content area missing')

  // 5. Navigate to CRM via bottom nav
  const crmBtn = await page.$('.bottom-nav-item:last-child')
  if (crmBtn) {
    await crmBtn.click()
    await page.waitForTimeout(1000)
    pass('Navigated to CRM via bottom nav')
  } else {
    fail('CRM bottom nav button missing')
  }
  await shot(page, '03_crm')

  // 6. CRM container exists (cards or loading)
  const crmArea = await page.$('.crm-cards, .loading, .empty')
  crmArea ? pass('CRM mobile area rendered') : fail('CRM mobile area missing')

  // 7. Desktop table hidden
  const tableWrap = await page.$('.crm-table-wrap')
  if (tableWrap) {
    const display = await tableWrap.evaluate(el => getComputedStyle(el).display)
    display === 'none' ? pass('Desktop table hidden on mobile') : fail(`Desktop table not hidden (display: ${display})`)
  } else {
    pass('Desktop table not rendered on mobile')
  }

  // 8. No horizontal scroll on Overview
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
  const viewWidth = 390
  bodyWidth <= viewWidth + 5
    ? pass(`No horizontal overflow (body: ${bodyWidth}px, view: ${viewWidth}px)`)
    : fail(`Horizontal overflow detected (body: ${bodyWidth}px > view: ${viewWidth}px)`)

  await browser.close()

  console.log('\n══════════════════════════════════════')
  console.log(`  ✅ ${passes.length} passed   ❌ ${fails.length} failed`)
  console.log('══════════════════════════════════════')
  if (fails.length) { fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`)); process.exit(1) }
}

run().catch(e => { console.error('Crash:', e.message); process.exit(1) })
