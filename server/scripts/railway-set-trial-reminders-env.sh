#!/usr/bin/env bash
# One-time: set the trial-reminder env on Railway (wa-agent).
# Run from anywhere:
#   bash "Multi agent/server/scripts/railway-set-trial-reminders-env.sh"
#
# SECURITY: this repo is PUBLIC — no secret may ever appear in a tracked file.
# Values are read at runtime from the booster's git-ignored .env.local (the
# same convention as railway-set-meeting-env.sh) or generated on the spot:
#
#   GOOGLE_REFRESH_TOKEN_DIVAZUC  ← booster .env.local (the divazuc Google
#                                   account that owns the registration sheets)
#   CRON_SECRET                   ← generated here (openssl rand) — also print
#                                   it so the external cron job can be armed
#                                   with the same bearer
#
# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are ALREADY on Railway for the
# calendar module (lib/modules/calendar/google.js uses the same Google Cloud
# app) — this script checks and only fills them from the booster env if they
# are genuinely missing. Every variable already present on Railway is left
# untouched, so reruns never rotate a live secret.
set -euo pipefail

BOOSTER_ENV="${BOOSTER_ENV:-C:/Users/Diva/Documents/Web Projects/AI Playground/divaz_booster/divaz_booster/.env.local}"

# Accept both "KEY=value" and "# KEY=value" (the booster keeps some commented).
read_env() {
  grep -E "^#? ?$1=" "$BOOSTER_ENV" | tail -1 | sed -E "s/^#? ?$1=//" | tr -d '\r" '
}

CURRENT="$(railway variables --service wa-agent)"
have() { echo "$CURRENT" | grep -q "$1"; }

SET_ARGS=()

# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — expected present (calendar module).
for KEY in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  if have "$KEY"; then
    echo "skip: $KEY already on Railway"
  else
    VAL="$(read_env "$KEY")"
    if [ -z "$VAL" ]; then
      echo "ERROR: $KEY missing on Railway AND not found in $BOOSTER_ENV" >&2
      exit 1
    fi
    SET_ARGS+=(--set "$KEY=$VAL")
  fi
done

# The divazuc refresh token — new to the bot service, lives in the booster env.
if have GOOGLE_REFRESH_TOKEN_DIVAZUC; then
  echo "skip: GOOGLE_REFRESH_TOKEN_DIVAZUC already on Railway"
else
  TOKEN="$(read_env GOOGLE_REFRESH_TOKEN_DIVAZUC)"
  if [ -z "$TOKEN" ]; then
    echo "ERROR: GOOGLE_REFRESH_TOKEN_DIVAZUC not found in $BOOSTER_ENV" >&2
    exit 1
  fi
  SET_ARGS+=(--set "GOOGLE_REFRESH_TOKEN_DIVAZUC=$TOKEN")
fi

# CRON_SECRET — generated once; the same bearer goes into the external cron job.
if have CRON_SECRET; then
  echo "skip: CRON_SECRET already on Railway (reuse it when arming the cron job)"
else
  CRON_SECRET="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-43)"
  SET_ARGS+=(--set "CRON_SECRET=$CRON_SECRET")
  echo "generated CRON_SECRET (copy into the external cron job's Authorization: Bearer …):"
  echo "  $CRON_SECRET"
fi

if [ ${#SET_ARGS[@]} -eq 0 ]; then
  echo "OK — nothing to set, everything already on Railway."
else
  railway variables --service wa-agent "${SET_ARGS[@]}" > /dev/null
  echo "OK — set."
fi

echo "Present on Railway now:"
railway variables --service wa-agent | grep -oE "GOOGLE_[A-Z_]+|CRON_SECRET|WHATSAPP_TRIAL_REMINDER_TEMPLATE" | sort -u

echo
echo "REMINDERS:"
echo "  1. arm an external cron: POST https://wagent.divdev.co/cron/trial-reminders"
echo "     daily 09:00 Asia/Jerusalem, header 'Authorization: Bearer <CRON_SECRET>'"
echo "  2. after Meta approves trial_reminder_he (scripts/create-trial-reminder-template.mjs):"
echo "     railway variables --service wa-agent --set WHATSAPP_TRIAL_REMINDER_TEMPLATE=trial_reminder_he"
