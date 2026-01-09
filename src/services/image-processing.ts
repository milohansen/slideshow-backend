/**
 * Image processing service using ImageMagick for resizing
 * and color extraction
 */

import { getDb } from "../db/schema.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { crypto } from "@std/crypto";

export interface DeviceSize {
  name: string;
  width: number;
  height: number;
}

export interface ColorPalette {
  primary: string;
  secondary: string;
  tertiary: string;
  allColors: string[];
}

interface ProcessedImageData {
  id: string;
  imageId: string;
  deviceSize: string;
  width: number;
  height: number;
  filePath: string;
  colorPalette: ColorPalette;
}

/**
 * Load configuration settings
 */
export async function loadConfig() {
  const configPath = "config/settings.json";
  const configText = await Deno.readTextFile(configPath);
  return JSON.parse(configText);
}

/**
 * Extract dominant colors from an image using ImageMagick
 */
async function extractColors(imagePath: string, numColors = 8): Promise<string[]> {
  const command = new Deno.Command("magick", {
    args: [
      imagePath,
      "-resize", "100x100",
      "-colors", numColors.toString(),
      "-unique-colors",
      "-format", "%c",
      "histogram:info:-"
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to extract colors: ${error}`);
  }

  const output = new TextDecoder().decode(stdout);
  const colors: string[] = [];

  // Parse ImageMagick histogram output
  // Format: "count: (r,g,b) #hex color-name"
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})/);
    if (hexMatch) {
      colors.push(`#${hexMatch[1]}`);
    }
  }

  return colors;
}

/**
 * Calculate color similarity (0-1, where 1 is identical)
 */
export function calculateColorSimilarity(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return 0;

  // Euclidean distance in RGB space
  const distance = Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );

  // Normalize to 0-1 (max distance is ~441)
  return 1 - (distance / 441);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Calculate palette similarity between two images
 */
export function calculatePaletteSimilarity(
  palette1: ColorPalette,
  palette2: ColorPalette
): number {
  // Compare primary, secondary, and tertiary colors with weights
  const primarySim = calculateColorSimilarity(palette1.primary, palette2.primary);
  const secondarySim = calculateColorSimilarity(palette1.secondary, palette2.secondary);
  const tertiarySim = calculateColorSimilarity(palette1.tertiary, palette2.tertiary);

  // Weighted average (primary is most important)
  return (primarySim * 0.5) + (secondarySim * 0.3) + (tertiarySim * 0.2);
}

/**
 * Resize image to target dimensions
 */
async function resizeImage(
  sourcePath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  await ensureDir(join(outputPath, ".."));

  const command = new Deno.Command("magick", {
    args: [
      sourcePath,
      "-resize", `${width}x${height}^`,
      "-gravity", "center",
      "-extent", `${width}x${height}`,
      "-quality", "90",
      outputPath
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to resize image: ${error}`);
  }
}

/**
 * Process a single image for a specific device size
 */
export async function processImageForDevice(
  imageId: string,
  deviceSize: DeviceSize,
  outputDir: string
): Promise<ProcessedImageData> {
  const db = getDb();

  // Get original image info
  const image = db.prepare("SELECT * FROM images WHERE id = ?").get(imageId) as {
    id: string;
    file_path: string;
    width: number;
    height: number;
  } | undefined;

  if (!image) {
    throw new Error(`Image not found: ${imageId}`);
  }

  // Check if already processed
  const existing = db.prepare(
    "SELECT * FROM processed_images WHERE image_id = ? AND device_size = ?"
  ).get(imageId, deviceSize.name) as ProcessedImageData | undefined;

  if (existing) {
    return {
      ...existing,
      colorPalette: JSON.parse(existing.colorPalette as unknown as string),
    };
  }

  // Generate output path
  const ext = image.file_path.substring(image.file_path.lastIndexOf("."));
  const outputPath = join(
    outputDir,
    deviceSize.name,
    `${imageId}${ext}`
  );

  // Resize image
  await resizeImage(image.file_path, outputPath, deviceSize.width, deviceSize.height);

  // Extract colors
  const colors = await extractColors(outputPath);

  const colorPalette: ColorPalette = {
    primary: colors[0] || "#000000",
    secondary: colors[1] || "#000000",
    tertiary: colors[2] || "#000000",
    allColors: colors,
  };

  // Store in database
  const processedId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO processed_images (
      id, image_id, device_size, width, height, file_path,
      color_primary, color_secondary, color_tertiary, color_palette
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    processedId,
    imageId,
    deviceSize.name,
    deviceSize.width,
    deviceSize.height,
    outputPath,
    colorPalette.primary,
    colorPalette.secondary,
    colorPalette.tertiary,
    JSON.stringify(colorPalette)
  );

  return {
    id: processedId,
    imageId,
    deviceSize: deviceSize.name,
    width: deviceSize.width,
    height: deviceSize.height,
    filePath: outputPath,
    colorPalette,
  };
}

/**
 * Process all images for all device sizes
 */
export async function processAllImages(
  outputDir: string,
  options: { verbose?: boolean } = {}
): Promise<{ processed: number; errors: number; skipped: number }> {
  const { verbose = false } = options;
  const config = await loadConfig();
  const deviceSizes: DeviceSize[] = config.deviceSizes;
  
  const db = getDb();
  const images = db.prepare("SELECT id FROM images").all() as Array<{ id: string }>;

  let processed = 0;
  let errors = 0;
  let skipped = 0;

  for (const image of images) {
    for (const deviceSize of deviceSizes) {
      try {
        // Check if already processed
        const existing = db.prepare(
          "SELECT id FROM processed_images WHERE image_id = ? AND device_size = ?"
        ).get(image.id, deviceSize.name);

        if (existing) {
          if (verbose) {
            console.log(`  Skipped: ${image.id} for ${deviceSize.name} (already processed)`);
          }
          skipped++;
          continue;
        }

        if (verbose) {
          console.log(`  Processing: ${image.id} for ${deviceSize.name}...`);
        }

        await processImageForDevice(image.id, deviceSize, outputDir);
        processed++;
      } catch (error) {
        console.error(`Error processing ${image.id} for ${deviceSize.name}:`, error);
        errors++;
      }
    }
  }

  return { processed, errors, skipped };
}

/**
 * Get all processed images for a device size
 */
export function getProcessedImagesForDevice(deviceSize: string): Array<{
  id: string;
  imageId: string;
  filePath: string;
  colorPalette: ColorPalette;
}> {
  const db = getDb();
  
  const results = db.prepare(`
    SELECT id, image_id, file_path, color_palette
    FROM processed_images
    WHERE device_size = ?
  `).all(deviceSize) as Array<{
    id: string;
    image_id: string;
    file_path: string;
    color_palette: string;
  }>;

  return results.map(r => ({
    id: r.id,
    imageId: r.image_id,
    filePath: r.file_path,
    colorPalette: JSON.parse(r.color_palette),
  }));
}
