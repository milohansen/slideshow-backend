# Deploy script for Google Cloud Run
#!/bin/bash

set -e

# Check if PROJECT_ID is set
if [ -z "$PROJECT_ID" ]; then
    echo "Error: PROJECT_ID environment variable is not set"
    echo "Usage: export PROJECT_ID=<your-gcp-project-id> && ./deploy.sh"
    exit 1
fi

# Variables
SERVICE_NAME="slideshow-backend"
REGION="us-central1"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "🚀 Deploying ${SERVICE_NAME} to Google Cloud Run"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo ""

# Build and push image using Cloud Build
echo "📦 Building container image..."
gcloud builds submit --tag ${IMAGE_NAME}

# Deploy to Cloud Run
echo "🌐 Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME} \
  --region ${REGION} \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10 \
  --timeout 300 \
  --set-env-vars="DENO_ENV=production"

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)')

echo ""
echo "✅ Deployment complete!"
echo "🌍 Service URL: ${SERVICE_URL}"
echo "🔍 Health check: ${SERVICE_URL}/_health"
echo ""
echo "To view logs:"
echo "  gcloud logs tail --service=${SERVICE_NAME}"
