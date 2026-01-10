/**
 * Web Worker for processing a single image for a single device size
 * One task per worker for better parallelism
 */

console.log("[Worker] 🚀 Worker script loaded and executing");

import { processImageForDeviceWorker, type DeviceSize } from "../services/image-processing.ts";
import { initStorage } from "../services/storage.ts";

console.log("[Worker] 📚 Imports completed, initializing services for worker...");

// Initialize storage in worker context (needed for GCS operations)
initStorage();
console.log("[Worker] ✅ Storage initialized in worker");

console.log("[Worker] 📚 Setting up message handler");

// Use addEventListener instead of self.onmessage
self.addEventListener('message', async (e: MessageEvent) => {
  console.log("[Worker] 📨 message event listener called!");
  const { imageData, deviceName, deviceWidth, deviceHeight, googlePhotosBaseUrl, outputDir } = e.data;
  
  // Send ready message immediately after loading
  if (!imageData) {
    console.log("[Worker] ✅ No image data, this must be initialization");
    return;
  }
  
  console.log(`[Worker] 🎬 Starting processing ${imageData.id} for ${deviceName} (${deviceWidth}x${deviceHeight})`);
  console.log(`[Worker] 📦 Received data:`, { imageId: imageData.id, deviceName, deviceWidth, deviceHeight, outputDir, hasGooglePhotosUrl: !!googlePhotosBaseUrl });
  
  try {
    const deviceSize: DeviceSize = {
      name: deviceName,
      width: deviceWidth,
      height: deviceHeight,
    };
    
    // Process image for this specific device size (without database)
    console.log(`[Worker] 🔧 Calling processImageForDeviceWorker...`);
    const result = await processImageForDeviceWorker(imageData, deviceSize, outputDir, googlePhotosBaseUrl);
    console.log(`[Worker] ✅ processImageForDeviceWorker completed for ${imageData.id}/${deviceName}:`, result.processedId);
    
    console.log(`[Worker] 📤 Posting success message with result data...`);
    self.postMessage({
      success: true,
      result,
    });
    console.log(`[Worker] ✅ Success message posted for ${imageData.id}/${deviceName}`);
  } catch (error) {
    console.error(`[Worker] ❌ Failed to process ${imageData.id} for ${deviceName}:`, error);
    console.error(`[Worker] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
    console.log(`[Worker] 📤 Posting error message...`);
    self.postMessage({
      success: false,
      imageId: imageData.id,
      deviceName,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    console.log(`[Worker] ❌ Error message posted for ${imageData.id}/${deviceName}`);
  } finally {
    console.log(`[Worker] 🔚 Closing worker for ${imageData.id}/${deviceName}`);
    self.close();
  }
});

console.log("[Worker] ✅ Message event listener registered, worker is ready");
// Immediately send ready message
console.log("[Worker] 📤 Posting ready message to parent");
self.postMessage({ type: 'ready' });
