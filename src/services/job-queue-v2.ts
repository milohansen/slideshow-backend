/**
 * Job Queue Service V2 - Batch-based processing
 * Triggers processor jobs with batch manifests instead of individual images
 */

import { JobsClient } from "@google-cloud/run";
import { getSourcesByStatus } from "../db/helpers.ts";

interface JobQueueConfig {
  projectId: string;
  region: string;
  jobName: string;
  backendApiUrl: string;
  authToken: string;
}

export interface ProcessingBatch {
  batchId: string;
  sourceIds: string[];
  createdAt: string;
}

class BatchJobQueue {
  private config: JobQueueConfig;
  private pendingSourceIds: Set<string> = new Set();
  private flushTimer: number | null = null;
  private readonly BATCH_SIZE = 50;
  private readonly FLUSH_DELAY_MS = 30000; // 30 seconds

  constructor(config: JobQueueConfig) {
    this.config = config;
    console.log(`[BatchQueue] Initialized for job: ${config.jobName}`);
  }

  /**
   * Queue a source for processing
   */
  async queueSource(sourceId: string): Promise<void> {
    console.log(`[BatchQueue] Queuing source: ${sourceId}`);
    
    this.pendingSourceIds.add(sourceId);

    // Trigger immediately if we've hit batch size
    if (this.pendingSourceIds.size >= this.BATCH_SIZE) {
      await this.flush();
    } else {
      // Otherwise, schedule a flush
      this.scheduleFlush();
    }
  }

  /**
   * Queue multiple sources at once
   */
  async queueBatch(sourceIds: string[]): Promise<void> {
    console.log(`[BatchQueue] Queuing ${sourceIds.length} sources`);
    
    for (const id of sourceIds) {
      this.pendingSourceIds.add(id);
    }

    if (this.pendingSourceIds.size >= this.BATCH_SIZE) {
      await this.flush();
    } else {
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
        console.error("[BatchQueue] Error during scheduled flush:", err)
      );
    }, this.FLUSH_DELAY_MS);
  }

  /**
   * Flush pending sources and trigger the Cloud Run Job
   */
  async flush(): Promise<void> {
    // Clear timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingSourceIds.size === 0) {
      return; // Nothing to flush
    }

    const sourceIds = Array.from(this.pendingSourceIds);
    const batchId = crypto.randomUUID();
    
    console.log(`[BatchQueue] Flushing batch ${batchId} with ${sourceIds.length} sources`);

    // Clear the pending set
    this.pendingSourceIds.clear();

    try {
      await this.triggerJob(batchId, sourceIds);
      console.log(`[BatchQueue] ✅ Successfully triggered job for batch ${batchId}`);
    } catch (error) {
      console.error("[BatchQueue] ❌ Failed to trigger job:", error);
      // Sources remain in 'staged' state, can be picked up by manual trigger
    }
  }

  /**
   * Trigger the Cloud Run Job with batch manifest
   */
  private async triggerJob(batchId: string, sourceIds: string[]): Promise<void> {
    const { config } = this;

    const client = new JobsClient();
    const jobPath = `projects/${config.projectId}/locations/${config.region}/jobs/${config.jobName}`;

    try {
      // Execute the job with batch information in environment variables
      const [operation] = await client.runJob({
        name: jobPath,
      }, {
        otherArgs: {
          env: [
              {
                name: "BATCH_ID",
                value: batchId,
              },
              {
                name: "SOURCE_IDS",
                value: JSON.stringify(sourceIds),
              },
              {
                name: "BACKEND_API_URL",
                value: config.backendApiUrl,
              },
              {
                name: "AUTH_TOKEN",
                value: config.authToken,
              },
            ],
        }
      });

      console.log(`[BatchQueue] Job execution started: ${operation.name}`);
    } catch (error) {
      console.error("[BatchQueue] Error triggering job:", error);
      throw error;
    }
  }

  /**
   * Trigger processing for all staged sources
   * Used for manual/admin-triggered batch processing
   */
  async processAllStaged(): Promise<void> {
    const stagedSources = getSourcesByStatus("staged", 1000);
    
    if (stagedSources.length === 0) {
      console.log("[BatchQueue] No staged sources to process");
      return;
    }

    const sourceIds = stagedSources.map(s => s.id);
    const batchId = crypto.randomUUID();
    
    console.log(`[BatchQueue] Triggering manual batch ${batchId} for ${sourceIds.length} staged sources`);
    
    await this.triggerJob(batchId, sourceIds);
  }
}

// Singleton instance
let queueInstance: BatchJobQueue | null = null;

/**
 * Initialize the job queue
 */
export function initJobQueue(config: JobQueueConfig): void {
  queueInstance = new BatchJobQueue(config);
}

/**
 * Get the job queue instance
 */
export function getJobQueue(): BatchJobQueue {
  if (!queueInstance) {
    throw new Error("Job queue not initialized. Call initJobQueue first.");
  }
  return queueInstance;
}

/**
 * Queue a single source for processing
 */
export async function queueSourceProcessing(sourceId: string): Promise<void> {
  const queue = getJobQueue();
  await queue.queueSource(sourceId);
}

/**
 * Queue multiple sources for processing
 */
export async function queueBatchProcessing(sourceIds: string[]): Promise<void> {
  const queue = getJobQueue();
  await queue.queueBatch(sourceIds);
}

/**
 * Manually trigger processing for all staged sources
 */
export async function processAllStagedSources(): Promise<void> {
  const queue = getJobQueue();
  await queue.processAllStaged();
}

/**
 * Force flush any pending sources
 */
export async function flushQueue(): Promise<void> {
  const queue = getJobQueue();
  await queue.flush();
}
