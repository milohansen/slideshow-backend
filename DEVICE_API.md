# Device API Documentation

This document describes the REST API endpoints that devices use to interact with the slideshow backend.

## Base URL

All endpoints are relative to the server's base URL:
- Local development: `http://localhost:8080`
- Production: Your deployed Cloud Run URL

All device endpoints are prefixed with `/api/devices`.

---

## Endpoints

### 1. Register/Update Device

Register a new device or update an existing device's information.

**Endpoint:** `POST /api/devices`

**Request Body:**
```json
{
  "id": "living-room",
  "name": "Living Room Display",
  "width": 1920,
  "height": 1080,
  "orientation": "landscape"
}
```

**Fields:**
- `id` (string, required): Unique identifier for the device
- `name` (string, required): Human-readable name for the device
- `width` (number, required): Display width in pixels
- `height` (number, required): Display height in pixels
- `orientation` (string, required): Either "landscape" or "portrait"

**Response:**
```json
{
  "success": true,
  "deviceId": "living-room"
}
```

**Status Codes:**
- `200 OK`: Device registered/updated successfully
- `400 Bad Request`: Missing required fields

**Notes:**
- If a device with the same `id` exists, it will be updated
- The `last_seen` timestamp is automatically updated on each registration

---

### 2. Get Device Info

Retrieve information about a specific device.

**Endpoint:** `GET /api/devices/:deviceId`

**Parameters:**
- `deviceId` (path): The device's unique identifier

**Response:**
```json
{
  "id": "living-room",
  "name": "Living Room Display",
  "width": 1920,
  "height": 1080,
  "orientation": "landscape",
  "created_at": "2026-01-09T10:30:00.000Z",
  "last_seen": "2026-01-09T15:45:00.000Z"
}
```

**Status Codes:**
- `200 OK`: Device found
- `404 Not Found`: Device does not exist

---

### 3. Get Slideshow Queue

Retrieve or regenerate the slideshow queue for a device. The queue contains a shuffled list of images optimized for the device's orientation, with portrait images paired based on color similarity.

**Endpoint:** `GET /api/devices/:deviceId/slideshow`

**Parameters:**
- `deviceId` (path): The device's unique identifier

**Query Parameters:**
- `regenerate` (optional): Set to "true" to force generation of a new queue

**Response:**
```json
{
  "deviceId": "living-room",
  "queue": [
    {
      "imageId": "550e8400-e29b-41d4-a716-446655440000",
      "filePath": "data/processed/large-landscape/550e8400-e29b-41d4-a716-446655440000.jpg"
    },
    {
      "imageId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "filePath": "data/processed/large-landscape/6ba7b810-9dad-11d1-80b4-00c04fd430c8.jpg",
      "isPaired": true,
      "pairedWith": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    }
  ],
  "currentIndex": 0,
  "generatedAt": "2026-01-09T15:45:00.000Z"
}
```

**Queue Item Fields:**
- `imageId`: Unique identifier for the image
- `filePath`: Internal storage path (use this to fetch the image)
- `isPaired` (optional): Indicates if this portrait image is paired with another
- `pairedWith` (optional): The imageId of the paired portrait image

**Status Codes:**
- `200 OK`: Queue retrieved successfully
- `404 Not Found`: Device does not exist or no processed images available

**Notes:**
- The queue is persisted on the server and resumes from the last position
- For landscape devices: all landscape images are shuffled
- For portrait devices: portrait images are paired by color similarity, unpaired portraits and landscape images are included
- Queue size is typically 100 images

---

### 4. Get Next Image

Get the next image in the device's slideshow sequence. This automatically advances the queue index.

**Endpoint:** `GET /api/devices/:deviceId/next`

**Parameters:**
- `deviceId` (path): The device's unique identifier

**Response:**
```json
{
  "imageId": "550e8400-e29b-41d4-a716-446655440000",
  "filePath": "data/processed/large-landscape/550e8400-e29b-41d4-a716-446655440000.jpg",
  "isPaired": false
}
```

**Status Codes:**
- `200 OK`: Next image retrieved successfully
- `404 Not Found`: No images available or device does not exist
- `500 Internal Server Error`: Server error

**Notes:**
- Calling this endpoint advances the queue position
- When the queue reaches the end, it automatically regenerates a new shuffled sequence
- Use this endpoint for simple "next image" functionality without managing the queue client-side

---

### 5. Get Processed Image

Download the actual image file processed for the device's dimensions.

**Endpoint:** `GET /api/devices/:deviceId/images/:imageId`

**Parameters:**
- `deviceId` (path): The device's unique identifier
- `imageId` (path): The image's unique identifier (from queue)

**Response:**
Binary image data (JPEG format)

**Headers:**
- `Content-Type: image/jpeg`
- `Cache-Control: public, max-age=31536000`

**Status Codes:**
- `200 OK`: Image retrieved successfully
- `404 Not Found`: Device or image not found
- `500 Internal Server Error`: Failed to serve image

**Notes:**
- Images are resized and optimized for the specific device dimensions
- Images are cached with a 1-year expiration (safe to cache aggressively)
- Supports both local file storage and Google Cloud Storage

---

## Usage Flow

### Initial Setup
1. Device registers itself with `POST /api/devices`
2. Device fetches its slideshow queue with `GET /api/devices/:deviceId/slideshow`

### Display Loop (Option 1: Manual Queue Management)
1. Iterate through the queue items
2. For each item, fetch the image: `GET /api/devices/:deviceId/images/:imageId`
3. Display the image for the desired duration
4. When queue is exhausted, fetch a new queue with `?regenerate=true`

### Display Loop (Option 2: Automatic Queue Management)
1. Call `GET /api/devices/:deviceId/next` to get the next image
2. Fetch the image: `GET /api/devices/:deviceId/images/:imageId`
3. Display the image for the desired duration
4. Repeat (the server handles queue advancement and regeneration)

---

## Example Usage

### Device Registration (curl)
```bash
curl -X POST http://localhost:8080/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "id": "living-room",
    "name": "Living Room Display",
    "width": 1920,
    "height": 1080,
    "orientation": "landscape"
  }'
```

### Get Next Image (curl)
```bash
curl http://localhost:8080/api/devices/living-room/next
```

### Download Image (curl)
```bash
curl http://localhost:8080/api/devices/living-room/images/550e8400-e29b-41d4-a716-446655440000 \
  -o image.jpg
```

### Python Example
```python
import requests
import time

# Configuration
BASE_URL = "http://localhost:8080"
DEVICE_ID = "living-room"
DISPLAY_DURATION = 30  # seconds

# Register device
device_info = {
    "id": DEVICE_ID,
    "name": "Living Room Display",
    "width": 1920,
    "height": 1080,
    "orientation": "landscape"
}
requests.post(f"{BASE_URL}/api/devices", json=device_info)

# Slideshow loop
while True:
    # Get next image
    response = requests.get(f"{BASE_URL}/api/devices/{DEVICE_ID}/next")
    if response.status_code != 200:
        print("No images available")
        time.sleep(60)
        continue
    
    item = response.json()
    image_id = item["imageId"]
    
    # Download image
    image_response = requests.get(
        f"{BASE_URL}/api/devices/{DEVICE_ID}/images/{image_id}"
    )
    
    if image_response.status_code == 200:
        # Display the image (implementation depends on your display hardware)
        display_image(image_response.content)
        time.sleep(DISPLAY_DURATION)
```

### JavaScript/TypeScript Example
```typescript
const BASE_URL = "http://localhost:8080";
const DEVICE_ID = "living-room";
const DISPLAY_DURATION = 30000; // milliseconds

// Register device
async function registerDevice() {
  const response = await fetch(`${BASE_URL}/api/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: DEVICE_ID,
      name: "Living Room Display",
      width: 1920,
      height: 1080,
      orientation: "landscape",
    }),
  });
  return response.json();
}

// Get and display next image
async function showNextImage() {
  // Get next image info
  const nextResponse = await fetch(
    `${BASE_URL}/api/devices/${DEVICE_ID}/next`
  );
  
  if (!nextResponse.ok) {
    console.error("No images available");
    return;
  }
  
  const item = await nextResponse.json();
  
  // Download and display image
  const imageUrl = `${BASE_URL}/api/devices/${DEVICE_ID}/images/${item.imageId}`;
  const imgElement = document.querySelector("#slideshow-image");
  imgElement.src = imageUrl;
}

// Slideshow loop
async function runSlideshow() {
  await registerDevice();
  
  while (true) {
    await showNextImage();
    await new Promise(resolve => setTimeout(resolve, DISPLAY_DURATION));
  }
}

runSlideshow();
```

---

## Error Handling

All error responses follow this format:
```json
{
  "error": "Error message description"
}
```

Common error scenarios:
- **Device not found**: Register the device first with `POST /api/devices`
- **No images available**: Images need to be ingested and processed on the server
- **Image not found**: The image may have been deleted or not yet processed for this device size

---

## Image Processing

Images are automatically processed for each registered device size:
- Resized to exact device dimensions using center-crop
- Color palette extracted (primary, secondary, tertiary colors)
- Optimized JPEG quality (90%)
- Portrait images on portrait devices are paired based on color similarity

When a new device size is registered, existing images will be processed in the background.

---

## Queue Behavior

### Landscape Devices
- Displays landscape-oriented images only
- Random shuffle with no duplicates until all images shown
- Automatically regenerates queue when exhausted

### Portrait Devices
- Pairs portrait images with similar color palettes for side-by-side display
- Includes unpaired portraits and landscape images in rotation
- Maintains visual coherence through color similarity matching
- Portrait pairs display consecutively in the queue

---

## Performance Considerations

- **Caching**: Image responses include aggressive cache headers (1 year)
- **Preloading**: Fetch the next 2-3 images ahead of display time
- **Queue Management**: Fetch full queue once, then use `/next` endpoint for simplicity
- **Error Recovery**: Implement retry logic for network failures
- **Health Monitoring**: Periodically check device status and re-register if needed

---

## Rate Limits

Currently no rate limits are enforced, but please be reasonable:
- Register device once per session (not on every image fetch)
- Use queue endpoint sparingly (once per queue cycle)
- Image fetches can be aggressive (they're cached on server)

---

## Support

For issues or questions:
1. Check server logs for detailed error messages
2. Verify device is properly registered
3. Ensure images have been ingested and processed on the server
4. Review this documentation for correct endpoint usage
