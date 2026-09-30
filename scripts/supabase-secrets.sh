#!/usr/bin/env bash
# Store the server-side secrets of the VietNote credit backend.
# - SONIOX_API_KEY and OPENROUTER_API_KEY come from the Keychain entries the
#   app used before keys moved to the server.
# - CRON_SECRET is generated, set on the Edge Functions and mirrored into Vault,
#   where the pg_cron reconcile job reads it.
# No secret is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${SUPABASE_PROJECT_REF:-pyknksfyqlsfqodcsawm}"

SONIOX_KEY="$(security find-generic-password -s local.vietnote.desktop -a soniox-asr-api-key -w)"
OPENROUTER_KEY="$(security find-generic-password -s local.vietnote.desktop -a openrouter-api-key -w)"
CRON_SECRET="$(openssl rand -hex 24)"

npx supabase secrets set --project-ref "$REF" SONIOX_API_KEY="$SONIOX_KEY" OPENROUTER_API_KEY="$OPENROUTER_KEY" CRON_SECRET="$CRON_SECRET" >/dev/null
npx supabase db query --linked --project-ref "$REF" \
  "select vault.update_secret(id, '$CRON_SECRET') from vault.secrets where name = 'cron_secret';
   select vault.create_secret('$CRON_SECRET', 'cron_secret') where not exists (select 1 from vault.secrets where name = 'cron_secret');" >/dev/null
echo "Secrets set: $(npx supabase secrets list --project-ref "$REF" 2>/dev/null | grep -oE 'SONIOX_API_KEY|OPENROUTER_API_KEY|CRON_SECRET' | tr '\n' ' ')"
