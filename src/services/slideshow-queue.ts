/**
 * Slideshow queue generation service
 * Generates infinite shuffled sequences with layout-aware variant selection
 */

import { getFirestore, Collections } from "../db/firestore.ts";
import { getDevice, getDeviceQueueState, updateDeviceQueueState } from "../db/helpers-firestore.ts";
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
export async function generateSlideshowQueue(
  deviceId: string,
  queueSize = 100
): Promise<SlideshowQueue> {
  const db = getFirestore();

  // Get device info including layouts
  const device = await getDevice(deviceId);

  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  // Parse layouts
  const layouts: LayoutSlot[] = device.layouts ? JSON.parse(device.layouts) : [];
  
  if (layouts.length === 0) {
    console.warn(`Device ${deviceId} has no layouts defined, falling back to legacy mode`);
    return generateLegacyQueue(deviceId, device, queueSize);
  }

  // Get all device_variants to find unique blob hashes
  const variantsSnapshot = await db.collection(Collections.DEVICE_VARIANTS).get();
  const uniqueBlobHashes = [...new Set(variantsSnapshot.docs.map(d => d.data().blob_hash))];

  // Batch get all blobs (Firestore supports up to 500 per batch)
  const blobPromises = uniqueBlobHashes.map(hash =>
    db.collection(Collections.BLOBS).doc(hash).get()
  );
  const blobDocs = await Promise.all(blobPromises);
  
  const blobs = blobDocs
    .filter(doc => doc.exists)
    .map(doc => {
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
    const variantQuery = await db.collection(Collections.DEVICE_VARIANTS)
      .where("blob_hash", "==", blob.blob_hash)
      .where("width", "==", bestLayout.width)
      .where("height", "==", bestLayout.height)
      .where("layout_type", "==", bestLayout.layoutType)
      .limit(1)
      .get();

    if (variantQuery.empty) {
      console.warn(`No variant found for blob ${blob.blob_hash} with layout ${bestLayout.layoutType}`);
      continue;
    }

    const variantData = variantQuery.docs[0].data();
    const variant = {
      storage_path: variantData.storage_path,
      width: variantData.width,
      height: variantData.height,
      layout_type: variantData.layout_type,
    };

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
async function generateLegacyQueue(
  deviceId: string,
  device: { width: number; height: number; orientation: string },
  queueSize: number
): Promise<SlideshowQueue> {
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
  await updateDeviceQueueState(
    queue.deviceId,
    JSON.stringify(queue),
    queue.currentIndex
  );
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
