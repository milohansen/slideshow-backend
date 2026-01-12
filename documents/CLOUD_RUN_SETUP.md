# ESPHome Photo Slideshow Backend - Cloud Run Setup Summary

## Changes Made for Google Cloud Run Compatibility

### 1. **Dockerfile Updates** ✅
- Changed default port from 8000 to 8080 (Cloud Run standard)
- Added PORT environment variable support for dynamic port assignment
- Created proper data directories with correct permissions
- Optimized layer caching with dependency separation
- Added production environment variable

### 2. **Application Updates** ✅

#### Main Server (src/main.ts)
- **Health Check Endpoint**: Added `/_health` endpoint for Cloud Run health checks
  ```typescript
  app.get("/_health", (c) => {
    return c.json({ status: "healthy", timestamp: new Date().toISOString() });
  });
  ```

- **Dynamic Port Configuration**: Changed from hardcoded 8000 to environment-based 8080
  ```typescript
  const port = Number(Deno.env.get("PORT")) || 8080;
  ```

- **Graceful Shutdown**: Added SIGTERM and SIGINT handlers for clean container termination
  ```typescript
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  ```

#### Image Processing (src/services/image-processing.ts)
- **Database-Driven Configuration**: Updated `loadConfig()` to load device sizes from the database instead of static JSON file
- Devices are now dynamically loaded from the `devices` table
- No need to maintain separate configuration files

### 3. **Cloud Build Configuration** ✅

Created `cloudbuild.yaml` for automated builds:
- Builds Docker container
- Pushes to Google Container Registry
- Deploys to Cloud Run with optimized settings:
  - 512Mi memory
  - 1 CPU
  - Max 10 instances
  - 300s timeout

### 4. **Deployment Tools** ✅

#### deploy.sh Script
- Automated deployment script
- Handles build and deployment in one command
- Displays service URL and health check after deployment

#### .dockerignore
- Optimizes container image size
- Excludes development and test files
- Reduces build time and final image size

#### .gcloudignore
- Excludes unnecessary files from Cloud Build
- Keeps deployment fast and efficient

### 5. **Documentation** ✅

#### README.md Updates
- Added Cloud Run deployment badge
- Cloud Run deployment instructions
- Environment variable configuration
- Persistent storage options
- Monitoring guidance

#### CLOUD_RUN.md
- Comprehensive Cloud Run deployment guide
- Configuration options (memory, CPU, scaling)
- Persistent storage solutions (Cloud Storage, Cloud SQL)
- Monitoring and logging
- Security best practices
- Cost optimization tips
- CI/CD integration examples

## Key Features for Cloud Run

### ✅ Health Checks
- Dedicated `/_health` endpoint
- Returns JSON with status and timestamp
- Used by Cloud Run for container health monitoring

### ✅ Graceful Shutdown
- Listens for SIGTERM (Cloud Run termination signal)
- Closes server gracefully before exit
- Prevents request loss during scaling down

### ✅ Dynamic Port Binding
- Respects PORT environment variable
- Cloud Run assigns port dynamically
- Defaults to 8080 for local development

### ✅ Stateless Design
- SQLite database in writable directory
- Processed images stored in mounted volumes
- Ready for Cloud Storage integration

### ✅ Container Optimization
- Multi-layer build with dependency caching
- Minimal image size with .dockerignore
- Fast cold starts with optimized dependencies

## Deployment Methods

### Method 1: Quick Deploy (Recommended)
```bash
export PROJECT_ID=your-gcp-project-id
./deploy.sh
```

### Method 2: Cloud Build
```bash
gcloud builds submit --config cloudbuild.yaml
```

### Method 3: Direct Deployment
```bash
gcloud run deploy slideshow-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

## Testing

### Local Testing
```bash
# Test with Cloud Run port
PORT=8080 deno task start

# Test health endpoint
curl http://localhost:8080/_health

# Test graceful shutdown
kill -TERM <pid>
```

### Container Testing
```bash
# Build and run container
docker build -t slideshow-backend .
docker run -p 8080:8080 slideshow-backend

# Test health endpoint
curl http://localhost:8080/_health
```

## Production Considerations

### Storage
- Use Cloud Storage for images (see CLOUD_RUN.md)
- Consider Cloud SQL for database at scale
- Mount persistent volumes for data directory

### Scaling
- Configure min/max instances based on traffic
- Set appropriate concurrency limits
- Use min-instances=1 to avoid cold starts

### Monitoring
- Cloud Logging automatically enabled
- Health check endpoint for uptime monitoring
- Set up Cloud Monitoring alerts

### Security
- Use IAM for authentication if needed
- Restrict to VPC for internal services
- Enable Cloud Armor for DDoS protection

## Next Steps

1. **Set up persistent storage**:
   - Mount Cloud Storage bucket for images
   - Configure Cloud SQL if needed

2. **Configure CI/CD**:
   - Set up Cloud Build triggers
   - Add GitHub Actions integration

3. **Enable monitoring**:
   - Set up uptime checks
   - Configure alerting policies
   - Enable error reporting

4. **Optimize costs**:
   - Set min-instances=0 for dev/staging
   - Use appropriate memory/CPU limits
   - Monitor billable instance time

## Files Added/Modified

### New Files
- `cloudbuild.yaml` - Cloud Build configuration
- `.dockerignore` - Docker build optimization
- `.gcloudignore` - Cloud Build optimization
- `deploy.sh` - Automated deployment script
- `CLOUD_RUN.md` - Comprehensive deployment guide
- `CLOUD_RUN_SETUP.md` - This summary document

### Modified Files
- `Dockerfile` - Cloud Run optimizations
- `src/main.ts` - Health checks and graceful shutdown
- `src/services/image-processing.ts` - Database-driven config
- `README.md` - Cloud Run documentation

## Verification Checklist

- [x] Health check endpoint responds
- [x] Graceful shutdown works
- [x] Dynamic PORT binding works
- [x] Container builds successfully
- [x] Local server starts on port 8080
- [x] Database initialization works
- [x] Image processing uses database config
- [x] All routes accessible

## Resources

- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Container Runtime Contract](https://cloud.google.com/run/docs/container-contract)
- [Cloud Build Documentation](https://cloud.google.com/build/docs)
- [Deno Deploy to Cloud Run](https://deno.land/manual/advanced/deploying_deno/google_cloud_run)
