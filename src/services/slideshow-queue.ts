/**
 * Slideshow queue generation service
 * Generates infinite shuffled sequences with layout-aware variant selection
 */

import { getFirestore, Collections } from "../db/firestore.ts";
import { getDevice, getDeviceQueueState, updateDeviceQueueState } from "../db/helpers-firestore.ts";
import type { DeviceVariant } from "../db/types.ts";

type ColorPalette = {
  primary: string;
  secondary: string;
  tertiary: string;
  sourceColor: string;
  allColors: string[];
};

/**
 * Calculate similarity between two color palettes
 */
function calculatePaletteSimilarity(palette1: ColorPalette, palette2: ColorPalette): number {
  // Simple color distance calculation
  // Returns a value between 0 (identical) and 1 (completely different)
  const hexToRgb = (hex: string): [number, number, number] => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : [0, 0, 0];
  };

  const colorDistance = (rgb1: [number, number, number], rgb2: [number, number, number]): number => {
    return Math.sqrt(Math.pow(rgb1[0] - rgb2[0], 2) + Math.pow(rgb1[1] - rgb2[1], 2) + Math.pow(rgb1[2] - rgb2[2], 2)) / (255 * Math.sqrt(3)); // Normalize to 0-1
  };

  const primary1 = hexToRgb(palette1.primary);
  const primary2 = hexToRgb(palette2.primary);

  return colorDistance(primary1, primary2);
}

// type QueueItem = {
//   imageId: string;
//   blobHash: string;
//   filePath: string;
//   colorPalette: ColorPalette;
//   layoutType: "single" | "pair-vertical" | "pair-horizontal";
//   variantDimensions: {
//     width: number;
//     height: number;
//   };
//   cropPercentage?: number;
//   isPaired?: boolean;
//   pairedWith?: string;
//   pairedFilePath?: string;
// };

type QueueItem = {
  layoutType: "monotych" | "diptych" | "triptych";
  images: {
    url: string;
    source_color?: string;
    color_palette?: string[];
  }[];
};

type SlideshowQueue = {
  deviceId: string;
  queue: QueueItem[];
  currentIndex: number;
  generatedAt: string;
};

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

type Layouts = {
  monotych: boolean;
  diptych: boolean;
  triptych: boolean;
};

/**
 * Generate slideshow queue for a device with layout-aware variant selection
 */
export async function generateSlideshowQueue(deviceId: string, queueSize = 100): Promise<SlideshowQueue> {
  const db = getFirestore();

  // Get device info including layouts
  const device = await getDevice(deviceId);

  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  // Parse layouts
  const layouts: Layouts = device.layouts
    ? JSON.parse(device.layouts)
    : {
        monotych: true,
        diptych: false,
        triptych: false,
      };

  // if (layouts.length === 0) {
  //   console.warn(`Device ${deviceId} has no layouts defined, falling back to legacy mode`);
  //   return generateLegacyQueue(deviceId, device, queueSize);
  // }

  // Get all device_variants to find unique blob hashes
  const variantsQ = await db.collection(Collections.DEVICE_VARIANTS).where("device", "==", deviceId).get();
  const variants = variantsQ.docs.map((doc) => doc.data()) as unknown[] as DeviceVariant[];

  const variantMap = new Map<string, DeviceVariant>();
  const variantsByLayout = new Map<string, DeviceVariant[]>();
  for (const variant of variants) {
    if (!variantMap.has(variant.blob_hash)) {
      variantMap.set(variant.blob_hash, variant);
      variantsByLayout.set(variant.layout_type, [...(variantsByLayout.get(variant.layout_type) || []), variant]);
    }
  }

  const uniqueBlobHashes = [...new Set(variants.map((v) => v.blob_hash))];

  // Batch get all blobs (Firestore supports up to 500 per batch)
  const blobPromises = uniqueBlobHashes.map((hash) => db.collection(Collections.BLOBS).doc(hash).get());
  const blobDocs = await Promise.all(blobPromises);

  const blobs = blobDocs
    .filter((doc) => doc.exists)
    .map((doc) => {
      const data = doc.data()!;
      return {
        blob_hash: doc.id,
        width: data.width,
        height: data.height,
        orientation: data.orientation,
        color_palette: data.color_palette,
        color_source: data.color_source,
      };
    });

  if (blobs.length === 0) {
    return {
      deviceId,
      queue: [],
      currentIndex: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const blobMap = new Map<string, (typeof blobs)[0]>();
  for (const blob of blobs) {
    blobMap.set(blob.blob_hash, blob);
  }

  const queue: QueueItem[] = [];
  let i = 0;
  while (i < queueSize) {
    // TODO: semi-randomly select a layout available for this device
    const layout = "monotych";
    const imagesNeeded = layout === "monotych" ? 1 : layout === "diptych" ? 2 : 3;

    const candidates = variantsByLayout.get(layout) || [];
    if (candidates.length < imagesNeeded) {
      continue; // Not enough variants for this layout
    }

    let imagesSelected: DeviceVariant[] = [];
    const shuffledCandidates = shuffleArray(candidates);

    // Select images for this layout
    for (const candidate of shuffledCandidates) {
      if (imagesSelected.length >= imagesNeeded) {
        break;
      }
      if (!imagesSelected.find((img) => img.blob_hash === candidate.blob_hash)) {
        imagesSelected.push(candidate);
      }
    }

    if (imagesSelected.length < imagesNeeded) {
      continue; // Could not select enough unique images
    }

    // Add selected images to queue
    queue.push({
      layoutType: layout as "monotych" | "diptych" | "triptych",
      images: imagesSelected.map((img) => {
        const blob = blobMap.get(img.blob_hash);
        return {
          url: img.storage_path.replace(/^gs:\/\//, "https://storage.googleapis.com/"),
          source_color: blob.color_source,
          // color_palette: img.color_palette,
          // blob_hash: img.blob_hash,
        };
      }),
    });

    i++;
  }

  const output = {
    deviceId,
    queue,
    currentIndex: 0,
    generatedAt: new Date().toISOString(),
  };

  saveQueueState(output).catch((err) => {
    console.error(`Failed to save generated queue for device ${deviceId}: ${err.message}`);
  });

  return output;
}

/**
 * Legacy queue generation for devices without layouts defined
 */
async function generateLegacyQueue(deviceId: string, device: { width: number; height: number; orientation: string }, queueSize: number): Promise<SlideshowQueue> {
  // Legacy mode not supported in Firestore migration
  // The old processed_images table is deprecated
  console.warn(`Legacy queue generation not supported for device ${deviceId}`);

  return {
    deviceId,
    queue: [],
    currentIndex: 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Save queue state to database
 */
export async function saveQueueState(queue: SlideshowQueue): Promise<void> {
  await updateDeviceQueueState(queue.deviceId, JSON.stringify(queue), queue.currentIndex);
}

/**
 * Load queue state from database
 */
export async function loadQueueState(deviceId: string): Promise<SlideshowQueue | null> {
  const state = await getDeviceQueueState(deviceId);

  if (!state) return null;

  const queue = JSON.parse(state.queue_data) as SlideshowQueue;
  queue.currentIndex = state.current_index;

  return queue;
}

/**
 * Get next image in queue (with rotation)
 */
export async function getNextImage(deviceId: string): Promise<QueueItem | null> {
  let queue = await loadQueueState(deviceId);

  // Generate new queue if none exists
  if (!queue) {
    queue = await generateSlideshowQueue(deviceId);
    await saveQueueState(queue);
  }

  // Check if we need to regenerate (reached end)
  if (queue.currentIndex >= queue.queue.length) {
    queue = await generateSlideshowQueue(deviceId);
    queue.currentIndex = 0;
    await saveQueueState(queue);
  }

  const item = queue.queue[queue.currentIndex];

  // Update index for next call
  queue.currentIndex++;
  await saveQueueState(queue);

  return item;
}
