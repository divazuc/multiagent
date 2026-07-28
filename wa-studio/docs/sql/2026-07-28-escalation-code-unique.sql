-- One open escalation per short code, per business.
--
-- nextShortCode() scans the open rows and picks a free code, which is a
-- check-then-act: two escalations raised close together can both see the same
-- code as free, and if all 99 are taken the function falls back to reusing 1.
-- Either way two open rows share a code, and the correlation logic takes the
-- first match — so the representative's reply reaches the newer lead and the
-- older question becomes unanswerable by code.
--
-- A partial unique index makes that state impossible at the data layer instead
-- of relying on the scan being right. The insert fails, raiseEscalation's catch
-- returns null, and the lead simply gets today's escalation behaviour rather
-- than a promise nobody can keep.
begin;

create unique index if not exists escalations_open_code_uniq
  on escalations (business_id, short_code)
  where status = 'open';

commit;
