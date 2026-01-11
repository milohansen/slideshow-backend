/**
 * Slideshow queue generation service
 * Generates infinite shuffled sequences with portrait pairing
 */

import { getDb } from "../db/schema.ts";
import {
  getProcessedImagesForDevice,
  calculatePaletteSimilarity,
  type ColorPalette,
} from "./image-processing.ts";

type QueueItem = {
  imageId: string;
  filePath: string;
  colorPalette: ColorPalette;
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
 * Find best matching portrait pair based on color similarity
 */
function findBestPortraitPair(
  portrait: { imageId: string; colorPalette: ColorPalette },
  availablePortraits: Array<{ imageId: string; colorPalette: ColorPalette }>,
  threshold = 0.4
): string | null {
  let bestMatch: string | null = null;
  let bestSimilarity = threshold;

  for (const candidate of availablePortraits) {
    if (candidate.imageId === portrait.imageId) continue;

    const similarity = calculatePaletteSimilarity(
      portrait.colorPalette,
      candidate.colorPalette
    );

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = candidate.imageId;
    }
  }

  return bestMatch;
}

/**
 * Generate slideshow queue for a device
 */
export function generateSlideshowQueue(
  deviceId: string,
  queueSize = 100
): SlideshowQueue {
  const db = getDb();

  // Get device info
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as {
    id: string;
    width: number;
    height: number;
    orientation: string;
  } | undefined;

  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  // Determine device size name (match width/height to device sizes)
  const deviceSizeName = determineDeviceSize(device.width, device.height, device.orientation);

  // Get all processed images for this device size
  const allImages = getProcessedImagesForDevice(deviceSizeName);

  if (allImages.length === 0) {
    return {
      deviceId,
      queue: [],
      currentIndex: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // Separate by original orientation
  const db2 = getDb();
  const portraitImages = [];
  const landscapeImages = [];
  const squareImages = [];

  for (const img of allImages) {
    const original = db2.prepare("SELECT orientation FROM images WHERE id = ?").get(img.imageId) as {
      orientation: string;
    } | undefined;

    if (original) {
      if (original.orientation === "portrait") {
        portraitImages.push(img);
      } else if (original.orientation === "landscape") {
        landscapeImages.push(img);
      } else {
        squareImages.push(img);
      }
    }
  }

  // Generate queue
  const queue: QueueItem[] = [];
  const usedPairs = new Set<string>();

  // For portrait-oriented devices, pair portraits
  if (device.orientation === "portrait" && portraitImages.length >= 2) {
    const shuffledPortraits = shuffleArray(portraitImages);
    const availablePortraits = [...shuffledPortraits];

    for (const portrait of shuffledPortraits) {
      if (usedPairs.has(portrait.imageId)) continue;

      // Find best matching pair
      const pairId = findBestPortraitPair(
        portrait,
        availablePortraits.filter((p) => !usedPairs.has(p.imageId))
      );

      if (pairId) {
        // Get the pair image data
        const pair = availablePortraits.find((p) => p.imageId === pairId);
        
        // Add as paired
        queue.push({
          imageId: portrait.imageId,
          filePath: portrait.filePath,
          colorPalette: portrait.colorPalette,
          isPaired: true,
          pairedWith: pairId,
          pairedFilePath: pair?.filePath,
        });

        usedPairs.add(portrait.imageId);
        usedPairs.add(pairId);

        if (pair) {
          queue.push({
            imageId: pair.imageId,
            filePath: pair.filePath,
            colorPalette: pair.colorPalette,
            isPaired: true,
            pairedWith: portrait.imageId,
            pairedFilePath: portrait.filePath,
          });
        }
      } else {
        // Add as single
        queue.push({
          imageId: portrait.imageId,
          filePath: portrait.filePath,
          colorPalette: portrait.colorPalette,
        });
      }

      if (queue.length >= queueSize) break;
    }
  } else {
    // For landscape devices, just shuffle all images
    const shuffled = shuffleArray([...landscapeImages, ...squareImages, ...portraitImages]);

    for (const img of shuffled) {
      queue.push({
        imageId: img.imageId,
        filePath: img.filePath,
        colorPalette: img.colorPalette,
      });

      if (queue.length >= queueSize) break;
    }
  }

  // If we need more items, repeat the pattern
  while (queue.length < queueSize && allImages.length > 0) {
    const shuffled = shuffleArray(allImages);
    for (const img of shuffled) {
      queue.push({
        imageId: img.imageId,
        filePath: img.filePath,
        colorPalette: img.colorPalette,
      });
      if (queue.length >= queueSize) break;
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
 * Determine device size name from dimensions
 */
function determineDeviceSize(
  width: number,
  height: number,
  orientation: string
): string {
  // This is a simple heuristic - you might want to make this more sophisticated
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
