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
  private imageTaskCounts = new Map<string, { total: number; completed: number; failed: number }>();

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
      this.onWorkerComplete(task.imageId, success, error);
    };

    worker.onerror = (e: ErrorEvent) => {
      console.error(`Worker error for ${task.imageId}/${task.deviceName}:`, e.message);
      this.onWorkerComplete();
    };
  }

  /**
   * Handle worker completion
   */
  private async onWorkerComplete(imageId: string, success: boolean, error?: string) {
    this.activeWorkers--;
    console.log(`[Queue] Worker completed. Active: ${this.activeWorkers}, Queued: ${this.queue.length}`);
    
    // Update task counts for this image
    const taskCount = this.imageTaskCounts.get(imageId);
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
  }));

  console.log(`[Processing] Queuing ${tasks.length} tasks for ${imageId}`);
  queue.enqueueMany(tasks, imageId);
}
