# Google Cloud Run Configuration

## Quick Deploy

```bash
export PROJECT_ID=your-gcp-project-id
./deploy.sh
```

## Manual Deployment Steps

### 1. Enable Required APIs

```bash
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### 2. Build and Deploy

Using Cloud Build:
```bash
gcloud builds submit --config cloudbuild.yaml
```

Or direct deployment:
```bash
gcloud run deploy slideshow-backend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10
```

### 3. Verify Deployment

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe slideshow-backend --region us-central1 --format 'value(status.url)')

# Check health endpoint
curl ${SERVICE_URL}/_health

# Access the UI
open ${SERVICE_URL}/ui
```

## Configuration

### Environment Variables

```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --set-env-vars="DENO_ENV=production,LOG_LEVEL=info"
```

### Memory and CPU

Adjust based on your workload:
```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --memory 1Gi \
  --cpu 2
```

### Scaling

Configure autoscaling:
```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 80
```

## Persistent Storage

Cloud Run is stateless. For persistent data:

### Option 1: Cloud Storage (Recommended)

Mount a Cloud Storage bucket:
```bash
# Create bucket
gsutil mb gs://${PROJECT_ID}-slideshow-data

# Update service to mount bucket
gcloud run services update slideshow-backend \
  --region us-central1 \
  --execution-environment gen2 \
  --add-volume=name=images,type=cloud-storage,bucket=${PROJECT_ID}-slideshow-data \
  --add-volume-mount=volume=images,mount-path=/app/data
```

### Option 2: Cloud SQL

For SQLite replacement with managed PostgreSQL:
```bash
# Create Cloud SQL instance
gcloud sql instances create slideshow-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1

# Connect from Cloud Run
gcloud run services update slideshow-backend \
  --region us-central1 \
  --add-cloudsql-instances ${PROJECT_ID}:us-central1:slideshow-db \
  --set-env-vars="DATABASE_URL=postgresql://..."
```

## Monitoring

### View Logs

```bash
# Tail logs
gcloud logs tail --service=slideshow-backend

# Filter by severity
gcloud logs read "resource.type=cloud_run_revision AND resource.labels.service_name=slideshow-backend" \
  --limit 50 \
  --format json
```

### Metrics

View metrics in Cloud Console:
- Request count and latency
- Container CPU and memory usage
- Billable instance time
- Error rate

### Alerting

Create alerts for:
- High error rate
- Slow response times
- High memory usage

## Security

### Restrict Access

Remove public access and require authentication:
```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --no-allow-unauthenticated
```

### IAM Policies

Grant specific users/services access:
```bash
gcloud run services add-iam-policy-binding slideshow-backend \
  --region us-central1 \
  --member="user:example@gmail.com" \
  --role="roles/run.invoker"
```

### Custom Domains

Map a custom domain:
```bash
gcloud run domain-mappings create \
  --service slideshow-backend \
  --domain slideshow.example.com \
  --region us-central1
```

## Cost Optimization

- Use `--min-instances 0` to scale to zero when idle
- Set appropriate memory limits (512Mi is usually sufficient)
- Use Cloud Storage for images instead of container storage
- Monitor billable instance time in Cloud Console

## Troubleshooting

### Container fails to start

Check logs:
```bash
gcloud logs read "resource.type=cloud_run_revision AND resource.labels.service_name=slideshow-backend" \
  --limit 10 \
  --format json
```

### Out of memory

Increase memory allocation:
```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --memory 1Gi
```

### Slow cold starts

Use minimum instances:
```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --min-instances 1
```

## CI/CD Integration

### GitHub Actions

Add to `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: google-github-actions/auth@v1
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}
      
      - uses: google-github-actions/setup-gcloud@v1
      
      - name: Deploy to Cloud Run
        run: |
          gcloud builds submit --config cloudbuild.yaml
```

### Cloud Build Triggers

Set up automatic deployments on git push:
```bash
gcloud builds triggers create github \
  --repo-name=slideshow-backend \
  --repo-owner=your-github-username \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```
