#!/usr/bin/env bash
# Writes the app-side environment for an ephemeral preview. Shared by
# .github/workflows/preview.yml and scripts/preview/local-preview.sh so the two
# previews cannot drift: both run the same app knobs, both refuse to reach
# production.
#
# Required: OUT (file to write), APP_URL, S3_URL
# Optional: CVC_KEY (missing => managed chat disabled, BYOK still works),
#           S3_INTERNAL_ENDPOINT (default http://rustfs:9000), S3_BUCKET (lobe)
#
# A fresh AUTH_SECRET / KEY_VAULTS_SECRET on every boot is deliberate: the
# database is throwaway, so stale sessions must not survive into a new boot.
set -euo pipefail
: "${OUT:?set OUT to the env file to write}"
: "${APP_URL:?set APP_URL to the URL the browser opens}"
: "${S3_URL:?set S3_URL to the object storage URL the browser reaches}"
CVC_KEY=${CVC_KEY:-}
S3_INTERNAL_ENDPOINT=${S3_INTERNAL_ENDPOINT:-http://rustfs:9000}
S3_BUCKET=${S3_BUCKET:-lobe}

AUTH_SECRET=$(openssl rand -hex 32)
KEY_VAULTS_SECRET=$(openssl rand -base64 32 | tr -d '\n')

cat > "$OUT" <<EOF
APP_URL=$APP_URL
AUTH_SECRET=$AUTH_SECRET
AUTH_EMAIL_VERIFICATION=0
AUTH_TRUSTED_ORIGINS=$APP_URL
AUTH_SSO_PROVIDERS=
# Only the one preview account may register. The sign-up form still exists, but
# any other email is rejected with EMAIL_NOT_ALLOWED, so nobody can create an
# account and spend the shared key.
AUTH_ALLOWED_EMAILS=${PREVIEW_EMAIL:-preview@panafor.com}
KEY_VAULTS_SECRET=$KEY_VAULTS_SECRET
INTERNAL_APP_URL=http://localhost:3210
S3_ENDPOINT=$S3_URL
S3_INTERNAL_ENDPOINT=$S3_INTERNAL_ENDPOINT
S3_BUCKET=$S3_BUCKET
S3_ENABLE_PATH_STYLE=1
S3_SET_ACL=0
AICO_MANAGED_PROVIDER=cheapvibecode
AICO_MANAGED_INFERENCE_KEY=shared
AICO_SHARED_INFERENCE_API_KEY=$CVC_KEY
CHEAPVIBECODE_BASE_URL=https://ru.cheapvibecode.ru
AICO_CVC_TOKENS_PER_USD=25000000
AICO_BILLING_LEDGER_MODE=enforce
# The preview key holds cents, not dollars: the production floor (1 USD)
# would refuse every request. 5000 = 0.005 USD of upstream float.
AICO_LEDGER_FLOAT_FLOOR_MICRO_USD=5000
AICO_CVC_RESIZE_IN_PLACE=1
# Fresh database: no synced model catalog, so Auto's built-in target
# (mimo-v2.6-pro) has no price and enforce mode refuses every Auto request.
# Point every slot at a model the bundled snapshot prices.
AICO_CVC_AUTO_ROUTE={"default":"glm-5.3-flash","reasoning":"grok-4.6","vision":"gpt-5.6-luna","visionTools":"gpt-5.6-terra"}
AICO_LLM_START_TIMEOUT_SECONDS=240
AICO_OPENROUTER_MOCK=0
AICO_INSECURE_AUTH_COOKIES=0
OPENROUTER_MANAGEMENT_API_KEY=
CHEAPVIBECODE_MANAGEMENT_API_KEY=
CHEAPVIBECODE_API_KEY=
EOF
