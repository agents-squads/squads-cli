#!/bin/bash
set -e

PROJECT_ID="inspired-answer-481202-f6"
REGION="us-central1"
SERVICE_NAME="squads-telemetry"
TOPIC_ID="squads-cli-telemetry"
DATASET_ID="telemetry"
TABLE_ID="cli_events"

echo "=== Squads Telemetry Deployment ==="

# 1. Enable APIs
echo "[1/6] Enabling APIs..."
gcloud services enable \
    pubsub.googleapis.com \
    bigquery.googleapis.com \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    --project=$PROJECT_ID

# 2. Create Pub/Sub topic
echo "[2/6] Creating Pub/Sub topic..."
gcloud pubsub topics create $TOPIC_ID --project=$PROJECT_ID 2>/dev/null || echo "Topic exists"

# 3. Create BigQuery dataset
echo "[3/6] Creating BigQuery dataset..."
bq --project_id=$PROJECT_ID mk --dataset $DATASET_ID 2>/dev/null || echo "Dataset exists"

# 4. Create BigQuery table
echo "[4/6] Creating BigQuery table..."
bq --project_id=$PROJECT_ID mk --table $DATASET_ID.$TABLE_ID \
    event:STRING,timestamp:TIMESTAMP,anonymous_id:STRING,cli_version:STRING,properties:STRING,server_ts:TIMESTAMP,source:STRING \
    2>/dev/null || echo "Table exists"

# 5. Create Pub/Sub → BigQuery subscription
echo "[5/6] Creating BigQuery subscription..."
gcloud pubsub subscriptions create ${TOPIC_ID}-bq \
    --topic=$TOPIC_ID \
    --bigquery-table=$PROJECT_ID:$DATASET_ID.$TABLE_ID \
    --use-topic-schema=false \
    --write-metadata \
    --project=$PROJECT_ID 2>/dev/null || echo "Subscription exists"

# 6. Deploy Cloud Run
echo "[6/6] Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
    --source=. \
    --region=$REGION \
    --platform=managed \
    --allow-unauthenticated \
    --set-env-vars="GCP_PROJECT=$PROJECT_ID,PUBSUB_TOPIC=$TOPIC_ID" \
    --memory=256Mi \
    --min-instances=0 \
    --max-instances=5 \
    --project=$PROJECT_ID

# Get URL
URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --project=$PROJECT_ID --format='value(status.url)')

echo ""
echo "=== Deployment Complete ==="
echo "Endpoint: $URL/ping"
echo ""
echo "Test with:"
echo "  curl -X POST $URL/ping -H 'Content-Type: application/json' -d '{\"event\":\"test\"}'"
echo ""
echo "Update squads-cli telemetry URL:"
echo "  SQUADS_TELEMETRY_URL=$URL/ping"
