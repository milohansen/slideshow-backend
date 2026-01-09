# ESPHome Photo Slideshow Backend

A containerized backend service to ingest, process, and serve photos to ESPHome devices via REST API.

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)

## Features

- 📸 **Image Ingestion** - Scan local directories and extract metadata (dimensions, orientation)
- 🎨 **Color Extraction** - Extract primary, secondary, and tertiary colors from images
- 🖼️ **Multi-Size Processing** - Automatically resize images for different device sizes
- 🔄 **Smart Slideshow** - Generate shuffled queues with portrait pairing by color similarity
- 📱 **Multi-Device Support** - Support multiple devices with different screen sizes
- 💾 **Deduplication** - Hash-based duplicate detection
- 🚀 **REST API** - Full REST API for device management and image serving
- 🐳 **Docker Ready** - Containerized for easy deployment
- ☁️ **Cloud Run Ready** - Optimized for Google Cloud Run deployment

## Stack

- **Runtime:** Deno 2.x
- **Framework:** Hono
- **Database:** SQLite
- **Image Processing:** ImageMagick

## Getting Started

### Prerequisites

- Deno 2.x
- ImageMagick (for image processing)

### Development

```bash
# Run in development mode with hot reload
deno task dev

# Run CLI tool
deno task cli help
```

### CLI Commands

```bash
# Ingest images from a directory
deno task cli ingest /path/to/images --verbose

# Process images for all device sizes
deno task cli process --verbose

# Show image statistics
deno task cli stats

# View all available commands
deno task cli help
```

### Example Workflow

```bash
# 1. Ingest images from a directory
deno task cli ingest ./photos --verbose

# 2. Process images for all device sizes (resize and extract colors)
deno task cli process --verbose

# 3. Check statistics
deno task cli stats

# 4. Start the server
deno task dev

# 5. Register a device
curl -X POST http://localhost:8000/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "id": "living-room",
    "name": "Living Room Display",
    "width": 600,
    "height": 1024,
    "orientation": "portrait"
  }'

# 6. Get slideshow queue
curl http://localhost:8000/api/devices/living-room/slideshow

# 7. Get next image in sequence
curl http://localhost:8000/api/devices/living-room/next

# 8. Serve an image
curl http://localhost:8000/api/devices/living-room/images/{imageId} > image.jpg
```

### Production

```bash
# Run production server
deno task start
```

### Docker

```bash
# Build image
docker build -t slideshow-backend .

# Run container
docker run -p 8080:8080 -v $(pwd)/data:/app/data slideshow-backend
```

## Deploying to Google Cloud Run

### Prerequisites

1. Install the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
2. Set up your project:
```bash
export PROJECT_ID=<your-gcp-project-id>
gcloud config set project $PROJECT_ID
```

### Enable Required APIs

```bash
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### Deploy with Cloud Build

```bash
# Submit build to Cloud Build
gcloud builds submit --config cloudbuild.yaml

# Or deploy directly with gcloud
gcloud run deploy slideshow-backend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10
```

### Environment Variables

Set environment variables for your Cloud Run service:

```bash
gcloud run services update slideshow-backend \
  --region us-central1 \
  --set-env-vars="DENO_ENV=production"
```

### Persistent Storage

For production deployments with persistent image storage, consider:
- Using Google Cloud Storage for images
- Mounting Cloud Storage buckets via gcsfuse
- Using Cloud SQL for the database (instead of SQLite)

### Monitoring

Cloud Run automatically provides:
- Request logs in Cloud Logging
- Metrics in Cloud Monitoring
- Health checks via the `/_health` endpoint

## API Endpoints

### Device Management

- `POST /api/devices` - Register/update device
- `GET /api/devices/:deviceId` - Get device info
- `GET /api/devices/:deviceId/slideshow` - Get slideshow queue
- `GET /api/devices/:deviceId/images/:imageId` - Get processed image

### Admin

- `GET /api/admin/stats` - Get image statistics
- `POST /api/admin/ingest` - Trigger image ingestion from directory
  ```json
  { "directory": "/path/to/images", "recursive": true }
  ```
- `POST /api/admin/process` - Process all images for all device sizes

### Slideshow

- `GET /api/devices/:deviceId/next` - Get next image in slideshow sequence
- `GET /api/devices/:deviceId/slideshow?regenerate=true` - Regenerate queue

## Configuration

Device screen sizes are configured in `config/settings.json`:

```json
{
  "imageSourceDirectory": "data/images",
  "processedImageDirectory": "data/processed",
  "deviceSizes": [
    { "name": "small-landscape", "width": 800, "height": 480 },
    { "name": "medium-landscape", "width": 1024, "height": 600 },
    { "name": "large-landscape", "width": 1920, "height": 1080 },
    { "name": "small-portrait", "width": 480, "height": 800 },
    { "name": "medium-portrait", "width": 600, "height": 1024 }
  ]
}
```

## How It Works

### 1. Image Ingestion
- Scans directories for supported image formats (JPG, PNG, WebP, GIF)
- Extracts metadata using ImageMagick or ffmpeg
- Calculates SHA-256 hash for deduplication
- Stores metadata in SQLite database

### 2. Image Processing
- Resizes images for all configured device sizes
- Extracts dominant colors (primary, secondary, tertiary)
- Stores processed images and color data in database

### 3. Slideshow Queue Generation
- **For Portrait Devices**: Pairs portrait images by color similarity
  - Compares color palettes using weighted similarity
  - Creates visually harmonious pairs
- **For Landscape Devices**: Shuffles all available images
- Generates queues of 100 images (configurable)
- Persists queue state per device

### 4. Image Serving
- Serves processed images based on device size
- Includes cache headers for performance
- Tracks queue position per device

## Project Structure

```
slideshow-backend/
├── config/
│   └── settings.json          # Configuration
├── data/
│   ├── images/                # Original images (not tracked)
│   └── processed/             # Processed images (not tracked)
├── src/
│   ├── db/
│   │   └── schema.ts          # Database schema
│   ├── routes/
│   │   ├── admin.ts           # Admin endpoints
│   │   └── devices.ts         # Device endpoints
│   ├── services/
│   │   ├── image-ingestion.ts # Image scanning and ingestion
│   │   ├── image-processing.ts # Resizing and color extraction
│   │   └── slideshow-queue.ts  # Queue generation logic
│   ├── cli.ts                 # CLI tool
│   └── main.ts                # Server entry point
├── deno.json                  # Deno configuration
├── Dockerfile                 # Container definition
└── README.md
```

## License

MIT
