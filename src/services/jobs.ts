import { JobsClient } from "@google-cloud/run";

type JobQueueConfig = {
  projectId?: string;
  region?: string;
  jobName?: string;
  backendApiUrl?: string;
  authToken?: string;
};

export type ProcessingBatch = {
  batchId: string;
  sourceIds: string[];
  createdAt: string;
};

export async function runJob(targetId: string, config: JobQueueConfig = { projectId: process.env.GCP_PROJECT_ID, region: "northamerica-northeast1", jobName: "slideshow-processor" }) {
  const client = new JobsClient();
  const jobPath = `projects/${config.projectId}/locations/${config.region}/jobs/${config.jobName}`;
  try {
    // Execute the job with batch information in environment variables
    const [operation] = await client.runJob({
      name: jobPath,
      overrides: {
        containerOverrides: [
          {
            env: [
              {
                name: "TARGET_FILE_ID",
                value: targetId,
              },
            ],
          },
        ],
      },
    });

    console.log(`[runJob] Job execution started: ${operation.name}`);
  } catch (error) {
    console.error("[runJob] Error triggering job:", error);
    throw error;
  }
}
