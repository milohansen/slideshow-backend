/**
 * Cloud Tasks Queue Service
 * Manages image processing tasks via GCP Cloud Tasks
 */

import { CloudTasksClient } from "@google-cloud/tasks";
import { Buffer } from "node:buffer";

interface TaskQueueConfig {
  projectId: string;
  location: string;
  queueName: string;
  workflowUrl: string;
  serviceAccountEmail: string;
}

class CloudTaskQueue {
  private config: TaskQueueConfig;
  private client: CloudTasksClient;
  private queuePath: string;

  constructor(config: TaskQueueConfig) {
    this.config = config;
    this.client = new CloudTasksClient();
    this.queuePath = this.client.queuePath(
      config.projectId,
      config.location,
      config.queueName
    );
    console.log(`[CloudTasks] Initialized queue: ${this.queuePath}`);
  }

  /**
   * Create a task for processing a single image via Workflow
   */
  async createTask(imageId: string): Promise<void> {
    console.log(`[CloudTasks] Creating task for image: ${imageId}`);

    const payload = JSON.stringify({ 
      argument: JSON.stringify({ file_id: imageId })
    });
    
    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url: this.config.workflowUrl,
        headers: {
          "Content-Type": "application/json",
        },
        body: Buffer.from(payload).toString("base64"),
        oidcToken: {
          serviceAccountEmail: this.config.serviceAccountEmail,
        },
      },
    };

    try {
      const [response] = await this.client.createTask({
        parent: this.queuePath,
        task,
      });
      console.log(`[CloudTasks] ✅ Task created: ${response.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CloudTasks] ❌ Failed to create task for ${imageId}:`, errorMessage);
      throw error;
    }
  }
}

// Singleton instance
let taskQueue: CloudTaskQueue | null = null;

/**
 * Initialize the Cloud Tasks queue
 */
export function initJobQueue() {
  const projectId = Deno.env.get("GCP_PROJECT_ID") || Deno.env.get("GOOGLE_CLOUD_PROJECT");
  const location = Deno.env.get("CLOUD_TASKS_LOCATION") || "northamerica-northeast1";
  const queueName = Deno.env.get("CLOUD_TASKS_QUEUE") || "image-processing-queue";
  const workflowUrl = Deno.env.get("WORKFLOW_URL");
  const serviceAccountEmail = Deno.env.get("WORKFLOW_SERVICE_ACCOUNT");

  if (!projectId) {
    console.warn("⚠️ GCP_PROJECT_ID not set - task queue will not function");
    return;
  }

  if (!workflowUrl) {
    console.warn("⚠️ WORKFLOW_URL not set - task queue will not function");
    return;
  }

  if (!serviceAccountEmail) {
    console.warn("⚠️ WORKFLOW_SERVICE_ACCOUNT not set - using default service account");
  }

  taskQueue = new CloudTaskQueue({
    projectId,
    location,
    queueName,
    workflowUrl,
    serviceAccountEmail: serviceAccountEmail || `${projectId}@appspot.gserviceaccount.com`,
  });

  console.log("✅ Cloud Tasks queue manager initialized");
}

/**
 * Queue an image for processing
 * This is called from image-ingestion.ts when new images are added
 */
export async function queueImageProcessing(imageId: string): Promise<void> {
  if (!taskQueue) {
    console.warn("[CloudTasks] Task queue not initialized, skipping queue");
    return;
  }

  await taskQueue.createTask(imageId);
}

/**
 * Get queue status (Cloud Tasks manages queue state)
 */
export function getQueueStatus() {
  if (!taskQueue) {
    return { initialized: false };
  }

  return {
    initialized: true,
    type: "cloud-tasks",
  };
}

/**
 * Shutdown the queue manager
 */
export async function shutdownJobQueue(): Promise<void> {
  if (!taskQueue) {
    return;
  }

  console.log("[CloudTasks] Shutting down...");
  taskQueue = null;
}
