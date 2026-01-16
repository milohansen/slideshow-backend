import { Hono } from "hono";
import { Collections, getFirestore } from "../db/firestore.ts";
import { createBlob, createDeviceVariant, updateSource } from "../db/helpers-firestore.ts";
import { generateImageAnalysis } from "../services/ai.ts";

const processing = new Hono();

type ProcessingStartResponse = {
  attempt: number;
  devices: Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
    gap: number;
  }>;
};

processing.use("/:imageId/start", async (c) => {
  const db = getFirestore();

  const devicesSnapshot = await db.collection(Collections.DEVICES).orderBy("created_at", "desc").get();
  const sourceDoc = await db.collection(Collections.SOURCES).doc(c.req.param("imageId")).get()

  const devices = devicesSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      width: data.width,
      height: data.height,
      orientation: data.orientation,
      gap: data.gap,
      last_seen: data.last_seen || null,
    };
  });

  return c.json({
    attempt: 1,
    devices,
    source: sourceDoc.data()
  } as ProcessingStartResponse);
});

export type ProcessingResult = {
  status: "processed" | "duplicate";
  blobHash?: string;
  blobData?: {
    storage_path: string;
    width: number;
    height: number;
    aspect_ratio: number;
    orientation: "portrait" | "landscape" | "square";
    file_size: number;
    mime_type: string;
    exif_data: string | null;
  };
  colorData?: {
    palette: string;
    source: string;
  };
  variants: Variant[];
};

type LayoutType = "monotych" | "diptych" | "triptych";

type Variant = {
  device: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  layout_type: LayoutType;
  storage_path: string;
  file_size: number;
};

processing.post("/:imageId/complete", async (c) => {
  const result = await c.req.json<ProcessingResult>();

  updateSource(c.req.param("imageId"), {
    status: result.status === "processed" ? "ready" : "failed",
    blob_hash: result.blobHash,
    processed_at: new Date().toISOString(),
  });

  if (result.status === "duplicate") {
    return c.json({ success: true });
  }

  await createBlob({
    hash: result.blobHash!,
    storage_path: result.blobData!.storage_path,
    width: result.blobData!.width,
    height: result.blobData!.height,
    aspect_ratio: result.blobData!.aspect_ratio,
    orientation: result.blobData!.orientation,
    file_size: result.blobData!.file_size,
    mime_type: result.blobData!.mime_type,
    exif_data: result.blobData!.exif_data,
    color_source: result.colorData?.source,
    color_palette: result.colorData?.palette
  });

  generateImageAnalysis(result.blobHash!, result.blobData!.storage_path.replace("gs://", "https://storage.googleapis.com/")).catch((error) => {
    console.error(`[Processing] Failed to generate image analysis for blob ${result.blobHash}:`, error);
  });

  await Promise.allSettled(result.variants.map(async (variant) => {
    await createDeviceVariant({
      device: variant.device,
      blob_hash: result.blobHash!,
      width: variant.width,
      height: variant.height,
      orientation: variant.orientation,
      layout_type: variant.layout_type,
      storage_path: variant.storage_path,
      file_size: variant.file_size,
    });
  }));

  return c.json({ success: true });
});

export default processing;
