Based on the code analysis and your requirements, I have developed a comprehensive specification for the Slideshow System.

This specification prioritizes **separation of concerns** to fix the brittleness of the current ingestion pipeline and introduces a **Device Handshake** protocol to remove hardcoded device configurations.

# ---

**Slideshow System Specifications**

## **1\. System Architecture & Boundaries**

The system is composed of three distinct services with strict responsibility boundaries to ensure scalability and stability.

### **1.1 Service Roles**

| Service | Primary Responsibility | Do's | Don'ts |
| :---- | :---- | :---- | :---- |
| **Backend** | Orchestration & State | • Manage DB state (Images, Devices, Users) • Serve API to UI & Devices • Trigger Cloud Run Jobs • Generate pre-signed URLs | • **NO** Image Processing (Sharp) • **NO** Heavy file downloading (stream directly to GCS) • **NO** Color extraction |
| **Processor** | Compute & Manipulation | • Download/Upload blobs • Resize/Crop images • Extract Metadata (EXIF, Hash) • Extract Color Palettes | • **NO** Direct DB write access (read-only allowed, or strictly via API) • **NO** Client-facing traffic |
| **Device** | Presentation | • Render images • Apply Material Theme colors • Manage local caching | • **NO** Image resizing • **NO** Complex logic |

## ---

**2\. The Ingestion Pipeline (Redesigned)**

Problem: The current system performs heavy lifting (hashing, metadata extraction) in the backend and uses brittle batching logic.  
Solution: A "Staging" approach where the Backend knows an image exists, but the Processor determines what it is.

### **2.1 Ingestion Flow**

#### **A. Source: Google Photos (Sync)**

1. **Backend** calls Google Photos API and lists mediaItems.  
2. **Backend** performs a "light" check against the DB using the Google Photos id (not file hash yet).  
3. **Backend** creates an ImageRecord with status STAGED and stores the baseUrl and googleId.  
4. **Backend** groups these IDs into a Batch and triggers the Processor.

#### **B. Source: Direct Upload**

1. **Client** requests an upload URL from Backend.  
2. **Backend** generates a **Signed Upload URL** for GCS (bucket: staging/).  
3. **Client** uploads file directly to GCS.  
4. **Client** notifies Backend "Upload Complete" with the GCS path.  
5. **Backend** creates ImageRecord with status STAGED and triggers the Processor.

### **2.2 The Processing Job (Cloud Run)**

The processor should no longer run on a fixed "10 tasks" logic. It should accept a **manifest** or a **batch ID**.

**Job Input (Environment or Payload):**

JSON

{  
  "batchId": "uuid-1234",  
  "targetImageIds": \["id1", "id2", "id3"\], // Optional: if empty, fetch all 'STAGED'  
  "forceReprocess": false  
}

**Processor Logic Steps:**

1. **Acquire:** Download the source file (from GCS Staging or Google Photos URL).  
2. **Fingerprint:** Calculate SHA-256 hash.  
   * *Check API:* Query Backend "Does hash X exist?"  
   * *Duplicate Handling:* If exists, link the new ImageRecord to the existing blob\_id and exit successfully.  
3. **Analyze:** Extract dimensions, EXIF data, orientation, and capture date.  
4. **Master Storage:** If not a duplicate, move file from Staging to Permanent Storage (gs://bucket/originals/{hash}.ext).  
5. **Color Extraction:** Run Material Color Utilities (MCU) on the original.  
6. **Variant Generation:**  
   * Fetch ActiveDeviceProfiles from Backend.  
   * For each profile (e.g., "Guition P4", "Web Thumb"):  
     * Resize/Crop (Smart Crop logic preferred).  
     * Upload to gs://bucket/processed/{width}x{height}/{hash}.jpg.  
7. **Finalize:** Call Backend API POST /api/ingest/finalize with results.

## ---

**3\. Dynamic Device Registration (Routing)**

Problem: Device sizes are hardcoded in the database/code.  
Solution: Devices report their capabilities upon connection.

### **3.1 Device Handshake Protocol**

When an ESPHome device boots, it calls the register endpoint.

**Request:** POST /api/devices/register

JSON

{  
  "mac\_address": "AA:BB:CC:DD:EE:FF",  
  "friendly\_name": "Kitchen Display",  
  "resolution": { "width": 1024, "height": 600 },  
  "capabilities": \["touch", "audio"\],  
  "version": "1.0.0"  
}

**Backend Logic:**

1. Upsert devices table.  
2. Check if processed\_images exist for 1024x600.  
3. If no images exist for this resolution, trigger a **Backfill Job** on the Processor to generate variants for this new aspect ratio.

### **3.2 The Next-Image Endpoint**

The device polls this endpoint to know what to show.

Request: GET /api/devices/{mac\_address}/next  
Response:

JSON

{  
  "image\_url": "https://api.domain.com/assets/1024x600/hash123.jpg",  
  "metadata": {  
    "location": "Boston, MA",  
    "date": "2023-10-15",  
    "photographer": "Milo"  
  },  
  "theme": {  
    "primary": "\#2A9D8F",  
    "secondary": "\#264653",  
    "is\_dark": false  
  },  
  "transition": {  
    "type": "crossfade",  
    "duration\_ms": 5000  
  }  
}

## ---

**4\. Database Schema (Simplified & Normalized)**

The current schema mixes ingestion status with file data. We should separate the "Source" (where it came from) from the "Content" (the unique image).

### **4.1 blobs (The unique content)**

* hash (PK): SHA-256  
* storage\_path: GCS URI  
* width: Int  
* height: Int  
* color\_palette\_json: Text  
* blurhash: String (For loading placeholders)

### **4.2 sources (The user's view)**

* id: UUID  
* user\_id: UUID  
* blob\_hash: FK to blobs.hash (Nullable if STAGED)  
* origin: Enum ('google\_photos', 'upload')  
* external\_id: String (Google Photos ID)  
* status: Enum ('STAGED', 'PROCESSING', 'READY', 'FAILED')

### **4.3 device\_variants (Processed Outputs)**

* blob\_hash: FK  
* width: Int  
* height: Int  
* storage\_path: GCS URI

## ---

**5\. UI & Management Specifications**

The web frontend (src/views) needs to reflect the decoupling.

### **5.1 Dashboard**

* **Queue Monitor:** Real-time view of the sources table where status \!= READY.  
* **Device Manager:** List registered devices. Allow users to "Pair" devices (e.g., set a specific album to a specific device).

### **5.2 Manual Override (Crop Editor)**

Since the Processor handles cropping automatically, there will be edge cases where heads are chopped off.

* **Feature:** A generic "Recrop" tool.  
* **Flow:**  
  1. User selects image \+ device format.  
  2. UI loads original image.  
  3. User adjusts crop rectangle.  
  4. Backend receives coordinates.  
  5. Backend triggers specific Processor task: ProcessImage(id, device\_profile, crop\_rect).

## ---

**6\. Deployment & Infrastructure Strategy**

### **6.1 Processor Scaling**

Instead of a fixed loop, use **Eventarc** or **Cloud Tasks**.

1. Backend pushes a message to Cloud Tasks queue image-processing.  
2. Cloud Task triggers the Cloud Run Job (or Service).  
3. **Benefit:** Automatic retries, rate limiting (Google Photos API limits), and dead-letter queues are handled by GCP infrastructure, not your job-queue.ts code.

### **6.2 Local Development**

* **Mock Storage:** Use a local folder to emulate GCS buckets.  
* **Mock Processor:** A simple script that watches the local "staging" folder and runs the processor function.  
* **Docker:** 3 Containers. backend, processor (running in watch mode), db.

## ---

**Summary of Actionable Changes**

1. **Refactor Backend:** Remove sharp and all image manipulation code. Replace image-ingestion.ts with a "Staging" manager.  
2. **Refactor Processor:** Update main.ts to accept specific Image IDs or Batch IDs rather than calculating its own shard index blindly.  
3. **Update API:** Add POST /api/devices/register and update the GET /next response to include dynamic themes.  
4. **Database Migration:** Split images into blobs (content) and sources (pointers) to handle duplicates elegantly.