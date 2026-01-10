/**
 * Worker queue manager for processing images
 * Manages concurrent worker execution with throttling
 */

interface QueueTask {
  imageId: string;
  deviceName: string;
  deviceWidth: number;
  deviceHeight: number;
  googlePhotosBaseUrl?: string; // Optional Google Photos URL for API resizing
}

class WorkerQueueManager {
  private queue: QueueTask[] = [];
  private activeWorkers = 0;
  private maxConcurrentWorkers: number;
  private workerUrl: URL;
  private imageTaskCounts = new Map<string, { total: number; completed: number; failed: number }>();

  constructor(maxConcurrentWorkers = 4) {
    this.maxConcurrentWorkers = maxConcurrentWorkers;
    this.workerUrl = new URL("../workers/image-processor.ts", import.meta.url);
    console.log(`[WorkerQueue] Initialized with maxConcurrentWorkers=${maxConcurrentWorkers}`);
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
  enqueueMany(tasks: QueueTask[], imageId?: string) {
    if (imageId && tasks.length > 0) {
      this.imageTaskCounts.set(imageId, { total: tasks.length, completed: 0, failed: 0 });
    }
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
        // Don't await - let workers spawn asynchronously
        this.spawnWorker(task).catch(err => {
          console.error(`[Queue] Error spawning worker for ${task.imageId}/${task.deviceName}:`, err);
          this.onWorkerComplete(task.imageId, false, err.message);
        });
      }
    }
  }

  /**
   * Spawn a worker to process a single task
   */
  private async spawnWorker(task: QueueTask) {
    this.activeWorkers++;
    console.log(`[Queue] ⚡ Spawning worker (${this.activeWorkers}/${this.maxConcurrentWorkers}): ${task.imageId} for ${task.deviceName}`);
    console.log(`[Queue] 📋 Queue status: ${this.queue.length} tasks queued, ${this.activeWorkers} active workers`);

    // Fetch image data from database
    const { getDb } = await import("../db/schema.ts");
    const db = getDb();
    
    // Get image data
    const imageData = db.prepare("SELECT id, file_path, width, height FROM images WHERE id = ?").get(task.imageId) as {
      id: string;
      file_path: string;
      width: number;
      height: number;
    } | undefined;
    
    if (!imageData) {
      console.error(`[Queue] ❌ Image not found: ${task.imageId}`);
      this.onWorkerComplete(task.imageId, false, "Image not found");
      return;
    }
    
    // Check if already processed
    const existing = db.prepare(
      "SELECT * FROM processed_images WHERE image_id = ? AND device_size = ?"
    ).get(task.imageId, task.deviceName);
    
    if (existing) {
      console.log(`[Queue] ⏩ Image ${task.imageId} already processed for ${task.deviceName}, skipping`);
      this.onWorkerComplete(task.imageId, true);
      return;
    }

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

    // Set up message handler before posting any messages
    worker.onmessage = async (e: MessageEvent) => {
      console.log(`[Queue] 📨 Received message from worker for ${task.imageId}/${task.deviceName}:`, e.data);
      
      // Handle task completion
      const { success, result, error } = e.data;
      if (success && result) {
        console.log(`[Worker] ✓ Completed: ${result.imageId} for ${task.deviceName}`);
        // Store result in database
        await this.storeProcessedImage(result);
        this.onWorkerComplete(task.imageId, true);
      } else {
        console.error(`[Worker] ✗ Failed: ${task.imageId} for ${task.deviceName}:`, error);
        this.onWorkerComplete(task.imageId, false, error);
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      console.error(`[Queue] ❌ Worker error for ${task.imageId}/${task.deviceName}:`, e.message);
      console.error(`[Queue] Error details:`, e);
      this.onWorkerComplete(task.imageId, false, e.message);
    };
    
    // Post task data to worker immediately
    console.log(`[Queue] 📤 Posting task with image data to worker`);
    worker.postMessage({
      imageData,
      deviceName: task.deviceName,
      deviceWidth: task.deviceWidth,
      deviceHeight: task.deviceHeight,
      googlePhotosBaseUrl: task.googlePhotosBaseUrl,
      outputDir: "data/processed",
    });
  }

  /**
   * Store processed image result to database
   */
  private async storeProcessedImage(result: {
    processedId: string;
    imageId: string;
    deviceSize: string;
    width: number;
    height: number;
    filePath: string;
    colorPalette: any;
  }) {
    const { getDb } = await import("../db/schema.ts");
    const db = getDb();
    
    console.log(`[Queue] 💾 Storing processed image ${result.imageId} for ${result.deviceSize} in database`);
    db.prepare(`
      INSERT INTO processed_images (
        id, image_id, device_size, width, height, file_path,
        color_primary, color_secondary, color_tertiary, color_source, color_palette
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.processedId,
      result.imageId,
      result.deviceSize,
      result.width,
      result.height,
      result.filePath,
      result.colorPalette.primary,
      result.colorPalette.secondary,
      result.colorPalette.tertiary,
      result.colorPalette.sourceColor,
      JSON.stringify(result.colorPalette)
    );
    console.log(`[Queue] ✅ Database insert completed for ${result.imageId}/${result.deviceSize}`);
  }

  /**
   * Handle worker completion
   */
  private async onWorkerComplete(imageId: string, success: boolean, error?: string) {
    console.log(`[Queue] 🏁 onWorkerComplete called for ${imageId}, success=${success}, error=${error}`);
    this.activeWorkers--;
    console.log(`[Queue] 📊 Worker completed. Active: ${this.activeWorkers}, Queued: ${this.queue.length}`);
    
    // Update task counts for this image
    const taskCount = this.imageTaskCounts.get(imageId);
    console.log(`[Queue] 📈 Task count for ${imageId}:`, taskCount);
    if (taskCount) {
      if (success) {
        taskCount.completed++;
      } else {
        taskCount.failed++;
      }
      
      // Check if all tasks for this image are complete
      const total = taskCount.completed + taskCount.failed;
      if (total >= taskCount.total) {
        console.log(`[Queue] All tasks completed for ${imageId}: ${taskCount.completed} successful, ${taskCount.failed} failed`);
        
        // Update database status
        const { getDb } = await import("../db/schema.ts");
        const db = getDb();
        
        if (taskCount.failed > 0) {
          db.prepare("UPDATE images SET processing_status = 'failed', processing_error = ?, processing_app_id = NULL WHERE id = ?").run(
            `Processing failed for ${taskCount.failed}/${taskCount.total} device sizes`,
            imageId
          );
        } else {
          db.prepare("UPDATE images SET processing_status = 'complete', processing_error = NULL, processing_app_id = NULL WHERE id = ?").run(imageId);
        }
        
        // Clean up tracking
        this.imageTaskCounts.delete(imageId);
      }
    }
    
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
    console.log(`[WorkerQueue] Creating new WorkerQueueManager instance`);
    workerQueue = new WorkerQueueManager(4);
  }
  return workerQueue;
}

/**
 * Queue image processing for all device sizes
 * @param imageId - The image ID to process
 * @param googlePhotosBaseUrl - Optional Google Photos base URL for API resizing
 */
export async function queueImageProcessing(imageId: string, googlePhotosBaseUrl?: string) {
  console.log(`[Processing] Starting queue for image: ${imageId}`);
  const { getDb } = await import("../db/schema.ts");
  const { generateImageThumbnail } = await import("./image-processing.ts");
  const db = getDb();

  // Get app instance ID from main.ts
  const { APP_INSTANCE_ID } = await import("../main.ts");

  // Set status to processing and mark with our app instance ID
  db.prepare("UPDATE images SET processing_status = 'processing', processing_app_id = ? WHERE id = ?").run(APP_INSTANCE_ID, imageId);

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
    db.prepare("UPDATE images SET processing_status = 'complete', processing_app_id = NULL WHERE id = ?").run(imageId);
    return;
  }

  console.log(`[Processing] Found ${devices.length} device sizes for ${imageId}`);

  // Generate thumbnail first (before device processing)
  try {
    await generateImageThumbnail(imageId);
  } catch (error) {
    console.error(`[Processing] Failed to generate thumbnail for ${imageId}:`, error);
    db.prepare("UPDATE images SET processing_status = 'failed', processing_error = ?, processing_app_id = NULL WHERE id = ?").run(
      `Thumbnail generation failed: ${error.message}`,
      imageId
    );
    return;
  }

  // Queue tasks for each device size
  const queue = getWorkerQueue();
  const tasks = devices.map(device => ({
    imageId,
    deviceName: device.name,
    deviceWidth: device.width,
    deviceHeight: device.height,
    googlePhotosBaseUrl, // Pass through the optional Google Photos URL
  }));

  console.log(`[Processing] Queuing ${tasks.length} tasks for ${imageId}`);
  queue.enqueueMany(tasks, imageId);
}
