/**
 * Image Ingestion Service V2 - Staging-based approach
 * This service creates STAGED source records without processing
 * Processing is deferred to the processor job
 */

import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { createSource, type Source } from "../db/helpers.ts";
import { isGCSEnabled, uploadFile } from "./storage.ts";

export interface StagedImageInput {
  localPath: string;
  origin: "upload" | "google_photos" | "url";
  userId?: string;
  externalId?: string; // Google Photos ID, URL, etc.
}

export interface IngestionResult {
  sourceId: string;
  status: "staged" | "duplicate";
  blobHash?: string; // Set if duplicate detected
  message?: string;
}

/**
 * Calculate SHA-256 hash of a file
 */
async function calculateFileHash(filePath: string): Promise<string> {
  const fileData = await Deno.readFile(filePath);
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
    const fileHash = await calculateFileHash(input.localPath);
    
    // Upload to staging bucket
    let stagingPath: string;
    
    if (isGCSEnabled()) {
      const ext = input.localPath.substring(input.localPath.lastIndexOf("."));
      const gcsPath = `staging/${sourceId}${ext}`;
      stagingPath = await uploadFile(input.localPath, gcsPath, "image/jpeg");
      console.log(`  Uploaded to staging: ${stagingPath}`);
      
      // Clean up local file after successful upload
      try {
        await Deno.remove(input.localPath);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      // For local development, move to staging directory
      const stagingDir = "data/staging";
      await ensureDir(stagingDir);
      const ext = input.localPath.substring(input.localPath.lastIndexOf("."));
      stagingPath = join(stagingDir, `${sourceId}${ext}`);
      await Deno.rename(input.localPath, stagingPath);
    }
    
    // Create source record with STAGED status
    createSource({
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
      results.push({
        sourceId: "",
        status: "staged",
        message: `Error: ${error.message}`,
      });
    }
  }
  
  return results;
}

/**
 * Create a staged source record for a file already in GCS staging
 * Used when clients upload directly to GCS via signed URLs
 */
export function createStagedSourceFromGCS(params: {
  gcsPath: string;
  origin: "upload" | "url";
  userId?: string;
  externalId?: string;
}): string {
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
    
    for await (const entry of Deno.readDir(stagingDir)) {
      if (entry.isFile) {
        const filePath = join(stagingDir, entry.name);
        const stat = await Deno.stat(filePath);
        
        if (stat.mtime && stat.mtime < cutoffDate) {
          await Deno.remove(filePath);
          cleaned++;
        }
      }
    }
  } catch (error) {
    console.error("Error cleaning staging files:", error);
  }
  
  return cleaned;
}
