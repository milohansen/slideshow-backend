This plan outlines how to transition your image processing from local worker threads to a high-throughput **Google Cloud Run Job** architecture.

### 1. Repository Structure

While you can use a subdirectory in your existing repository, creating a **new repository** is recommended for isolation. This allows you to manage different dependencies (like `sharp`, which requires native bindings) and independent deployment cycles without bloating your Web UI's container.

**Suggested New Repo Structure (`slideshow-processor`):**

* `main.ts`: The entry point that handles task sharding.


* `processor.ts`: Logic for `sharp` resizing and `material-color-utilities` extraction.


* `deno.json`: Configured with `nodeModulesDir: "auto"` for native npm support.


* `Dockerfile`: Optimized to pre-cache dependencies.



---

### 2. Developing the Job App

Your new application will leverage Deno 2.x's native npm support to use `sharp` and the `material-color-utilities`.

#### The Core Job Logic (`main.ts`)

This script uses environment variables provided by Cloud Run to split the 200+ images among multiple parallel containers.

```typescript
import sharp from "npm:sharp@0.33.5";
import { QuantizerCelebi, Score } from "npm:@material/material-color-utilities@0.2.7";
import { Storage } from "npm:@google-cloud/storage";

// 1. Task Sharding Logic (Injected by Cloud Run for Array Jobs)
const TASK_INDEX = parseInt(Deno.env.get("CLOUD_RUN_TASK_INDEX") || "0");
const TASK_COUNT = parseInt(Deno.env.get("CLOUD_RUN_TASK_COUNT") || "1");

async function main() {
  const storage = new Storage();
  const bucketName = Deno.env.get("GCS_BUCKET_NAME");
  if (!bucketName) throw new Error("GCS_BUCKET_NAME required");
  
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: "images/originals/" });

  // 2. Shard the workload: Each container only processes its assigned subset
  const myFiles = files.filter((_, index) => index % TASK_COUNT === TASK_INDEX);
  console.log(`Task ${TASK_INDEX}/${TASK_COUNT} processing ${myFiles.length} images.`);

  for (const file of myFiles) {
    try {
      await processImage(file, bucket);
    } catch (err) {
      console.error(`Failed to process ${file.name}:`, err);
    }
  }
}

async function processImage(file: any, bucket: any) {
  const [buffer] = await file.download();
  
  // 3. High-Quality Resizing (sharp defaults to Lanczos3)
  const resizedBuffer = await sharp(buffer)
    .resize(1920, 1080, { fit: "inside" }) // Example: Large Landscape
    .toFormat("jpeg", { quality: 90 })
    .toBuffer();

  // 4. Color Extraction with Proxy Optimization
  // Resize to 128x128 proxy to speed up pixel quantization
  const { data: rawPixels, info } = await sharp(buffer)
    .resize(128, 128, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert RGBA (Uint8) to ARGB (Int32) for Material utilities
  const argbPixels = new Int32Array(info.width * info.height);
  for (let i = 0; i < rawPixels.length / 4; i++) {
    argbPixels[i] = (rawPixels[i*4+3] << 24) | (rawPixels[i*4] << 16) | (rawPixels[i*4+1] << 8) | rawPixels[i*4+2];
  }

  const result = QuantizerCelebi.quantize(argbPixels, 128);
  const ranked = Score.score(result);
  const colors = ranked.slice(0, 3).map(c => `#${(c & 0xFFFFFF).toString(16).padStart(6, '0')}`);

  // 5. Save output metadata and image back to GCS
  const baseName = file.name.split("/").pop();
  await bucket.file(`images/processed/${baseName}`).save(resizedBuffer);
  // Important: The UI needs to know these colors; save a metadata sidecar file
  await bucket.file(`images/metadata/${baseName}.json`).save(JSON.stringify({ colors }));
}

if (import.meta.main) main();

```

Logic derived from architectural analysis recommendations .

---

### 3. Updating the Web UI App

Currently, your UI uses `src/services/worker-queue.ts` to process images locally. You will need to replace the local worker invocation with a call to trigger the Cloud Run Job.

**Changes in `src/services/worker-queue.ts` (or a new job service):**
Instead of `new Worker(...)`, use the Google Cloud Client Library to run the job:

```typescript
import { CloudRunClient } from "npm:@google-cloud/run";

export async function triggerProcessingJob() {
  const client = new CloudRunClient();
  // Trigger an execution of the existing job
  const [execution] = await client.runJob({
    name: "projects/your-project/locations/us-central1/jobs/image-processor",
    overrides: {
      containerOverrides: [
        {
          env: [{ name: "GCS_BUCKET_NAME", value: "your-bucket" }]
        }
      ],
      [cite_start]taskCount: 10 // Parallelize across 10 instances [cite: 194]
    }
  });
  console.log(`Started job execution: ${execution.name}`);
}

```

---

### 4. Build and Pipeline Setup

To set up a second build in Cloud Build, create a new configuration file in your processor repository.

**New `cloudbuild-job.yaml`:**

```yaml
steps:
  # Build the container
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/image-processor', '.']

  # Push to registry
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/image-processor']

  # Create or Update the Job (Does not execute it)
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'jobs'
      - 'deploy'
      - 'image-processor'
      - '--image'
      - 'gcr.io/$PROJECT_ID/image-processor'
      - '--tasks'
      - '10'
      - '--max-retries'
      - '3'
      - '--region'
      - 'us-central1'

```

Based on standard Cloud Run Jobs deployment patterns.

**To deploy:**
Run `gcloud builds submit --config cloudbuild-job.yaml`. You can set up a **GitHub Trigger** in the Cloud Console specifically for your new repository that points to this YAML file.

---

### 5. Critical Considerations

* **Database Sync:** Your Web UI uses a single-writer SQLite lease mechanism. Because Cloud Run Jobs are ephemeral and parallel, they **cannot** safely write to your `slideshow.db` simultaneously.
  * **Recommended approach:** Have the Job save metadata to JSON files in GCS. Update your Web UI to poll for these files or provide a "Sync Metadata" button that reads these JSONs into the SQLite database.

* **Permissions:** The Cloud Run Job's service account will need `roles/storage.objectAdmin` to read/write images and `roles/run.developer` if you want the UI to trigger it via the API.
* **Cost Management:** While parallelism is cost-neutral (10 CPUs for 1 minute costs the same as 1 CPU for 10 minutes), Cloud Run Jobs are ideal because they stop billing immediately upon completion, unlike a service which might stay idle.


* **Error Isolation:** By using Array Jobs, if one specific image causes a crash (e.g., Task 3), only that task fails and can be retried without affecting the other 9 parallel tasks.