# Database Sync Testing Guide

## Local Testing (Development Mode)

```bash
# Without GCS_BUCKET_NAME - uses local filesystem
deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run src/main.ts
```

Expected behavior:
- ✅ Database initialized with WAL mode
- ⚠️  Warning: "GCS_BUCKET_NAME not set, using local filesystem storage"
- No database sync manager initialization
- Server starts normally on port 8080

## Production Testing (Cloud Run with GCS)

### Prerequisites

1. Create GCS bucket:
```bash
export PROJECT_ID=your-project-id
export BUCKET_NAME=your-slideshow-bucket

gsutil mb -p $PROJECT_ID gs://$BUCKET_NAME
```

2. Authenticate locally:
```bash
gcloud auth application-default login
```

### Test 1: Single Instance with Sync

```bash
export GCS_BUCKET_NAME=your-slideshow-bucket
export DENO_ENV=production

deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run src/main.ts
```

Expected logs:
```
✅ Database initialized
✅ Google Cloud Storage initialized (bucket: your-slideshow-bucket)
🔄 Initializing database sync...
✅ Acquired write lease - this instance is the primary writer
📝 No existing database in GCS, starting fresh
✅ Database downloaded successfully
🚀 Server running on http://0.0.0.0:8080
```

### Test 2: Verify Health Check with Sync Status

```bash
curl http://localhost:8080/_health | jq
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-09T...",
  "dbSync": {
    "isWriter": true,
    "instanceId": "uuid-here",
    "lastSyncTime": "2026-01-09T..." or null
  }
}
```

### Test 3: Verify Database Sync to GCS

Wait 30+ seconds, then check GCS:
```bash
gsutil ls gs://$BUCKET_NAME/database/
```

Expected files:
```
gs://your-bucket/database/slideshow.db
gs://your-bucket/database/slideshow.db-wal
gs://your-bucket/database/db-lease.json
```

### Test 4: Graceful Shutdown Sync

```bash
# Send SIGTERM (Ctrl+C)
# Check logs for:
```

Expected logs:
```
SIGTERM received, starting graceful shutdown...
🛑 Shutting down database sync...
⬆️  Uploading database to GCS...
✅ Database uploaded successfully
✅ Database synced and lease released
Server closed successfully
```

### Test 5: Multiple Instance Lease Conflict

Terminal 1:
```bash
export GCS_BUCKET_NAME=your-slideshow-bucket
export DENO_ENV=production
PORT=8080 deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run src/main.ts
```

Terminal 2 (different port):
```bash
export GCS_BUCKET_NAME=your-slideshow-bucket
export DENO_ENV=production
PORT=8081 deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run src/main.ts
```

Expected:
- Terminal 1: "✅ Acquired write lease - this instance is the primary writer"
- Terminal 2: "📖 Running in read-only mode"

### Test 6: Lease Expiration and Failover

1. Start instance 1 (gets write lease)
2. Kill instance 1 without graceful shutdown (kill -9)
3. Wait 60 seconds (lease timeout)
4. Start instance 2

Expected:
- Instance 2: "⚠️  Acquired expired lease from [instance-1-id]"

## Verify Database Files

Check WAL mode is enabled:
```bash
sqlite3 slideshow.db "PRAGMA journal_mode;"
```

Expected output: `wal`

Check recent changes in WAL:
```bash
ls -lh slideshow.db*
```

Expected files:
- `slideshow.db` (main database)
- `slideshow.db-wal` (write-ahead log)
- `slideshow.db-shm` (shared memory file)

## Cloud Run Deployment Testing

After deploying to Cloud Run:

```bash
SERVICE_URL=$(gcloud run services describe slideshow-backend --region us-central1 --format 'value(status.url)')

# Check health with sync status
curl ${SERVICE_URL}/_health | jq

# Monitor logs for sync activity
gcloud run services logs read slideshow-backend --region us-central1 --limit 100 | grep -E "sync|lease|GCS"
```

Expected log patterns:
- Every 30 seconds: "⬆️  Uploading database to GCS..." (only if DB changed)
- Every 30 seconds: Lease renewal (silent unless error)
- On deployment: "🔄 Initializing database sync..."
- On shutdown: "🛑 Shutting down database sync..."

## Troubleshooting

### Issue: "Failed to acquire lease"
- Check GCS bucket permissions
- Verify bucket name is correct
- Check for stale lease files

### Issue: "Address already in use"
- Kill existing process or use different PORT
- Check for running dev server

### Issue: "Failed to upload database"
- Check GCS bucket write permissions
- Verify Application Default Credentials
- Check network connectivity

### Issue: Database not persisting
- Verify `DENO_ENV=production` is set
- Check GCS bucket has files in `database/` folder
- Verify no errors in sync logs
