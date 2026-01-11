# Migration to Cloud Run Jobs Architecture

This document explains the migration from local worker threads to Cloud Run Jobs for image processing.

## Architecture Overview

### Before (Worker Queue)

```
Backend Service (Cloud Run)
├── Web Server (Hono)
├── SQLite Database
├── Worker Queue Manager
│   └── Web Workers (4 concurrent)
│       └── ImageMagick processing
└── GCS Storage
```

**Issues:**
- Workers don't work reliably in Cloud Run containers
- Shared 512Mi memory between web server and processing
- Idle costs when no images to process
- Limited to 4 concurrent operations

### After (Cloud Run Jobs)

```
Backend Service (Cloud Run)          Processor Job (Cloud Run Jobs)
├── Web Server (Hono)                ├── Task Sharding (10 parallel)
├── SQLite Database                  ├── Sharp Processing
├── Job Queue Manager ────trigger───>├── Color Extraction
├── Metadata Sync Service            └── GCS Upload/Download
└── Processing API Endpoints         
    └── GCS Storage (shared)
```

**Benefits:**
- No idle costs (jobs only run when needed)
- 2Gi RAM per task (20Gi total across 10 tasks)
- Process 50 images in parallel
- Independent task retries on failure
- Sharp is 4-5x faster than ImageMagick

## New Components

### Backend Changes

#### 1. Processing API Routes ([routes/processing.ts](slideshow-backend/src/routes/processing.ts))

Endpoints for processor coordination:

- `GET /api/processing/pending` - Returns up to 50 images to process
- `POST /api/processing-attempts/:imageId/start` - Registers attempt, returns device list
- `POST /api/processed-images` - Accepts batch of processed results
- `PATCH /api/images/:id/failed` - Marks image as failed

**Authentication:** Bearer token via `PROCESSOR_AUTH_TOKEN` env var

#### 2. Job Queue Service ([services/job-queue.ts](slideshow-backend/src/services/job-queue.ts))

Replaces [worker-queue.ts](slideshow-backend/src/services/worker-queue.ts):

- Accumulates pending images in memory buffer
- Triggers Cloud Run Job when buffer reaches 50 images OR 30 seconds elapsed
- Uses `@google-cloud/run` npm package to execute jobs

**Configuration:**
```env
GCP_PROJECT_ID=your-project
GCP_REGION=us-central1
PROCESSOR_JOB_NAME=slideshow-processor
PROCESSOR_AUTH_TOKEN=your-secret-token
BACKEND_API_URL=https://your-backend.run.app
```

#### 3. Metadata Sync Service ([services/metadata-sync.ts](slideshow-backend/src/services/metadata-sync.ts))

Polls GCS for metadata JSON files written by processor:

- Runs every 60 seconds
- Imports missing `processed_images` records (backup if API calls fail)
- Archives completed metadata to `images/metadata/archive/{year}/{month}/`
- Configures GCS lifecycle policy for 30-day auto-deletion

### Processor App

New repository: `/slideshow-processor`

- [main.ts](slideshow-processor/main.ts) - Task sharding and batch coordination
- [processor.ts](slideshow-processor/processor.ts) - Sharp processing and color extraction
- [Dockerfile](slideshow-processor/Dockerfile) - Multi-stage build with sharp native bindings
- [cloudbuild.yaml](slideshow-processor/cloudbuild.yaml) - Cloud Build configuration

## Deployment Steps

### 1. Create Processor Service Account

```bash
export PROJECT_ID=$(gcloud config get-value project)

# Create service account
gcloud iam service-accounts create image-processor \
  --display-name="Slideshow Image Processor"

# Grant GCS access
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:image-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### 2. Generate Authentication Token

```bash
# Generate a secure token
openssl rand -base64 32

# Store in Secret Manager
gcloud secrets create processor-auth-token \
  --data-file=- <<< "YOUR_GENERATED_TOKEN"

# Grant access to both backend and processor
gcloud secrets add-iam-policy-binding processor-auth-token \
  --member="serviceAccount:image-processor@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding processor-auth-token \
  --member="serviceAccount:YOUR-BACKEND-SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Deploy Processor Job

```bash
cd /slideshow-processor

# Configure substitutions in cloudbuild.yaml or pass via CLI
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=\
_GCS_BUCKET_NAME=your-slideshow-bucket,\
_BACKEND_API_URL=https://your-backend-xyz.run.app,\
_BACKEND_AUTH_SECRET=projects/$PROJECT_ID/secrets/processor-auth-token/versions/latest,\
_SERVICE_ACCOUNT=image-processor@$PROJECT_ID.iam.gserviceaccount.com
```

### 4. Update Backend Configuration

Add to backend Cloud Run service environment:

```bash
gcloud run services update slideshow-backend \
  --region=us-central1 \
  --set-env-vars=\
GCP_PROJECT_ID=$PROJECT_ID,\
GCP_REGION=us-central1,\
PROCESSOR_JOB_NAME=slideshow-processor,\
BACKEND_API_URL=https://your-backend-xyz.run.app \
  --set-secrets=PROCESSOR_AUTH_TOKEN=processor-auth-token:latest
```

### 5. Grant Backend Permission to Trigger Jobs

```bash
# Allow backend service account to execute processor job
gcloud run jobs add-iam-policy-binding slideshow-processor \
  --region=us-central1 \
  --member="serviceAccount:YOUR-BACKEND-SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

### 6. Deploy Updated Backend

```bash
cd /slideshow-backend

# Build and deploy with new dependencies
gcloud builds submit --config cloudbuild.yaml
```

## Testing

### 1. Verify Configuration

Check backend logs for initialization:

```bash
gcloud run services logs read slideshow-backend --region=us-central1 --limit=50
```

Expected output:
```
✅ Job queue manager initialized
✅ Metadata sync service initialized
```

### 2. Upload Test Image

Via UI or API:

```bash
curl -X POST https://your-backend.run.app/api/admin/upload \
  -H "Cookie: session_id=YOUR_SESSION" \
  -F "file=@test-image.jpg"
```

### 3. Check Job Execution

```bash
# List recent executions
gcloud run jobs executions list \
  --job=slideshow-processor \
  --region=us-central1 \
  --limit=5

# View logs for specific execution
gcloud run jobs executions logs YOUR-EXECUTION-ID \
  --region=us-central1
```

### 4. Verify Results

Check database:

```bash
sqlite3 slideshow.db "SELECT id, processing_status FROM images LIMIT 5;"
sqlite3 slideshow.db "SELECT image_id, device_size FROM processed_images LIMIT 10;"
```

Check GCS:

```bash
gsutil ls gs://your-bucket/processed/
gsutil ls gs://your-bucket/images/metadata/
```

## Monitoring

### Backend Metrics

- **Pending images**: `GET /api/processing/pending` should return fewer than 50
- **Queue status**: Check logs for `[JobQueue]` entries
- **Metadata sync**: Look for `🔄 Syncing N metadata files` every 60s

### Processor Metrics

- **Execution time**: Should be < 5 minutes for 50 images
- **Task failures**: Check Cloud Console > Cloud Run > Jobs > slideshow-processor
- **Retry attempts**: Look for `CLOUD_RUN_TASK_ATTEMPT > 0` in logs

### Alerting

Set up Cloud Monitoring alerts:

```bash
# Alert on job failures
gcloud alpha monitoring policies create \
  --notification-channels=YOUR_CHANNEL \
  --display-name="Processor Job Failures" \
  --condition-display-name="Failed executions" \
  --condition-filter='resource.type="cloud_run_job" AND resource.labels.job_name="slideshow-processor" AND metric.type="run.googleapis.com/job/completed_execution_count" AND metric.labels.result="failed"' \
  --condition-threshold-value=1 \
  --condition-threshold-duration=60s
```

## Rollback Plan

If issues occur, rollback to worker queue:

### 1. Revert Backend Code

```bash
cd /slideshow-backend
git revert HEAD  # Or checkout previous commit
gcloud builds submit --config cloudbuild.yaml
```

### 2. Update Image Ingestion

Change imports back to `worker-queue.ts`:

```typescript
import { queueImageProcessing } from "./services/worker-queue.ts";
```

### 3. Re-enable Workers

Uncomment worker initialization in `main.ts` (if commented out)

### 4. Reprocess Pending Images

```bash
# Mark processing images as pending
sqlite3 slideshow.db "UPDATE images SET processing_status='pending' WHERE processing_status='processing';"

# Restart backend to trigger reprocessing
gcloud run services update slideshow-backend --region=us-central1
```

## Troubleshooting

### Job not triggering

**Check backend logs:**
```bash
gcloud run services logs read slideshow-backend --region=us-central1 | grep "JobQueue"
```

**Verify IAM permissions:**
```bash
gcloud run jobs get-iam-policy slideshow-processor --region=us-central1
```

### Authentication errors

**Verify token matches:**
```bash
# Backend token
gcloud run services describe slideshow-backend --region=us-central1 --format="value(spec.template.spec.containers[0].env[?name=='PROCESSOR_AUTH_TOKEN'].valueFrom.secretKeyRef.name)"

# Processor token
gcloud run jobs describe slideshow-processor --region=us-central1 --format="value(spec.template.spec.containers[0].env[?name=='BACKEND_AUTH_TOKEN'].valueFrom.secretKeyRef.name)"
```

### Metadata not syncing

**Check GCS bucket:**
```bash
gsutil ls -r gs://your-bucket/images/metadata/
```

**Check backend logs:**
```bash
gcloud run services logs read slideshow-backend --region=us-central1 | grep "Metadata sync"
```

### Images stuck in "processing"

**Manually reset:**
```bash
sqlite3 slideshow.db "UPDATE images SET processing_status='pending' WHERE processing_status='processing';"
```

**Trigger job manually:**
```bash
gcloud run jobs execute slideshow-processor --region=us-central1
```

## Cost Analysis

### Before (Worker Queue in Cloud Run Service)

- Service runs 24/7 even when idle
- 512Mi memory instance @ $0.00001800/GiB-second
- Average 30% CPU utilization for processing
- **Estimated**: $15-25/month for service + processing

### After (Cloud Run Jobs)

- Backend service: 512Mi @ $0.00001800/GiB-second (idle 90% of time)
- Jobs: 2Gi x 10 tasks x ~5 minutes/day @ $0.00002400/GiB-second
- **Estimated**: $5-10/month for backend + $2-5/month for jobs
- **Savings**: ~40-60% cost reduction

### Optimization Tips

1. **Reduce batch size** if processing < 20 images/day (lowers job startup overhead)
2. **Increase flush delay** to 60s if images can wait longer
3. **Scale down to 5 tasks** if processing < 25 images per batch

## Migration Checklist

- [ ] Create processor service account
- [ ] Generate and store authentication token
- [ ] Deploy processor job via Cloud Build
- [ ] Update backend environment variables
- [ ] Grant backend permission to trigger jobs
- [ ] Deploy updated backend
- [ ] Test with sample image upload
- [ ] Verify job execution in Cloud Console
- [ ] Check processed images in GCS
- [ ] Confirm database records created
- [ ] Set up monitoring alerts
- [ ] Document rollback procedure for team

## Additional Resources

- [Cloud Run Jobs Documentation](https://cloud.google.com/run/docs/create-jobs)
- [Sharp Documentation](https://sharp.pixelplumbing.com/)
- [Material Color Utilities](https://github.com/material-foundation/material-color-utilities)
- [Processor README](slideshow-processor/README.md)
