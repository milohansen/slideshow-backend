import { getDb } from "../db/schema.ts";
import { walk } from "@std/fs/walk";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

interface ImageMetadata {
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  lastModified: Date;
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
 * Extract image dimensions from file
 * Returns [width, height]
 */
async function getImageDimensions(filePath: string): Promise<[number, number]> {
  // Use ImageMagick identify command if available, otherwise use a simple approach
  try {
    const command = new Deno.Command("identify", {
      args: ["-format", "%w %h", filePath],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout } = await command.output();
    
    if (code === 0) {
      const output = new TextDecoder().decode(stdout).trim();
      const [width, height] = output.split(" ").map(Number);
      return [width, height];
    }
  } catch {
    // ImageMagick not available, fall through
  }

  // Fallback: Try using ffprobe for image dimensions
  try {
    const command = new Deno.Command("ffprobe", {
      args: [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0",
        filePath
      ],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout } = await command.output();
    
    if (code === 0) {
      const output = new TextDecoder().decode(stdout).trim();
      const [width, height] = output.split("x").map(Number);
      return [width, height];
    }
  } catch {
    // ffprobe not available
  }

  throw new Error(`Unable to extract dimensions from ${filePath}. Please install ImageMagick or ffmpeg.`);
}

/**
 * Determine image orientation based on dimensions
 */
function determineOrientation(width: number, height: number): "portrait" | "landscape" | "square" {
  const ratio = width / height;
  
  if (Math.abs(ratio - 1) < 0.05) {
    return "square";
  } else if (width > height) {
    return "landscape";
  } else {
    return "portrait";
  }
}

/**
 * Extract metadata from an image file
 */
async function extractImageMetadata(filePath: string): Promise<ImageMetadata> {
  const [width, height] = await getImageDimensions(filePath);
  const fileHash = await calculateFileHash(filePath);
  const fileInfo = await Deno.stat(filePath);
  const lastModified = fileInfo.mtime || new Date();
  const orientation = determineOrientation(width, height);

  return {
    filePath,
    fileHash,
    width,
    height,
    orientation,
    lastModified,
  };
}

/**
 * Check if image already exists in database (by hash)
 */
function imageExists(fileHash: string): boolean {
  const db = getDb();
  const result = db.prepare("SELECT id FROM images WHERE file_hash = ?").get(fileHash);
  return result !== undefined;
}

/**
 * Store image metadata in database
 */
function storeImageMetadata(id: string, metadata: ImageMetadata): void {
  const db = getDb();
  
  db.prepare(`
    INSERT INTO images (
      id, file_path, file_hash, width, height, orientation, last_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      width = excluded.width,
      height = excluded.height,
      orientation = excluded.orientation,
      last_modified = excluded.last_modified
  `).run(
    id,
    metadata.filePath,
    metadata.fileHash,
    metadata.width,
    metadata.height,
    metadata.orientation,
    metadata.lastModified.toISOString()
  );
}

/**
 * Generate a unique ID for an image
 */
function generateImageId(): string {
  return crypto.randomUUID();
}

/**
 * Scan a directory for images and ingest them into the database
 */
export async function ingestImagesFromDirectory(
  directoryPath: string,
  options: {
    recursive?: boolean;
    verbose?: boolean;
  } = {}
): Promise<{
  processed: number;
  skipped: number;
  errors: number;
}> {
  const { recursive = true, verbose = false } = options;
  
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for await (const entry of walk(directoryPath, {
      maxDepth: recursive ? Infinity : 1,
      includeFiles: true,
      includeDirs: false,
      followSymlinks: false,
    })) {
      // Check if file has supported extension
      const ext = entry.path.substring(entry.path.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        continue;
      }

      try {
        if (verbose) {
          console.log(`Processing: ${entry.path}`);
        }

        // Extract metadata
        const metadata = await extractImageMetadata(entry.path);

        // Check if already exists (by hash to avoid duplicates)
        if (imageExists(metadata.fileHash)) {
          if (verbose) {
            console.log(`  Skipped (duplicate): ${entry.path}`);
          }
          skipped++;
          continue;
        }

        // Store in database
        const imageId = generateImageId();
        storeImageMetadata(imageId, metadata);

        if (verbose) {
          console.log(`  ✓ Ingested: ${entry.path} (${metadata.width}x${metadata.height}, ${metadata.orientation})`);
        }
        processed++;
      } catch (error) {
        console.error(`Error processing ${entry.path}:`, error);
        errors++;
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${directoryPath}:`, error);
    throw error;
  }

  return { processed, skipped, errors };
}

/**
 * Get statistics about ingested images
 */
export function getImageStats(): {
  total: number;
  byOrientation: Record<string, number>;
} {
  const db = getDb();
  
  const total = db.prepare("SELECT COUNT(*) as count FROM images").get() as { count: number };
  
  const byOrientation = db.prepare(`
    SELECT orientation, COUNT(*) as count 
    FROM images 
    GROUP BY orientation
  `).all() as Array<{ orientation: string; count: number }>;

  const orientationMap: Record<string, number> = {};
  for (const row of byOrientation) {
    orientationMap[row.orientation] = row.count;
  }

  return {
    total: total.count,
    byOrientation: orientationMap,
  };
}
