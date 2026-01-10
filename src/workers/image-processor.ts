/**
 * Web Worker for processing a single image for a single device size
 * One task per worker for better parallelism
 */

console.log("[Worker] 🚀 Worker script loaded and executing");

import { processImageForDevice, type DeviceSize } from "../services/image-processing.ts";
import { initDatabase } from "../db/schema.ts";

console.log("[Worker] 📚 Imports completed, initializing database for worker...");

// Initialize database in worker context
await initDatabase();
console.log("[Worker] ✅ Database initialized in worker");

console.log("[Worker] 📚 Setting up message handler");

// Use addEventListener instead of self.onmessage
self.addEventListener('message', async (e: MessageEvent) => {
  console.log("[Worker] 📨 message event listener called!");
  const { imageId, deviceName, deviceWidth, deviceHeight, googlePhotosBaseUrl, outputDir } = e.data;
  
  // Ignore the ready check message
  if (e.data.type === 'ready-check') {
    console.log("[Worker] ✅ Ready check received, sending ready response");
    self.postMessage({ type: 'ready' });
    return;
  }
  
  console.log(`[Worker] 🎬 Starting processing ${imageId} for ${deviceName} (${deviceWidth}x${deviceHeight})`);
  console.log(`[Worker] 📦 Received data:`, { imageId, deviceName, deviceWidth, deviceHeight, outputDir, hasGooglePhotosUrl: !!googlePhotosBaseUrl });
  
  try {
    const deviceSize: DeviceSize = {
      name: deviceName,
      width: deviceWidth,
      height: deviceHeight,
    };
    
    // Process image for this specific device size
    console.log(`[Worker] 🔧 Calling processImageForDevice...`);
    const result = await processImageForDevice(imageId, deviceSize, outputDir, googlePhotosBaseUrl);
    console.log(`[Worker] ✅ processImageForDevice completed for ${imageId}/${deviceName}:`, result.id);
    
    console.log(`[Worker] 📤 Posting success message...`);
    self.postMessage({
      success: true,
      imageId,
      deviceName,
    });
    console.log(`[Worker] ✅ Success message posted for ${imageId}/${deviceName}`);
  } catch (error) {
    console.error(`[Worker] ❌ Failed to process ${imageId} for ${deviceName}:`, error);
    console.error(`[Worker] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
    console.log(`[Worker] 📤 Posting error message...`);
    self.postMessage({
      success: false,
      imageId,
      deviceName,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    console.log(`[Worker] ❌ Error message posted for ${imageId}/${deviceName}`);
  } finally {
    console.log(`[Worker] 🔚 Closing worker for ${imageId}/${deviceName}`);
    self.close();
  }
});

console.log("[Worker] ✅ Message event listener registered, worker is ready");
// Immediately send ready message
console.log("[Worker] 📤 Posting ready message to parent");
self.postMessage({ type: 'ready' });
