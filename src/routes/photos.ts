import { Hono } from "hono";
import { getAccessToken, getUserId } from "../middleware/auth.ts";
import { createPickerSession, deletePickerSession, getAllMediaItems, getPickerSessionStatus, updatePickerSession } from "../services/google-photos.ts";

const photos = new Hono();

/**
 * POST /api/photos/picker/create
 * Create a new Google Photos Picker session
 */
photos.post("/picker/create", async (c) => {
  const accessToken = getAccessToken(c);
  const userId = getUserId(c);

  if (!accessToken || !userId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const session = await createPickerSession(accessToken, userId);

    return c.json({
      success: true,
      sessionId: session.picker_session_id,
      pickerUri: session.picker_uri,
      pollingConfig: session.polling_config ? JSON.parse(session.polling_config) : null,
    });
  } catch (error) {
    console.error("Failed to create picker session:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create picker session",
      },
      500
    );
  }
});

/**
 * GET /api/photos/picker/:sessionId
 * Get picker session status
 */
photos.get("/picker/:sessionId", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const status = await getPickerSessionStatus(accessToken, sessionId);

    // If pickerUri is missing, the session has expired
    // if (!status.pickerUri) {
    //   console.log(`⏰ Session ${sessionId} has expired (no pickerUri)`);
    //   deletePickerSession(sessionId);
    //   return c.json({
    //     success: false,
    //     expired: true,
    //     error: "Session has expired. Please create a new session.",
    //   }, 410); // 410 Gone
    // }

    // Update local database
    updatePickerSession(sessionId, status.mediaItemsSet);

    return c.json({
      success: true,
      sessionId: status.id,
      pickerUri: status.pickerUri,
      mediaItemsSet: status.mediaItemsSet,
      pollingConfig: status.pollingConfig,
    });
  } catch (error) {
    console.error("Failed to get picker session status:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to get session status",
      },
      500
    );
  }
});

/**
 * GET /api/photos/picker/:sessionId/media
 * List media items from picker session
 */
photos.get("/picker/:sessionId/media", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    // First check if media items have been selected
    const status = await getPickerSessionStatus(accessToken, sessionId);

    if (!status.mediaItemsSet) {
      return c.json({
        success: false,
        error: "No media items selected yet. Please open the picker and select photos first.",
        mediaItemsSet: false,
      });
    }

    const mediaItems = await getAllMediaItems(accessToken, sessionId);
    console.log("/photos/picker/:sessionId/media", "mediaItems", mediaItems);

    return c.json({
      success: true,
      count: mediaItems.length,
      mediaItems,
    });
  } catch (error) {
    console.error("Failed to list media items:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to list media items",
      },
      500
    );
  }
});

/**
 * POST /api/photos/picker/:sessionId/ingest
 * Ingest media items from picker session into slideshow
 */
photos.post("/picker/:sessionId/ingest", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    // First check if media items have been selected
    const status = await getPickerSessionStatus(accessToken, sessionId);

    if (!status.mediaItemsSet) {
      return c.json(
        {
          error: "No media items selected yet. Please open the picker and select photos first.",
        },
        400
      );
    }

    // Get media items
    const mediaItems = await getAllMediaItems(accessToken, sessionId);

    // Filter for images only
    const images = mediaItems.filter((item) => item.type === "PHOTO");

    console.log(`📥 Starting ingestion of ${images.length} images from Google Photos`);

    // Import from services/image-ingestion.ts - we'll extend this next
    const { ingestFromGooglePhotos } = await import("../services/image-ingestion.ts");

    const results = await ingestFromGooglePhotos(accessToken, images);

    // Note: We don't delete the session here - let it expire naturally via Google's API
    // This allows users to re-import if needed or view what was imported
    // The session will be cleaned up when:
    // 1. Google's API no longer returns pickerUri (detected during status polling)
    // 2. The expire_time is reached (cleaned up by cleanupExpiredSessions)

    return c.json({
      success: true,
      total: images.length,
      ingested: results.ingested,
      skipped: results.skipped,
      failed: results.failed,
      details: results.details,
    });
  } catch (error) {
    console.error("Failed to ingest media items:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to ingest media items",
      },
      500
    );
  }
});

export default photos;
