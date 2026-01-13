#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net
/**
 * Clean up all sources, blobs, and device variants from database
 */

import { initFirestore, getFirestore, Collections } from "./db/firestore.ts";

async function cleanupImages() {
  await initFirestore();
  const db = getFirestore();

  console.log("Current state:");
  const sourcesSnapshot = await db.collection(Collections.SOURCES).count().get();
  const blobsSnapshot = await db.collection(Collections.BLOBS).count().get();
  const variantsSnapshot = await db.collection(Collections.DEVICE_VARIANTS).count().get();
  
  const sourceCount = sourcesSnapshot.data().count;
  const blobCount = blobsSnapshot.data().count;
  const variantCount = variantsSnapshot.data().count;
  
  console.log(`  - Sources: ${sourceCount}`);
  console.log(`  - Blobs: ${blobCount}`);
  console.log(`  - Device variants: ${variantCount}`);

  if (sourceCount === 0 && blobCount === 0 && variantCount === 0) {
    console.log("\n✅ Database is already clean");
    return;
  }

  console.log("\nCleaning up...");
  
  // Delete all documents in each collection
  const deleteBatch = db.batch();
  
  const sources = await db.collection(Collections.SOURCES).get();
  sources.docs.forEach(doc => deleteBatch.delete(doc.ref));
  
  const blobs = await db.collection(Collections.BLOBS).get();
  blobs.docs.forEach(doc => deleteBatch.delete(doc.ref));
  
  const variants = await db.collection(Collections.DEVICE_VARIANTS).get();
  variants.docs.forEach(doc => deleteBatch.delete(doc.ref));
  
  const queueStates = await db.collection(Collections.DEVICE_QUEUE_STATE).get();
  queueStates.docs.forEach(doc => deleteBatch.delete(doc.ref));
  
  await deleteBatch.commit();

  console.log("\n✅ Cleanup complete");
  console.log("  - All sources removed");
  console.log("  - All blobs removed");
  console.log("  - All device variants removed");
  console.log("  - All queue states cleared");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await cleanupImages();
}
