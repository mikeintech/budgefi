#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${BACKEND_IMAGE:?Set BACKEND_IMAGE to the immutable backend image URI}"
: "${SCHEDULER_SERVICE_ACCOUNT:?Set SCHEDULER_SERVICE_ACCOUNT}"
: "${PLAID_ACTIVE_TOKEN_KEY_ID:?Set PLAID_ACTIVE_TOKEN_KEY_ID to the active key in plaid-token-keys}"

GCP_REGION="${GCP_REGION:-us-east4}"
PLAID_JOB_NAME="${PLAID_JOB_NAME:-budgefi-plaid-sync}"
PLAID_SCHEDULE="${PLAID_SCHEDULE:-*/2 * * * *}"

# Secrets are referenced, never read or printed by this script. The database
# login behind plaid-worker-database-url must be a member of budgefi_app and
# budgefi_plaid_worker, and must not own the database or bypass RLS.
gcloud run jobs deploy "${PLAID_JOB_NAME}" \
  --project "${GCP_PROJECT}" \
  --region "${GCP_REGION}" \
  --image "${BACKEND_IMAGE}" \
  --command node \
  --args dist-backend/apps/plaid-worker/src/main.js \
  --set-env-vars NODE_ENV=production,PLAID_ENABLED=true,PLAID_ENV=production,BUDGEFI_PROCESS_ROLE=plaid-worker,PLAID_ACTIVE_TOKEN_KEY_ID="${PLAID_ACTIVE_TOKEN_KEY_ID}" \
  --set-secrets PLAID_WORKER_DATABASE_URL=plaid-worker-database-url:latest,PLAID_CLIENT_ID=plaid-client-id:latest,PLAID_SECRET=plaid-secret:latest,PLAID_TOKEN_KEYS=plaid-token-keys:latest \
  --max-retries 1 \
  --task-timeout 300s \
  --memory 512Mi \
  --cpu 1

JOB_URI="https://${GCP_REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${GCP_PROJECT}/jobs/${PLAID_JOB_NAME}:run"
if gcloud scheduler jobs describe "${PLAID_JOB_NAME}-every-2m" --project "${GCP_PROJECT}" --location "${GCP_REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${PLAID_JOB_NAME}-every-2m" \
    --project "${GCP_PROJECT}" --location "${GCP_REGION}" \
    --schedule "${PLAID_SCHEDULE}" --uri "${JOB_URI}" --http-method POST \
    --oauth-service-account-email "${SCHEDULER_SERVICE_ACCOUNT}"
else
  gcloud scheduler jobs create http "${PLAID_JOB_NAME}-every-2m" \
    --project "${GCP_PROJECT}" --location "${GCP_REGION}" \
    --schedule "${PLAID_SCHEDULE}" --uri "${JOB_URI}" --http-method POST \
    --oauth-service-account-email "${SCHEDULER_SERVICE_ACCOUNT}"
fi
