/**
 * Worker queue manager for processing images
 * Manages concurrent worker execution with throttling
 */

interface QueueTask {
  imageId: string;
  deviceName: string;
  deviceWidth: number;
  deviceHeight: number;
}

class WorkerQueueManager {
  private queue: QueueTask[] = [];
  private activeWorkers = 0;
  private maxConcurrentWorkers: number;
  private workerUrl: URL;

  constructor(maxConcurrentWorkers = 4) {
    this.maxConcurrentWorkers = maxConcurrentWorkers;
    this.workerUrl = new URL("../workers/image-processor.ts", import.meta.url);
  }

  /**
   * Add a task to the queue
   */
  enqueue(task: QueueTask) {
    console.log(`[Queue] Enqueuing task: ${task.imageId} for ${task.deviceName}`);
    this.queue.push(task);
    this.processQueue();
  }

  /**
   * Add multiple tasks to the queue
   */
  enqueueMany(tasks: QueueTask[]) {
    this.queue.push(...tasks);
    this.processQueue();
  }

  /**
   * Process queued tasks
   */
  private processQueue() {
    while (this.activeWorkers < this.maxConcurrentWorkers && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.spawnWorker(task);
      }
    }
  }

  /**
   * Spawn a worker to process a single task
   */
  private spawnWorker(task: QueueTask) {
    this.activeWorkers++;
    console.log(`[Queue] Spawning worker (${this.activeWorkers}/${this.maxConcurrentWorkers}): ${task.imageId} for ${task.deviceName}`);

    const worker = new Worker(this.workerUrl.href, {
      type: "module",
      deno: {
        permissions: {
          read: true,
          write: true,
          env: true,
          net: true,
          run: true,
          ffi: true,
        },
      },
    });

    worker.postMessage({
      imageId: task.imageId,
      deviceName: task.deviceName,
      deviceWidth: task.deviceWidth,
      deviceHeight: task.deviceHeight,
      outputDir: "data/processed",
    });

    worker.onmessage = (e: MessageEvent) => {
      const { success, imageId, deviceName, error } = e.data;
      if (success) {
        console.log(`[Worker] ✓ Completed: ${imageId} for ${deviceName}`);
      } else {
        console.error(`[Worker] ✗ Failed: ${imageId} for ${deviceName}:`, error);
      }
      this.onWorkerComplete();
    };

    worker.onerror = (e: ErrorEvent) => {
      console.error(`Worker error for ${task.imageId}/${task.deviceName}:`, e.message);
      this.onWorkerComplete();
    };
  }

  /**
   * Handle worker completion
   */
  private onWorkerComplete() {
    this.activeWorkers--;
    console.log(`[Queue] Worker completed. Active: ${this.activeWorkers}, Queued: ${this.queue.length}`);
    this.processQueue();
  }

  /**
   * Get queue status
   */
  getStatus(): { active: number; queued: number; max: number } {
    return {
      active: this.activeWorkers,
      queued: this.queue.length,
      max: this.maxConcurrentWorkers,
    };
  }
}

// Singleton instance
let workerQueue: WorkerQueueManager | null = null;

/**
 * Get the global worker queue instance
 */
export function getWorkerQueue(): WorkerQueueManager {
  if (!workerQueue) {
    workerQueue = new WorkerQueueManager(4);
  }
  return workerQueue;
}

/**
 * Queue image processing for all device sizes
 */
export async function queueImageProcessing(imageId: string) {
  console.log(`[Processing] Starting queue for image: ${imageId}`);
  const { getDb } = await import("../db/schema.ts");
  const db = getDb();

  // Get all registered devices
  const devices = db.prepare(`
    SELECT name, width, height
    FROM devices
    ORDER BY name
  `).all() as Array<{
    name: string;
    width: number;
    height: number;
  }>;

  if (devices.length === 0) {
    console.warn(`[Processing] No devices registered, skipping processing for ${imageId}`);
    return;
  }

  console.log(`[Processing] Found ${devices.length} device sizes for ${imageId}`);

  // Generate thumbnail first (before device processing)
  await generateImageThumbnail(imageId);

  // Queue tasks for each device size
  const queue = getWorkerQueue();
  const tasks = devices.map(device => ({
    imageId,
    deviceName: device.name,
    deviceWidth: device.width,
    deviceHeight: device.height,
  }));

  console.log(`[Processing] Queuing ${tasks.length} tasks for ${imageId}`);
  queue.enqueueMany(tasks);
}

/**
 * Generate thumbnail for an image (shared function)
 */
async function generateImageThumbnail(imageId: string) {
  const { getDb } = await import("../db/schema.ts");
  const { generateThumbnail } = await import("./image-processing.ts");
  
  const db = getDb();
  
  const image = db.prepare(
    "SELECT file_path, thumbnail_path FROM images WHERE id = ?"
  ).get(imageId) as { file_path: string; thumbnail_path: string | null } | undefined;

  if (!image) {
    console.error(`Image not found: ${imageId}`);
    return;
  }

  // Only generate if not already created
  if (!image.thumbnail_path) {
    console.log(`[Thumbnail] Generating thumbnail for ${imageId}`);
    try {
      const thumbnailPath = await generateThumbnail(image.file_path, imageId);
      db.prepare("UPDATE images SET thumbnail_path = ? WHERE id = ?").run(thumbnailPath, imageId);
      console.log(`[Thumbnail] ✓ Generated thumbnail for ${imageId}: ${thumbnailPath}`);
    } catch (error) {
      console.error(`[Thumbnail] ✗ Failed to generate thumbnail for ${imageId}:`, error);
    }
  } else {
    console.log(`[Thumbnail] Skipping ${imageId} (already exists at ${image.thumbnail_path})`);
  }
}
