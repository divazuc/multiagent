#!/usr/bin/env bash
# Probe what an unauthenticated visitor can read via the publishable key.
# Run before and after applying RLS migrations to verify the difference.
#
# Usage: ./wa-studio/scripts/probe-rls.sh
#
# Reads wa-studio/.env.local for VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
# (must be the sb_publishable_* key, NOT service_role — that would defeat
# the point of the probe).

set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env.local"
URL=$(grep '^VITE_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
KEY=$(grep '^VITE_SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2-)

if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in $ENV_FILE" >&2
  exit 1
fi

# Refuse to run if the key is a service_role JWT (would invalidate the probe)
PAYLOAD=$(echo "$KEY" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null || true)
if echo "$PAYLOAD" | grep -q 'service_role'; then
  echo "ERROR: VITE_SUPABASE_ANON_KEY decoded to service_role — refusing to probe with it." >&2
  echo "       Move the service_role key out of any VITE_-prefixed variable." >&2
  exit 1
fi

probe() {
  local target=$1
  local count status
  count=$(curl -sI \
    -H "apikey: $KEY" \
    -H "Authorization: Bearer $KEY" \
    -H "Range-Unit: items" \
    -H "Prefer: count=exact" \
    "$URL/rest/v1/$target?select=*&limit=0" \
    | grep -i 'content-range' | tr -d '\r' | awk -F'/' '{print $2}')
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $KEY" \
    -H "Authorization: Bearer $KEY" \
    "$URL/rest/v1/$target?select=*&limit=0")
  printf "  %-28s  HTTP=%s  rows_visible=%s\n" "$target" "$status" "${count:-?}"
}

echo "Probing $URL (anon role via publishable key)"
echo ""
echo "=== Tables originally RLS-DISABLED (expect rows_visible=0 after fix) ==="
for t in admin_sessions automation_logs business_config business_persona \
         business_usage_daily business_usage_monthly chat_sessions contacts \
         external_leads_sources lead_followups messages prod_conversations \
         prod_messages wa_billing_events webhook_logs; do
  probe "$t"
done

echo ""
echo "=== Tables originally RLS-ENABLED (still leak until policies tightened) ==="
for t in agent_runs business_profiles businesses conversation_messages \
         knowledge_items sessions setup_drafts; do
  probe "$t"
done

echo ""
echo "=== Views (conversations should return HTTP 401 after fix) ==="
for v in conversations; do
  probe "$v"
done

echo ""
echo "Done. Compare against the snapshot in"
echo "  wa-studio/docs/sql/2026-05-20-rls-security-findings.md"
