// The CrossFit Kids seed script is production tooling: these tests drive its
// REAL abort and dry-run paths in a child process (no DB is ever touched —
// the dry run exits before the first supabase call and the abort path exits
// before that), plus a few source-level pins on the non-destructive contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'seed-crossfit-kids-2026-08.mjs');
const src = readFileSync(SCRIPT, 'utf8');

// supabase.js is imported at the script's top level, so the child process
// needs stub env even for paths that never issue a query.
const stubEnv = {
  ...process.env,
  SUPABASE_URL: 'http://supabase.invalid',
  SUPABASE_SERVICE_KEY: 'stub-service-key',
};

function run(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('aborts with a clear message when CROSSFIT_KIDS_PHONE_NUMBER_ID is unset', () => {
  const env = { ...stubEnv };
  delete env.CROSSFIT_KIDS_PHONE_NUMBER_ID;
  const r = run(['--dry-run'], env);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('CROSSFIT_KIDS_PHONE_NUMBER_ID'));
  assert.ok(r.stderr.includes('ABORT'));
});

test('dry run validates the KB and prints the full plan without writing anything', () => {
  const r = run(['--dry-run'], { ...stubEnv, CROSSFIT_KIDS_PHONE_NUMBER_ID: '999000999000999' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('DRY RUN OK'));
  // the plan names every table it will touch and the coexistence settings
  assert.ok(r.stdout.includes('999000999000999'));
  assert.ok(r.stdout.includes('coexistence=true'));
  assert.ok(r.stdout.includes('coexistence_standdown_minutes=720'));
  assert.ok(r.stdout.includes('972528250088'));        // owner escalation (pilot: Diva)
  assert.ok(r.stdout.includes('trial_signup enabled'));
  assert.ok(r.stdout.includes('insert-only'));
  assert.ok(r.stdout.includes('destructive ops:   none'));
});

test('the KB itself passes schema validation (a broken row fails the dry run)', () => {
  // validateKb() runs inside the dry run — a duplicate/empty row would exit 1.
  // This pins the counts so a stray edit that drops rows is visible.
  const r = run(['--dry-run'], { ...stubEnv, CROSSFIT_KIDS_PHONE_NUMBER_ID: 'x1' });
  assert.equal(r.code, 0, r.stderr);
  const m = r.stdout.match(/knowledge_items:\s+(\d+) rows \((\d+) active, (\d+) pending/);
  assert.ok(m, 'plan should state KB counts');
  const [, total, active, pending] = m.map(Number);
  assert.equal(total, active + pending);
  assert.ok(active >= 15, `expected a substantive active KB, got ${active}`);
  assert.ok(pending >= 4, `expected the [לאישור דיוה] rows to be pending, got ${pending}`);
});

// ── Non-destructive contract (source pins) ───────────────────────────────────

test('the seed never deletes anything', () => {
  assert.ok(!src.includes('.delete('), 'seed must not contain delete calls');
});

test('KB inserts are guarded against rerun — existing questions are skipped, never overwritten', () => {
  // the guard reads existing questions and filters before the single insert
  assert.ok(/select\('question'\)/.test(src));
  assert.ok(/filter\(i => !have\.has\(i\.q\)\)/.test(src));
  assert.ok(!/knowledge_items'\)\s*\.update/.test(src), 'seed must not update knowledge_items');
});

test('a rerun without the token env var cannot blank a stored access token', () => {
  assert.ok(src.includes('...(ACCESS_TOKEN ? { wa_access_token: ACCESS_TOKEN } : {})'));
});

test('facts not found in the site content are marked [לאישור דיוה] and seeded inactive', () => {
  assert.ok(src.includes('[לאישור דיוה]'));
  // every pending row (final=false) sits under a documented gap; the price
  // rows must never be active without approval
  assert.ok(/כמה עולה החוג\?[\s\S]{0,200}false\)/.test(src));
  assert.ok(/מתי אימון הניסיון הקרוב\?[\s\S]{0,300}false\)/.test(src));
});
