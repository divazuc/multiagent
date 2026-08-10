#!/usr/bin/env bash
# One-time: set the Telegram meeting-approval env on Railway (wa-agent).
# Run from anywhere:
#   bash "Multi agent/server/scripts/railway-set-meeting-env.sh"
#
# SECURITY: this repo is PUBLIC — no secret may ever appear in a tracked file.
# The Telegram credentials are read at runtime from the booster's git-ignored
# .env.local (where they already live, possibly as commented-out lines).
#
# PUBLIC_BASE_URL is the bot's own public origin (the links in the Telegram
# message point back at it) — the same domain the code already falls back to
# (lib/modules/calendar/google.js / lib/meeting-approval.js). Not a secret.
# With any of these unset the code degrades gracefully to the pre-Telegram
# WhatsApp owner notify — nothing breaks, the one-tap links just don't exist.
set -euo pipefail

BOOSTER_ENV="${BOOSTER_ENV:-C:/Users/Diva/Documents/Web Projects/AI Playground/divaz_booster/divaz_booster/.env.local}"

# Accept both "KEY=value" and "# KEY=value" (the booster keeps them commented).
read_env() {
  grep -E "^#? ?$1=" "$BOOSTER_ENV" | tail -1 | sed -E "s/^#? ?$1=//" | tr -d '\r" '
}

TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
CHAT_ID="$(read_env TELEGRAM_CHAT_ID)"
if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not found in $BOOSTER_ENV" >&2
  exit 1
fi

railway variables --service wa-agent \
  --set "TELEGRAM_BOT_TOKEN=$TOKEN" \
  --set "TELEGRAM_CHAT_ID=$CHAT_ID" \
  --set "PUBLIC_BASE_URL=https://wagent.divdev.co" > /dev/null

echo "OK — set. Present on Railway now:"
railway variables --service wa-agent | grep -oE "TELEGRAM_[A-Z_]+|PUBLIC_BASE_URL" | sort -u
