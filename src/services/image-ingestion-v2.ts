/**
 * Image Ingestion Service V2 - Staging-based approach
 * This service creates STAGED source records without processing
 * Processing is deferred to the processor job
 */

import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { readdirSync, renameSync, statSync, unlinkSync } from "fs";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { createSource } from "../db/helpers-firestore.ts";
import { downloadMediaItem, type PickedMediaItem } from "./google-photos.ts";
import { isGCSEnabled, uploadFile } from "./storage.ts";

export type StagedImageInput = {
  localPath: string;
  origin: "upload" | "url" | "google_photos";
  userId?: string;
  externalId?: string; // Google Photos ID, URL, etc.
};

export type IngestionResult = {
  sourceId: string;
  status: "staged" | "duplicate";
  blobHash?: string; // Set if duplicate detected
  message?: string;
};

/**
 * Calculate SHA-256 hash of a file
 */
async function calculateFileHash(filePath: string): Promise<string> {
  const fileData = await readFile(filePath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileData);
  return encodeHex(new Uint8Array(hashBuffer));
}

/**
 * Stage an image for processing
 * This creates a source record and uploads to staging bucket
 * Returns immediately without processing
 */
export async function stageImageForProcessing(input: StagedImageInput): Promise<IngestionResult> {
  const sourceId = crypto.randomUUID();

  try {
    // Calculate hash for optional duplicate detection
    // Note: Full duplicate detection happens in processor after download
    // const fileHash = await calculateFileHash(input.localPath);

    // Upload to staging bucket
    let stagingPath: string;

    if (isGCSEnabled()) {
      const ext = input.localPath.substring(input.localPath.lastIndexOf("."));
      const gcsPath = `staging/${sourceId}${ext}`;
      stagingPath = await uploadFile(input.localPath, gcsPath, "image/jpeg");
      console.log(`  Uploaded to staging: ${stagingPath}`);

      // Clean up local file after successful upload
      try {
        unlinkSync(input.localPath);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      // For local development, move to staging directory
      const stagingDir = "data/staging";
      await ensureDir(stagingDir);
      const ext = input.localPath.substring(input.localPath.lastIndexOf("."));
      stagingPath = join(stagingDir, `${sourceId}${ext}`);
      renameSync(input.localPath, stagingPath);
    }

    // Create source record with STAGED status
    await createSource({
      id: sourceId,
      user_id: input.userId,
      blob_hash: undefined, // Will be set by processor
      origin: input.origin,
      external_id: input.externalId,
      status: "staged",
      status_message: "Awaiting processing",
      staging_path: stagingPath,
    });

    console.log(`  ✓ Staged source ${sourceId} for processing`);

    return {
      sourceId,
      status: "staged",
    };
  } catch (error) {
    console.error(`  ✗ Failed to stage image:`, error);
    throw error;
  }
}

/**
 * Stage multiple images as a batch
 * Returns array of results
 */
export async function stageBatch(inputs: StagedImageInput[]): Promise<IngestionResult[]> {
  const results: IngestionResult[] = [];

  for (const input of inputs) {
    try {
      const result = await stageImageForProcessing(input);
      results.push(result);
    } catch (error) {
      console.error(`Failed to stage ${input.localPath}:`, error);
      let message = "Unknown error";
      if (error instanceof Error) {
        message = error.message;
      }
      results.push({
        sourceId: "",
        status: "staged",
        message: `Error: ${message}`,
      });
    }
  }

  return results;
}

/**
 * Create a staged source record for a file already in GCS staging
 * Used when clients upload directly to GCS via signed URLs
 */
export function createStagedSourceFromGCS(params: { gcsPath: string; origin: "upload" | "url"; userId?: string; externalId?: string }): string {
  const sourceId = crypto.randomUUID();

  createSource({
    id: sourceId,
    user_id: params.userId,
    blob_hash: undefined,
    origin: params.origin,
    external_id: params.externalId,
    status: "staged",
    status_message: "Awaiting processing",
    staging_path: params.gcsPath,
  });

  return sourceId;
}

/**
 * Helper to get staging directory for local development
 */
export function getStagingDirectory(): string {
  return "data/staging";
}

/**
 * Clean up staging files older than N days
 */
export async function cleanupStagingFiles(daysOld: number = 7): Promise<number> {
  if (isGCSEnabled()) {
    console.log("GCS staging cleanup not yet implemented");
    return 0;
  }

  const stagingDir = getStagingDirectory();
  let cleaned = 0;

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const entries = readdirSync(stagingDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(stagingDir, entry.name);
        const stat = statSync(filePath);

        if (stat.mtime && stat.mtime < cutoffDate) {
          unlinkSync(filePath);
          cleaned++;
        }
      }
    }
  } catch (error) {
    console.error("Error cleaning staging files:", error);
  }

  return cleaned;
}

/**
 * Ingest images from Google Photos
 * Stages each image for processing
 */
export async function ingestFromGooglePhotos(
  accessToken: string,
  images: PickedMediaItem[] // PickedMediaItem array from google-photos service
): Promise<{ ingested: number; skipped: number; failed: number; details: Array<{ id: string; status: string; message?: string }> }> {
  const details = await Promise.all(
    images.map(async (image) => {
      try {
        // save the original to GCS staging and create source record
        const fileData = await downloadMediaItem(accessToken, image.mediaFile.baseUrl);

        // Write to temporary file
        const tempDir = await mkdtemp(`${tmpdir()}/slideshow-backend`);
        const ext = image.mediaFile.filename.substring(image.mediaFile.filename.lastIndexOf("."));
        const tempPath = `${tempDir}/${crypto.randomUUID()}${ext}`;

        await writeFile(tempPath, fileData);

        const result = await stageImageForProcessing({
          localPath: tempPath, // Use Google Photos ID as identifier (will be resolved by processor)
          origin: "google_photos",
          externalId: image.id,
          userId: undefined, // Set by upstream auth context
        });

        if (result.status === "staged") {
          return {
            id: image.id,
            status: "ingested",
            message: `Source ${result.sourceId} staged for processing`,
          };
        } else {
          return {
            id: image.id,
            status: "skipped",
            message: result.message || "Image already exists (duplicate)",
          };
        }
      } catch (error) {
        console.error(`Failed to ingest Google Photos image ${image.id}:`, error);
        return {
          id: image.id,
          status: "failed",
          message: error instanceof Error ? error.message : "Unknown error",
        };
      }
    })
  );

  const results = {
    ingested: 0,
    skipped: 0,
    failed: 0,
    details,
  };

  for (const detail of details) {
    results[detail.status as "ingested" | "skipped" | "failed"]++;
  }

  // const results = {
  //   ingested: 0,
  //   skipped: 0,
  //   failed: 0,
  //   details: [] as Array<{ id: string; status: string; message?: string }>,
  // };

  // for (const image of images) {
  //   try {
  //     // For Google Photos, we'll stage the image with the external ID
  //     // The actual download and processing happens in the processor service
  //     const result = await stageImageForProcessing({
  //       localPath: image.id, // Use Google Photos ID as identifier (will be resolved by processor)
  //       origin: "google_photos",
  //       externalId: image.id,
  //       userId: undefined, // Set by upstream auth context
  //     });

  //     if (result.status === "staged") {
  //       results.ingested++;
  //       results.details.push({
  //         id: image.id,
  //         status: "ingested",
  //         message: `Source ${result.sourceId} staged for processing`,
  //       });
  //     } else {
  //       results.skipped++;
  //       results.details.push({
  //         id: image.id,
  //         status: "skipped",
  //         message: result.message || "Image already exists (duplicate)",
  //       });
  //     }
  //   } catch (error) {
  //     results.failed++;
  //     results.details.push({
  //       id: image.id,
  //       status: "failed",
  //       message: error instanceof Error ? error.message : "Unknown error",
  //     });
  //     console.error(`Failed to ingest Google Photos image ${image.id}:`, error);
  //   }
  // }

  return results;
}
