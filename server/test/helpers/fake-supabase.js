// Minimal in-memory supabase-js stand-in for the query chains this codebase
// actually uses: from().select().eq()…, update().eq()…[.select()], insert(),
// order(), limit(), maybeSingle(). Enough to run the REAL store code
// (lib/coexistence.js#_realDbWith, lib/context.js#_setSupabaseForTest) against
// both the pre- and post-migration sessions schema.
//
// Not a test file — lives under helpers/ so the `test/**/*.test.js` glob
// skips it.
//
// Options:
//   tables          { name: [row, ...] } — the store (mutated in place).
//   uniques         { name: [ [col, ...], ... ] } — unique key-sets enforced
//                   on insert. Model pre-migration sessions with
//                   [['session_id']], post-migration with
//                   [['session_id', 'business_id']].
//   missingColumns  { name: [col, ...] } — selecting/filtering/patching these
//                   columns errors like a live pre-migration schema would
//                   ('column X does not exist').
//
// The instance exposes `log` — every executed op as { table, op, filters,
// patch?, rows? } — so tests can assert "nothing wrote to sessions" directly.

export function fakeSupabase({ tables = {}, uniques = {}, missingColumns = {} } = {}) {
  const log = [];

  const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

  function missingCol(table, referenced) {
    const missing = missingColumns[table] ?? [];
    return referenced.find((c) => missing.includes(c)) ?? null;
  }

  function colsInSelect(sel) {
    if (!sel || sel === '*') return [];
    return String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  }

  function makeBuilder(table) {
    const b = {
      _op: 'select', _select: '*', _filters: [], _order: null, _limit: null,
      _patch: null, _insertRows: null, _selectAfterWrite: null, _single: false,

      select(cols = '*') {
        if (this._op === 'select') this._select = cols;
        else this._selectAfterWrite = cols;
        return this;
      },
      eq(col, val) { this._filters.push([col, val]); return this; },
      order(col, opts = {}) { this._order = { col, asc: opts.ascending !== false }; return this; },
      limit(n) { this._limit = n; return this; },
      update(patch) { this._op = 'update'; this._patch = patch; return this; },
      insert(rows) { this._op = 'insert'; this._insertRows = Array.isArray(rows) ? rows : [rows]; return this; },
      upsert() { throw new Error(`fake-supabase: upsert on ${table} is unsupported on purpose — convert the caller to update-then-insert`); },
      maybeSingle() { this._single = true; return this; },

      then(resolve, reject) { return Promise.resolve().then(() => this._exec()).then(resolve, reject); },

      _rows() { return (tables[table] ??= []); },

      _matches(row) { return this._filters.every(([c, v]) => row[c] === v); },

      _exec() {
        const err = (message) => ({ data: null, error: { message } });

        // Simulate a schema that does not have some column yet.
        const referenced = [
          ...this._filters.map(([c]) => c),
          ...(this._patch ? Object.keys(this._patch) : []),
          ...(this._op === 'select' ? colsInSelect(this._select) : []),
        ];
        const bad = missingCol(table, referenced);
        if (bad) return err(`column ${table}.${bad} does not exist`);

        if (this._op === 'select') {
          log.push({ table, op: 'select', filters: [...this._filters] });
          let rows = this._rows().filter((r) => this._matches(r));
          if (this._order) {
            const { col, asc } = this._order;
            rows = [...rows].sort((a, b) => {
              const av = a[col] ?? '', bv = b[col] ?? '';
              return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
            });
          }
          if (this._limit != null) rows = rows.slice(0, this._limit);
          if (this._single) {
            if (rows.length > 1) return err(`multiple (or no) rows returned for maybeSingle on ${table}`);
            return { data: clone(rows[0] ?? null), error: null };
          }
          return { data: clone(rows), error: null };
        }

        if (this._op === 'update') {
          log.push({ table, op: 'update', filters: [...this._filters], patch: clone(this._patch) });
          const hit = this._rows().filter((r) => this._matches(r));
          for (const row of hit) Object.assign(row, this._patch);
          if (this._selectAfterWrite != null) {
            if (this._single) {
              if (hit.length > 1) return err(`multiple rows returned for maybeSingle on ${table}`);
              return { data: clone(hit[0] ?? null), error: null };
            }
            return { data: clone(hit), error: null };
          }
          return { data: null, error: null };
        }

        if (this._op === 'insert') {
          log.push({ table, op: 'insert', rows: clone(this._insertRows) });
          for (const keySet of uniques[table] ?? []) {
            for (const row of this._insertRows) {
              const dup = this._rows().find((r) => keySet.every((k) => (r[k] ?? null) === (row[k] ?? null)));
              if (dup) {
                return err(`duplicate key value violates unique constraint "${table}_${keySet.join('_')}_key"`);
              }
            }
          }
          for (const row of this._insertRows) this._rows().push(clone(row));
          if (this._selectAfterWrite != null) {
            const data = clone(this._insertRows);
            return { data: this._single ? data[0] ?? null : data, error: null };
          }
          return { data: null, error: null };
        }

        throw new Error(`fake-supabase: unsupported op ${this._op}`);
      },
    };
    return b;
  }

  return {
    log,
    tables,
    from(table) { return makeBuilder(table); },
  };
}
