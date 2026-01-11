/**
 * Job Queue Service for Cloud Run Jobs
 * Replaces worker-queue.ts with Cloud Run Jobs API
 */

// Import Cloud Run Jobs API client
// Note: We'll add this to deno.json imports
let CloudRunJobsClient: any = null;

interface JobQueueConfig {
  projectId: string;
  region: string;
  jobName: string;
  backendApiUrl: string;
  authToken: string;
}

class JobQueueManager {
  private config: JobQueueConfig;
  private pendingImages: Set<string> = new Set();
  private flushTimer: number | null = null;
  private readonly BATCH_SIZE = 50;
  private readonly FLUSH_DELAY_MS = 30000; // 30 seconds

  constructor(config: JobQueueConfig) {
    this.config = config;
    console.log(`[JobQueue] Initialized for job: ${config.jobName}`);
  }

  /**
   * Queue an image for processing
   */
  async queueImage(imageId: string): Promise<void> {
    console.log(`[JobQueue] Queuing image: ${imageId}`);
    
    this.pendingImages.add(imageId);

    // Trigger immediately if we've hit batch size
    if (this.pendingImages.size >= this.BATCH_SIZE) {
      await this.flush();
    } else {
      // Otherwise, schedule a flush
      this.scheduleFlush();
    }
  }

  /**
   * Schedule a delayed flush
   */
  private scheduleFlush() {
    if (this.flushTimer !== null) {
      return; // Already scheduled
    }

    this.flushTimer = setTimeout(() => {
      this.flush().catch(err => 
        console.error("[JobQueue] Error during scheduled flush:", err)
      );
    }, this.FLUSH_DELAY_MS);
  }

  /**
   * Flush pending images and trigger the Cloud Run Job
   */
  async flush(): Promise<void> {
    // Clear timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingImages.size === 0) {
      return; // Nothing to flush
    }

    const imageCount = this.pendingImages.size;
    console.log(`[JobQueue] Flushing ${imageCount} images to Cloud Run Job`);

    // Clear the pending set
    this.pendingImages.clear();

    try {
      await this.triggerJob();
      console.log(`[JobQueue] ✅ Successfully triggered job for ${imageCount} images`);
    } catch (error) {
      console.error("[JobQueue] ❌ Failed to trigger job:", error);
      // Note: Images remain in 'pending' state in database, will be retried on next trigger
    }
  }

  /**
   * Trigger the Cloud Run Job
   */
  private async triggerJob(): Promise<void> {
    const { config } = this;

    // Lazy load the Cloud Run client
    if (!CloudRunJobsClient) {
      try {
        const module = await import("npm:@google-cloud/run@^0.3.0");
        CloudRunJobsClient = module.JobsClient;
      } catch (error) {
        console.error("[JobQueue] Failed to load @google-cloud/run:", error);
        throw new Error("Cloud Run Jobs API client not available");
      }
    }

    const client = new CloudRunJobsClient();
    const jobPath = `projects/${config.projectId}/locations/${config.region}/jobs/${config.jobName}`;

    try {
      // Execute the job
      const [operation] = await client.runJob({
        name: jobPath,
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: "GCS_BUCKET_NAME", value: Deno.env.get("GCS_BUCKET_NAME") || "" },
                { name: "BACKEND_API_URL", value: config.backendApiUrl },
                { name: "BACKEND_AUTH_TOKEN", value: config.authToken },
              ],
            },
          ],
          taskCount: 10, // Process across 10 parallel tasks
        },
      });

      console.log(`[JobQueue] Job execution started: ${operation.name}`);
    } catch (error: any) {
      // Check if error is due to missing Cloud Run API
      if (error.message?.includes("not found") || error.message?.includes("ENOENT")) {
        console.warn("[JobQueue] ⚠️ Cloud Run Jobs API not available - running in local mode");
        console.warn("[JobQueue] Images will remain in 'pending' state until job is triggered manually");
        return;
      }
      throw error;
    }
  }

  /**
   * Get status of pending images
   */
  getStatus() {
    return {
      pendingCount: this.pendingImages.size,
      hasScheduledFlush: this.flushTimer !== null,
    };
  }
}

// Singleton instance
let queueManager: JobQueueManager | null = null;

/**
 * Initialize the job queue manager
 */
export function initJobQueue() {
  const projectId = Deno.env.get("GCP_PROJECT_ID") || Deno.env.get("GOOGLE_CLOUD_PROJECT");
  const region = Deno.env.get("GCP_REGION") || "us-central1";
  const jobName = Deno.env.get("PROCESSOR_JOB_NAME") || "slideshow-processor";
  const backendApiUrl = Deno.env.get("BACKEND_API_URL") || `http://localhost:${Deno.env.get("PORT") || 8080}`;
  const authToken = Deno.env.get("PROCESSOR_AUTH_TOKEN");

  if (!projectId) {
    console.warn("⚠️ GCP_PROJECT_ID not set - job queue will run in local mode");
  }

  if (!authToken) {
    console.warn("⚠️ PROCESSOR_AUTH_TOKEN not set - processor authentication disabled");
  }

  queueManager = new JobQueueManager({
    projectId: projectId || "",
    region,
    jobName,
    backendApiUrl,
    authToken: authToken || "",
  });

  console.log("✅ Job queue manager initialized");
}

/**
 * Queue an image for processing
 * This is called from image-ingestion.ts when new images are added
 */
export async function queueImageProcessing(imageId: string): Promise<void> {
  if (!queueManager) {
    console.warn("[JobQueue] Queue manager not initialized, skipping queue");
    return;
  }

  await queueManager.queueImage(imageId);
}

/**
 * Manually flush pending images (useful for testing)
 */
export async function flushQueue(): Promise<void> {
  if (!queueManager) {
    console.warn("[JobQueue] Queue manager not initialized");
    return;
  }

  await queueManager.flush();
}

/**
 * Get queue status
 */
export function getQueueStatus() {
  if (!queueManager) {
    return { initialized: false };
  }

  return {
    initialized: true,
    ...queueManager.getStatus(),
  };
}

/**
 * Shutdown the queue manager
 */
export async function shutdownJobQueue(): Promise<void> {
  if (!queueManager) {
    return;
  }

  console.log("[JobQueue] Shutting down...");
  await queueManager.flush();
  queueManager = null;
}
