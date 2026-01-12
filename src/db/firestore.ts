import { Firestore } from "@google-cloud/firestore";

let db: Firestore;

/**
 * Get the initialized Firestore instance
 */
export function getFirestore(): Firestore {
  if (!db) {
    throw new Error("Firestore not initialized");
  }
  return db;
}

/**
 * Initialize Firestore connection
 * Uses Application Default Credentials from environment
 */
export async function initFirestore(): Promise<void> {
  db = new Firestore({
    projectId: Deno.env.get("GCP_PROJECT") || undefined,
    databaseId: "(default)",
  });

  console.log("✓ Firestore initialized");
}

/**
 * Collection references for type safety
 */
export const Collections = {
  BLOBS: "blobs",
  SOURCES: "sources",
  DEVICE_VARIANTS: "device_variants",
  DEVICES: "devices",
  DEVICE_QUEUE_STATE: "device_queue_state",
  AUTH_SESSIONS: "auth_sessions",
  PICKER_SESSIONS: "picker_sessions",
  FAILED_TASKS: "failed_tasks",
} as const;

/**
 * Helper to get a collection reference
 */
export function getCollection(name: string) {
  return getFirestore().collection(name);
}
