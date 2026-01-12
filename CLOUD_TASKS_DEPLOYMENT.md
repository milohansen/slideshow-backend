# Cloud Tasks Integration - Deployment Guide

## Overview
Migrated from Cloud Run Jobs batch processing to Cloud Tasks queue for per-image task management. Cloud Tasks triggers a Workflow that executes the processor job with `TARGET_FILE_ID` environment variable.

## Architecture

```
Backend → Cloud Tasks Queue → Workflow Execution API → Cloud Run Job (main-v2.ts)
   ↓                              ↓                            ↓
queueImageProcessing()    POST with file_id        Runs with TARGET_FILE_ID env var
```

## Changes Summary

### Backend (`slideshow-backend`)
- ✅ Added `@google-cloud/tasks` package (v5.5.0)
- ✅ Created `failed_tasks` table for tracking exhausted retries
- ✅ Replaced `JobQueueManager` with `CloudTaskQueue` - posts to Workflow endpoint
- ✅ Added `POST /api/processing/:imageId/failed` endpoint
- ✅ Updated environment variables in `cloudbuild.yaml`

### Processor (`slideshow-processor`)
- ✅ Updated `main-v2.ts` to read `TARGET_FILE_ID` environment variable
- ✅ Processor remains as Cloud Run Job (not HTTP service)
- ✅ Workflow passes image ID via environment variable
- ✅ Updated `cloudbuild.yaml` to deploy job with `main-v2.ts` entrypoint

## Deployment Steps

### 1. Create Cloud Tasks Queue

```bash
gcloud tasks queues create image-processing-queue \
  --location=northamerica-northeast1 \
  --max-dispatches-per-second=50 \
  --max-concurrent-dispatches=50 \
  --max-attempts=3 \
  --max-retry-duration=3600s
```

### 2. Verify Workflow Configuration

Your Workflow should:
- Accept `file_id` in the argument JSON
- Trigger `slideshow-processor` job with `TARGET_FILE_ID` environment variable
- Location: `northamerica-northeast1`
- Workflow name: `trigger-image-job`

**Workflow endpoint:**
```
https://workflowexecutions.googleapis.com/v1/projects/crafty-router-207406/locations/northamerica-northeast1/workflows/trigger-image-job/executions
```

### 3. Deploy Processor Job

**Before deploying**, update `cloudbuild.yaml` substitutions:

```yaml
substitutions:
  _GCS_BUCKET_NAME: 'your-actual-bucket-name'
  _BACKEND_API_URL: 'https://slideshow-backend-HASH-nn.a.run.app'
  _SERVICE_ACCOUNT: 'image-processor@YOUR_PROJECT_ID.iam.gserviceaccount.com'
```

Deploy:

```bash
cd slideshow-processor
gcloud builds submit --config=cloudbuild.yaml
```

**Note:** Job will be triggered by Workflow with `TARGET_FILE_ID` environment variable.

### 4. Update Backend Environment

Edit `slideshow-backend/cloudbuild.yaml` and update the `WORKFLOW_SERVICE_ACCOUNT`:

```yaml
--set-env-vars
- 'GCP_PROJECT_ID=$PROJECT_ID,...,WORKFLOW_URL=https://workflowexecutions.googleapis.com/v1/projects/crafty-router-207406/locations/northamerica-northeast1/workflows/trigger-image-job/executions,WORKFLOW_SERVICE_ACCOUNT=YOUR_SERVICE_ACCOUNT@crafty-router-207406.iam.gserviceaccount.com'
```

Deploy backend:

```bash
cd slideshow-backend
gcloud builds submit --config=cloudbuild.yaml
```

### 5. Configure IAM Permissions

**Grant backend permission to create tasks:**

```bash
gcloud projects add-iam-policy-binding crafty-router-207406 \
  --member="serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/cloudtasks.enqueuer"
```

**Grant Cloud Tasks permission to invoke Workflow:**

```bash
gcloud workflows add-iam-policy-binding trigger-image-job \
  --location=northamerica-northeast1 \
  --member="serviceAccount:service-YOUR_PROJECT_NUMBER@gcp-sa-cloudtasks.iam.gserviceaccount.com" \
  --role="roles/workflows.invoker"
```

**Grant Workflow permission to execute jobs:**

```bash
gcloud projects add-iam-policy-binding crafty-router-207406 \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@crafty-router-207406.iam.gserviceaccount.com" \
  --role="roles/run.developer"
```

### 6. Test the Integration

**Trigger an image upload or ingest:**

```bash
# Via admin API
curl -X POST https://slideshow-backend-HASH-nn.a.run.app/api/admin/upload \
  -H "Cookie: session=YOUR_SESSION" \
  -F "file=@test-image.jpg"
```

**Check task creation:**

```bash
gcloud tasks list --queue=image-processing-queue --location=northamerica-northeast1
```

**Check Workflow execution:**

```bash
gcloud workflows executions list trigger-image-job \
  --location=northamerica-northeast1 \
  --limit=10
```

**View processor job logs:**

```bash
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=slideshow-processor" \
  --limit=50 \
  --format=json
```

**Check failed tasks table:**

```bash
# Via backend CLI or direct database query
sqlite3 slideshow.db "SELECT * FROM failed_tasks ORDER BY created_at DESC LIMIT 10;"
```

## Configuration Reference

### Environment Variables

**Backend:**
- `GCP_PROJECT_ID` - GCP project ID (auto-set)
- `CLOUD_TASKS_QUEUE` - Queue name (default: `image-processing-queue`)
- `CLOUD_TASKS_LOCATION` - Queue region (default: `northamerica-northeast1`)
- `WORKFLOW_URL` - Workflow execution endpoint (**required**)
- `WORKFLOW_SERVICE_ACCOUNT` - Service account for OIDC token (**required**)

**Processor:**
- `TARGET_FILE_ID` - Image ID to process (**set by Workflow**)
- `GCS_BUCKET_NAME` - Storage bucket (**required**)
- `BACKEND_API_URL` - Backend API URL (**required**)
- `CLOUD_RUN_TASK_ATTEMPT` - Retry attempt number (auto-set by Cloud Run Jobs)

### Cloud Tasks Queue Settings

- **Rate limit:** 50 tasks/second
- **Max concurrent:** 50 executions
- **Max retries:** 3 attempts
- **Retry duration:** 3600s (1 hour)
- **Retry backoff:** Exponential (default)

### Cloud Run Job Settings (Processor)

- **Tasks:** 1 (single image per job execution)
- **Max retries:** 3 attempts
- **Task timeout:** 15 minutes
- **CPU:** 2 cores
- **Memory:** 2Gi
- **Command:** `deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main-v2.ts`

## Migration from Batch Processing

### Removed Components
- ❌ `CLOUD_RUN_TASK_INDEX` / `TASK_COUNT` (no sharding, single image per job)
- ❌ Batch fetching of 50 images
- ❌ In-memory `pendingImages` Set
- ❌ Flush timer and batching logic

### New Components
- ✅ Cloud Tasks queue with persistent storage
- ✅ Workflow-based job triggering
- ✅ `TARGET_FILE_ID` environment variable for single-image processing
- ✅ Per-image task creation (fine-grained retries)
- ✅ `failed_tasks` database table
- ✅ OIDC token authentication (automatic)

## Monitoring & Troubleshooting

### View Queue Metrics

```bash
# Queue depth
gcloud tasks queues describe image-processing-queue \
  --location=northamerica-northeast1

# Task list
gcloud tasks list --queue=image-processing-queue \
  --location=northamerica-northeast1 \
  --limit=20
```

### Check Failed Tasks

```sql
-- Via backend database
SELECT 
  image_id, 
  error_message, 
  attempt_count, 
  last_attempt 
FROM failed_tasks 
ORDER BY last_attempt DESC 
LIMIT 20;
```

### Processor Logs

```bash
gcloud logging read "resource.type=cloud_run_revision 
  AND resource.labels.service_name=slideshow-processor
  AND severity>=WARNING" \
  --limit=50 \
  --format=json
```

### Force Retry Failed Images

If needed, manually create tasks for failed images:

```bash
# Get failed image IDs from database
# Then create tasks via gcloud CLI:

gcloud tasks create-http-task \
  --queue=image-processing-queue \
  --location=northamerica-northeast1 \
  --url=https://slideshow-processor-HASH-nn.a.run.app/process \
  --method=POST \
  --header="Content-Type: application/json" \
  --body-content='{"imageId":"abc123"}' \
  --oidc-service-account-email=image-processor@PROJECT.iam.gserviceaccount.com
```

## Cost Considerations

### Before (Cloud Run Jobs)
- Charged per job execution (all 50 images in batch)
- Fixed 10 parallel tasks × 15min timeout = 150 vCPU-minutes per execution
- Batch failure affects all images

### After (Cloud Tasks)
- Charged per Cloud Run invocation (1 image per task)
- Scale from 0-50 instances based on queue depth
- Single-image failures don't affect others
- Cloud Tasks: $0.40 per million operations (effectively free at this scale)

## Rollback Plan

If issues occur, revert to Cloud Run Jobs:

1. **Restore previous backend code:**
   ```bash
   git checkout <previous-commit> slideshow-backend/
   gcloud builds submit --config=cloudbuild.yaml
   ```

2. **Restore processor as job:**
   ```bash
   git checkout <previous-commit> slideshow-processor/
   gcloud builds submit --config=cloudbuild.yaml
   ```

3. **Manually trigger job for pending images:**
   ```bash
   gcloud run jobs execute slideshow-processor \
     --region=northamerica-northeast1
   ```

## Future Enhancements

- [ ] Add queue depth metrics to backend `/status` endpoint
- [ ] Implement task deduplication (check if image already in queue)
- [ ] Add priority queue for user-uploaded images vs. batch ingests
- [ ] Integrate Cloud Monitoring alerts for queue depth > threshold
- [ ] Add Dead Letter Queue for persistent failures
- [ ] Implement graceful processor shutdown with in-flight task handling
