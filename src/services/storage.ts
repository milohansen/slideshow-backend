/**
 * Storage service for Google Cloud Storage
 * Handles uploading and retrieving image files
 */

import { Storage, UploadOptions } from "@google-cloud/storage";
import { Readable } from 'node:stream';

let storage: Storage | null = null;
let bucketName: string | null = null;

/**
 * Initialize Google Cloud Storage client
 */
export function initStorage() {
  bucketName = Deno.env.get("GCS_BUCKET_NAME") ?? null;
  
  if (!bucketName) {
    console.warn("⚠️  GCS_BUCKET_NAME not set, using local filesystem storage");
    return;
  }
  
  try {
    // In Cloud Run, credentials are automatically provided via ADC
    // For local development, set GOOGLE_APPLICATION_CREDENTIALS env var
    storage = new Storage();
    console.log(`✅ Google Cloud Storage initialized (bucket: ${bucketName})`);
  } catch (error) {
    console.error("Failed to initialize Google Cloud Storage:", error);
    storage = null;
  }
}

/**
 * Check if GCS is enabled and configured
 */
export function isGCSEnabled(): boolean {
  return storage !== null && bucketName !== null;
}

/**
 * Upload a file to Google Cloud Storage
 */
export async function uploadFile(
  localPath: string,
  gcsPath: string,
  contentType?: string
): Promise<string> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  try {
    const bucket = storage.bucket(bucketName);
    
    await bucket.upload(localPath, {
      destination: gcsPath,
      metadata: {
        contentType: contentType || "image/jpeg",
        cacheControl: "public, max-age=31536000",
      },
    } as unknown as UploadOptions);
    
    // Return the GCS URI
    return `gs://${bucketName}/${gcsPath}`;
  } catch (error) {
    console.error(`Failed to upload ${localPath} to GCS:`, error);
    throw error;
  }
}

/**
 * Download a file from Google Cloud Storage to local temp file
 */
export async function downloadFile(
  gcsPath: string,
  localPath: string
): Promise<void> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(gcsPath);
    
    await file.download({ destination: localPath });
  } catch (error) {
    console.error(`Failed to download ${gcsPath} from GCS:`, error);
    throw error;
  }
}

/**
 * Get a signed URL for temporary access to a file
 */
export async function getSignedUrl(
  gcsPath: string,
  expiresInMinutes = 60
): Promise<string> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(gcsPath);
    
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresInMinutes * 60 * 1000,
    });
    
    return url;
  } catch (error) {
    console.error(`Failed to get signed URL for ${gcsPath}:`, error);
    throw error;
  }
}

/**
 * Read a file directly from GCS as a buffer
 */
export async function readFile(gcsPath: string): Promise<Uint8Array> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(gcsPath);
    
    const [contents] = await file.download();
    return contents;
  } catch (error) {
    console.error(`Failed to read ${gcsPath} from GCS:`, error);
    throw error;
  }
}

/**
 * Create a read stream for a file in GCS (for streaming responses)
 * Returns a Web ReadableStream compatible with Deno/Web APIs
 */
export function createReadStream(gcsPath: string): ReadableStream<Uint8Array> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsPath);
  
  // Create Node.js ReadableStream from GCS
  const nodeStream = file.createReadStream();

  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  
  // Convert Node.js stream to Web ReadableStream
  // return new ReadableStream({
  //   start(controller) {
  //     nodeStream.on("data", (chunk: Buffer) => {
  //       controller.enqueue(new Uint8Array(chunk));
  //     });
      
  //     nodeStream.on("end", () => {
  //       controller.close();
  //     });
      
  //     nodeStream.on("error", (error) => {
  //       console.error(`Stream error for ${gcsPath}:`, error);
  //       controller.error(error);
  //     });
  //   },
  //   cancel() {
  //     nodeStream.destroy();
  //   },
  // });
}

/**
 * Check if a file exists in GCS
 */
export async function fileExists(gcsPath: string): Promise<boolean> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    return false;
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(gcsPath);
    const [exists] = await file.exists();
    return exists;
  } catch (error) {
    console.error(`Failed to check existence of ${gcsPath}:`, error);
    return false;
  }
}

/**
 * Delete a file from GCS
 */
export async function deleteFile(gcsPath: string): Promise<void> {
  if (!isGCSEnabled() || !storage || !bucketName) {
    throw new Error("Google Cloud Storage not initialized");
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(gcsPath);
    await file.delete();
  } catch (error) {
    console.error(`Failed to delete ${gcsPath} from GCS:`, error);
    throw error;
  }
}

/**
 * Get public URL for a file (if bucket is public)
 */
export function getPublicUrl(gcsPath: string): string {
  if (!bucketName) {
    throw new Error("GCS_BUCKET_NAME not configured");
  }
  return `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
}

/**
 * Parse GCS URI to extract bucket and path
 */
export function parseGCSUri(uri: string): { bucket: string; path: string } | null {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], path: match[2] };
}

/**
 * Convert local file path to GCS path
 */
export function localPathToGCSPath(localPath: string): string {
  // Remove leading data/ or ./data/ and convert to GCS path
  return localPath
    .replace(/^\.?\/?(data\/)?/, "")
    .replace(/\\/g, "/");
}
