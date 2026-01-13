import { Hono } from "hono";
import { getUserId } from "../middleware/auth.ts";
import { createReadStream } from "../services/storage.ts";
import { queueSourceProcessing } from "../services/job-queue-v2.ts";
import { Devices } from "../views/devices.tsx";
import { Home } from "../views/home.tsx";
import { Images } from "../views/images.tsx";
import { PhotosPicker } from "../views/photos-picker.tsx";
import { Queues } from "../views/queues.tsx";
import { Upload } from "../views/upload.tsx";
import { getFirestore, Collections } from "../db/firestore.ts";
import {
  getBlobsByOrientation,
  getSourcesForBlob,
  countVariantsForBlob,
  getAllDevices,
  getActivePickerSession,
} from "../db/helpers-firestore.ts";

const ui = new Hono();

// Debug route to test Firestore connection
ui.get("/debug", async (c) => {
  try {
    const db = getFirestore();
    console.log("🔍 Testing Firestore connection...");
    
    // Test basic connection
    const startTime = Date.now();
    await db.listCollections();
    const connectionTime = Date.now() - startTime;
    console.log(`✅ Firestore connection test passed (${connectionTime}ms)`);
    
    // Test simple read operation
    const testStartTime = Date.now();
    const blobsTest = await db.collection(Collections.BLOBS).limit(1).get();
    const readTime = Date.now() - testStartTime;
    console.log(`✅ Firestore read test passed (${readTime}ms), docs: ${blobsTest.size}`);
    
    return c.json({
      status: "success",
      connectionTime: `${connectionTime}ms`,
      readTime: `${readTime}ms`,
      docsInBlobs: blobsTest.size,
      collections: Collections
    });
    
  } catch (error) {
    console.error("❌ Firestore debug test failed:", error);
    if (!(error instanceof Error)) {
      return c.json({
        status: "error",
        error: "Unknown error occurred",
      }, 500);
    }
    return c.json({
      status: "error",
      error: error.message,
      code: (error as any).code,
      details: (error as any).details,
      stack: error.stack
    }, 500);
  }
});

// Home page
ui.get("/", async (c) => {
  try {
    const db = getFirestore();
    
    // Get stats from Firestore
    
    // const [blobsSnapshot, devicesSnapshot, variantsSnapshot, orientations] = await Promise.all([
    //   db.collection(Collections.BLOBS).count().get(),
    //   db.collection(Collections.DEVICES).count().get(),
    //   db.collection(Collections.DEVICE_VARIANTS).count().get(),
    //   getBlobsByOrientation(),
    // ]);

    // const stats = {
    //   totalImages: blobsSnapshot.data().count,
    //   totalDevices: devicesSnapshot.data().count,
    //   processedVariants: variantsSnapshot.data().count,
    //   orientations,
    // };
    const stats = {
      totalImages: 0,
      totalDevices: (await db.collection(Collections.DEVICES).count().get()).data().count,
      processedVariants: 0,
      orientations: { landscape: 0, portrait: 0, square: 0 },
    };

    return c.html(<Home stats={stats} />);
  } catch (error) {
    console.error("Error loading home page:", error);
    
    // Return page with error stats
    const errorStats = {
      totalImages: 0,
      totalDevices: 0,
      processedVariants: 0,
      orientations: { landscape: 0, portrait: 0, square: 0 },
      error: "Failed to load data from Firestore. Check security rules and authentication.",
    };
    
    return c.html(<Home stats={errorStats} />);
  }
});

// Devices page
ui.get("/devices", async (c) => {
  try {
    const db = getFirestore();
    
    const devicesSnapshot = await db.collection(Collections.DEVICES)
      .orderBy("created_at", "desc")
      .get();

    const devices = devicesSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        width: data.width,
        height: data.height,
        orientation: data.orientation,
        created_at: data.created_at,
        last_seen: data.last_seen || null,
      };
    });

    return c.html(<Devices devices={devices} />);
  } catch (error) {
    console.error("Error loading devices page:", error);
    return c.html(<Devices devices={[]} error="Failed to load devices. Check Firestore security rules and authentication." />);
  }
});

// Images page - with full metadata from Firestore
ui.get("/images", async (c) => {
  try {
    const db = getFirestore();
    
    // Get total devices count once (used for all images)
    const devices = await getAllDevices();
    const totalDevices = devices.length;
    
    const blobsSnapshot = await db.collection(Collections.BLOBS)
      .orderBy("created_at", "desc")
      .limit(100)
      .get();

    // Fetch additional metadata for each blob in parallel
    const imagesWithColors = await Promise.all(blobsSnapshot.docs.map(async (doc) => {
      const data = doc.data();
      const blobHash = doc.id;
      const palette = data.color_palette ? JSON.parse(data.color_palette) : null;
      
      // Get sources for this blob to check processing status
      const sources = await getSourcesForBlob(blobHash);
      
      // Determine overall processing status (if any source is failed, mark as failed, etc.)
      let processingStatus = 'complete';
      let processingError = null;
      
      if (sources.length > 0) {
        const hasFailedSource = sources.some(s => s.status === 'failed');
        const hasProcessingSource = sources.some(s => s.status === 'processing');
        const hasStagedSource = sources.some(s => s.status === 'staged');
        
        if (hasFailedSource) {
          processingStatus = 'failed';
          const failedSource = sources.find(s => s.status === 'failed');
          processingError = failedSource?.status_message || 'Processing failed';
        } else if (hasProcessingSource) {
          processingStatus = 'processing';
        } else if (hasStagedSource) {
          processingStatus = 'staged';
        }
      }
      
      // Count processed variants
      const processedCount = await countVariantsForBlob(blobHash);
      
      return {
        id: blobHash,
        file_path: data.storage_path,
        width: data.width,
        height: data.height,
        orientation: data.orientation,
        processingStatus,
        processingError,
        processedCount,
        totalDevices,
        colors: palette ? {
          primary: palette.primary || '#000000',
          secondary: palette.secondary || '#000000',
          tertiary: palette.tertiary || '#000000',
        } : null,
      };
    }));

    return c.html(<Images images={imagesWithColors} />);
  } catch (error) {
    console.error("Error loading images page:", error);
    return c.html(<Images images={[]} error="Failed to load images. Check Firestore security rules and authentication." />);
  }
});

// Queues page
ui.get("/queues", async (c) => {
  try {
    const db = getFirestore();
    
    const queueStatesSnapshot = await db.collection(Collections.DEVICE_QUEUE_STATE).get();
    
    const queues = await Promise.all(queueStatesSnapshot.docs.map(async doc => {
      const data = doc.data();
      const deviceDoc = await db.collection(Collections.DEVICES).doc(doc.id).get();
      const deviceData = deviceDoc.data();
      
      return {
        deviceId: doc.id,
        deviceName: deviceData?.name || doc.id,
        queue: data.queue || [],
        currentIndex: data.current_index || 0,
      };
    }));

    return c.html(<Queues queues={queues} />);
  } catch (error) {
    console.error("Error loading queues page:", error);
    return c.html(<Queues queues={[]} error="Failed to load queues. Check Firestore security rules and authentication." />);
  }
});

// Upload page
ui.get("/upload", (c) => {
  return c.html(<Upload />);
});

// Serve thumbnail images
ui.get("/thumbnails/:imageId", async (c) => {
  const imageId = c.req.param("imageId");

  // Construct deterministic thumbnail path
  const thumbnailPath = `processed/thumbnails/${imageId}.jpg`;
  const gcsPath = `gs://${process.env.GCS_BUCKET || "slideshow-images"}/${thumbnailPath}`;

  const stream = createReadStream(gcsPath);

  return c.body(stream, 200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000",
  });
});

// Google Photos Picker page
ui.get("/photos-picker", async (c) => {
  const userId = getUserId(c);

  if (!userId) {
    // Not authenticated, redirect to login
    console.log("[UI] User not authenticated, redirecting to /auth/google");
    return c.redirect("/auth/google");
  }

  // Get active picker session for user
  const session = await getActivePickerSession(userId);

  return c.html(<PhotosPicker session={session ? {
    sessionId: session.picker_session_id,
    pickerUri: session.picker_uri,
  } : null} />);
});

// Retry failed image processing
ui.post("/images/:id/retry", async (c) => {
  const imageId = c.req.param("id"); // Could be source_id or blob_hash
  const db = getFirestore();
  
  // Try to find source by id first
  let sourceDoc;
  try {
    sourceDoc = await db.collection(Collections.SOURCES).doc(imageId).get();
  } catch {
    // Not found by id, try blob_hash
    const snapshot = await db.collection(Collections.SOURCES)
      .where("blob_hash", "==", imageId)
      .where("status", "==", "failed")
      .limit(1)
      .get();
    sourceDoc = snapshot.empty ? null : snapshot.docs[0];
  }
  
  if (!sourceDoc?.exists) {
    console.log(`[UI] Source not found for retry: ${imageId}`);
    return c.redirect("/ui/images");
  }
  
  console.log(`[UI] Retrying source: ${sourceDoc.id}`);
  
  // Update status back to staged
  await sourceDoc.ref.update({
    status: 'staged',
    status_message: null,
    processed_at: null,
  });
  
  // Queue for processing via job queue v2
  try {
    await queueSourceProcessing(sourceDoc.id);
    console.log(`[UI] Source queued for reprocessing: ${sourceDoc.id}`);
  } catch (error) {
    console.error(`[UI] Failed to queue source: ${error}`);
  }
  
  return c.redirect("/ui/images");
});

export default ui;
