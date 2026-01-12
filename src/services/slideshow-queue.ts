/**
 * Slideshow queue generation service
 * Generates infinite shuffled sequences with layout-aware variant selection
 */

import { getDb } from "../db/schema.ts";
import {
  calculatePaletteSimilarity,
  type ColorPalette,
} from "./image-processing.ts";
import { evaluateImageForLayouts, type LayoutSlot } from "./image-layout.ts";

type QueueItem = {
  imageId: string;
  blobHash: string;
  filePath: string;
  colorPalette: ColorPalette;
  layoutType: "single" | "pair-vertical" | "pair-horizontal";
  variantDimensions: {
    width: number;
    height: number;
  };
  cropPercentage?: number;
  isPaired?: boolean;
  pairedWith?: string;
  pairedFilePath?: string;
}

type SlideshowQueue = {
  deviceId: string;
  queue: QueueItem[];
  currentIndex: number;
  generatedAt: string;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Generate slideshow queue for a device with layout-aware variant selection
 */
export function generateSlideshowQueue(
  deviceId: string,
  queueSize = 100
): SlideshowQueue {
  const db = getDb();

  // Get device info including layouts
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as {
    id: string;
    width: number;
    height: number;
    orientation: string;
    layouts: string | null;
  } | undefined;

  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  // Parse layouts
  const layouts: LayoutSlot[] = device.layouts ? JSON.parse(device.layouts) : [];
  
  if (layouts.length === 0) {
    console.warn(`Device ${deviceId} has no layouts defined, falling back to legacy mode`);
    return generateLegacyQueue(deviceId, device, queueSize);
  }

  // Get all blobs with their dimensions
  const blobs = db.prepare(`
    SELECT 
      b.hash as blob_hash,
      b.width,
      b.height,
      b.orientation,
      b.color_palette,
      b.color_source
    FROM blobs b
    WHERE b.hash IN (SELECT DISTINCT blob_hash FROM device_variants)
    ORDER BY b.hash
  `).all() as Array<{
    blob_hash: string;
    width: number;
    height: number;
    orientation: string;
    color_palette: string | null;
    color_source: string | null;
  }>;

  if (blobs.length === 0) {
    return {
      deviceId,
      queue: [],
      currentIndex: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // For each blob, find the best layout variant
  const queueCandidates: Array<{
    blobHash: string;
    layoutType: string;
    variantPath: string;
    variantWidth: number;
    variantHeight: number;
    cropPercentage: number;
    colorPalette: ColorPalette;
    originalOrientation: string;
  }> = [];

  for (const blob of blobs) {
    // Evaluate which layouts this image fits
    const layoutEvals = evaluateImageForLayouts(blob.width, blob.height, layouts);
    
    if (layoutEvals.length === 0) {
      continue; // No suitable layout for this image
    }

    // Select layout with minimum crop (first in sorted array)
    const bestLayout = layoutEvals[0];

    // Find the corresponding device_variant
    const variant = db.prepare(`
      SELECT storage_path, width, height, layout_type
      FROM device_variants
      WHERE blob_hash = ? 
        AND width = ? 
        AND height = ?
        AND layout_type = ?
      LIMIT 1
    `).get(
      blob.blob_hash,
      bestLayout.width,
      bestLayout.height,
      bestLayout.layoutType
    ) as { storage_path: string; width: number; height: number; layout_type: string } | undefined;

    if (!variant) {
      console.warn(`No variant found for blob ${blob.blob_hash} with layout ${bestLayout.layoutType}`);
      continue;
    }

    // Parse color palette
    const colorPalette: ColorPalette = blob.color_palette 
      ? (() => {
          const colors = JSON.parse(blob.color_palette);
          return {
            primary: colors[0] || "#000000",
            secondary: colors[1] || "#000000",
            tertiary: colors[2] || "#000000",
            sourceColor: blob.color_source || colors[0] || "#000000",
            allColors: colors,
          };
        })()
      : {
          primary: "#000000",
          secondary: "#000000",
          tertiary: "#000000",
          sourceColor: "#000000",
          allColors: [],
        };

    queueCandidates.push({
      blobHash: blob.blob_hash,
      layoutType: variant.layout_type,
      variantPath: variant.storage_path,
      variantWidth: variant.width,
      variantHeight: variant.height,
      cropPercentage: bestLayout.cropPercentage,
      colorPalette,
      originalOrientation: blob.orientation,
    });
  }

  // Shuffle candidates
  const shuffled = shuffleArray(queueCandidates);

  // Build queue with pairing logic for pair-* layouts
  const queue: QueueItem[] = [];
  const usedForPairing = new Set<string>();

  for (const candidate of shuffled) {
    if (queue.length >= queueSize) break;

    // Check if this should be paired (pair-vertical or pair-horizontal layout)
    if (
      (candidate.layoutType === "pair-vertical" || candidate.layoutType === "pair-horizontal") &&
      !usedForPairing.has(candidate.blobHash)
    ) {
      // Find a compatible pair
      const compatiblePairs = shuffled.filter(
        (other) =>
          other.blobHash !== candidate.blobHash &&
          other.layoutType === candidate.layoutType &&
          !usedForPairing.has(other.blobHash)
      );

      if (compatiblePairs.length > 0) {
        // Find best color match
        let bestPair = compatiblePairs[0];
        let bestSimilarity = 0;

        for (const pair of compatiblePairs) {
          const similarity = calculatePaletteSimilarity(
            candidate.colorPalette,
            pair.colorPalette
          );
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestPair = pair;
          }
        }

        // Add as paired item
        queue.push({
          imageId: candidate.blobHash,
          blobHash: candidate.blobHash,
          filePath: candidate.variantPath,
          colorPalette: candidate.colorPalette,
          layoutType: candidate.layoutType as "single" | "pair-vertical" | "pair-horizontal",
          variantDimensions: {
            width: candidate.variantWidth,
            height: candidate.variantHeight,
          },
          cropPercentage: candidate.cropPercentage,
          isPaired: true,
          pairedWith: bestPair.blobHash,
          pairedFilePath: bestPair.variantPath,
        });

        usedForPairing.add(candidate.blobHash);
        usedForPairing.add(bestPair.blobHash);
        continue;
      }
    }

    // Add as single item (or unpaired)
    queue.push({
      imageId: candidate.blobHash,
      blobHash: candidate.blobHash,
      filePath: candidate.variantPath,
      colorPalette: candidate.colorPalette,
      layoutType: candidate.layoutType as "single" | "pair-vertical" | "pair-horizontal",
      variantDimensions: {
        width: candidate.variantWidth,
        height: candidate.variantHeight,
      },
      cropPercentage: candidate.cropPercentage,
    });
  }

  // If we need more items, repeat
  while (queue.length < queueSize && queueCandidates.length > 0) {
    const reshuffled = shuffleArray(queueCandidates);
    for (const candidate of reshuffled) {
      if (queue.length >= queueSize) break;
      
      queue.push({
        imageId: candidate.blobHash,
        blobHash: candidate.blobHash,
        filePath: candidate.variantPath,
        colorPalette: candidate.colorPalette,
        layoutType: candidate.layoutType as "single" | "pair-vertical" | "pair-horizontal",
        variantDimensions: {
          width: candidate.variantWidth,
          height: candidate.variantHeight,
        },
        cropPercentage: candidate.cropPercentage,
      });
    }
  }

  return {
    deviceId,
    queue: queue.slice(0, queueSize),
    currentIndex: 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Legacy queue generation for devices without layouts defined
 */
function generateLegacyQueue(
  deviceId: string,
  device: { width: number; height: number; orientation: string },
  queueSize: number
): SlideshowQueue {
  const db = getDb();

  // Determine device size name
  const deviceSizeName = determineDeviceSize(device.width, device.height, device.orientation);

  // Get images from old processed_images table
  const images = db.prepare(`
    SELECT 
      pi.image_id,
      pi.file_path,
      pi.color_palette
    FROM processed_images pi
    WHERE pi.device_size = ?
    ORDER BY RANDOM()
    LIMIT ?
  `).all(deviceSizeName, queueSize) as Array<{
    image_id: string;
    file_path: string;
    color_palette: string | null;
  }>;

  const queue: QueueItem[] = images.map((img) => {
    const colorPalette: ColorPalette = img.color_palette
      ? JSON.parse(img.color_palette)
      : {
          primary: "#000000",
          secondary: "#000000",
          tertiary: "#000000",
          sourceColor: "#000000",
          allColors: [],
        };

    return {
      imageId: img.image_id,
      blobHash: img.image_id, // Legacy: use image_id as hash
      filePath: img.file_path,
      colorPalette,
      layoutType: "single",
      variantDimensions: {
        width: device.width,
        height: device.height,
      },
    };
  });

  return {
    deviceId,
    queue,
    currentIndex: 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Determine device size name from dimensions (legacy support)
 */
function determineDeviceSize(
  width: number,
  height: number,
  orientation: string
): string {
  if (orientation === "portrait") {
    if (height >= 1000) return "medium-portrait";
    return "small-portrait";
  } else {
    if (width >= 1800) return "large-landscape";
    if (width >= 1000) return "medium-landscape";
    return "small-landscape";
  }
}

/**
 * Save queue state to database
 */
export function saveQueueState(queue: SlideshowQueue): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO device_queue_state (device_id, queue_data, current_index, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET
      queue_data = excluded.queue_data,
      current_index = excluded.current_index,
      updated_at = CURRENT_TIMESTAMP
  `).run(queue.deviceId, JSON.stringify(queue), queue.currentIndex);
}

/**
 * Load queue state from database
 */
export function loadQueueState(deviceId: string): SlideshowQueue | null {
  const db = getDb();

  const result = db.prepare(`
    SELECT queue_data, current_index
    FROM device_queue_state
    WHERE device_id = ?
  `).get(deviceId) as { queue_data: string; current_index: number } | undefined;

  if (!result) return null;

  const queue = JSON.parse(result.queue_data) as SlideshowQueue;
  queue.currentIndex = result.current_index;

  return queue;
}

/**
 * Get next image in queue (with rotation)
 */
export function getNextImage(deviceId: string): QueueItem | null {
  let queue = loadQueueState(deviceId);

  // Generate new queue if none exists
  if (!queue) {
    queue = generateSlideshowQueue(deviceId);
    saveQueueState(queue);
  }

  // Check if we need to regenerate (reached end)
  if (queue.currentIndex >= queue.queue.length) {
    queue = generateSlideshowQueue(deviceId);
    queue.currentIndex = 0;
    saveQueueState(queue);
  }

  const item = queue.queue[queue.currentIndex];
  
  // Update index for next call
  queue.currentIndex++;
  saveQueueState(queue);

  return item;
}
