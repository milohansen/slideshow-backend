import { Firestore } from "@google-cloud/firestore";
import type { Settings } from "@google-cloud/firestore";
import { statSync } from "node:fs";

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
  try {
    // Support both GCP_PROJECT and GCP_PROJECT_ID for flexibility
    const projectId = process.env.GCP_PROJECT || process.env.GCP_PROJECT_ID;
    
    if (!projectId) {
      throw new Error("Missing GCP_PROJECT or GCP_PROJECT_ID environment variable");
    }

    const firestoreConfig: Settings = {
      projectId,
      databaseId: "(default)",
      ignoreUndefinedProperties: true,
    };

    // Check if using Firestore emulator
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
    if (emulatorHost) {
      firestoreConfig.host = emulatorHost;
      firestoreConfig.ssl = false;
      console.log(`🧪 Using Firestore emulator: ${emulatorHost}`);
    } else {
      // For local development, use service account credentials if available
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credentialsPath) {
        try {
          statSync(credentialsPath);
          firestoreConfig.keyFilename = credentialsPath;
          console.log(`📄 Using service account credentials: ${credentialsPath}`);
        } catch (error) {
          console.warn(`⚠️  Could not access credentials file: ${credentialsPath}`);
        }
      } else {
        console.log("🔐 Using Application Default Credentials");
      }
    }

    db = new Firestore(firestoreConfig);

    // Test the connection with timeout (skip for emulator as it might not be running yet)
    if (!emulatorHost) {
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Connection test timeout")), 3000) // Reduced timeout
        );
        const testPromise = db.listCollections();
        await Promise.race([testPromise, timeoutPromise]);
        console.log("🔗 Firestore connection test successful");
      } catch (error) {
        console.warn("⚠️  Firestore connection test failed (but continuing):", error instanceof Error ? error.message : error);
        // Don't throw error, just log it - the app can still function with delayed connections
      }
    }
    
    console.log(`✓ Firestore initialized (Project: ${projectId})`);
  } catch (error) {
    console.error("❌ Failed to initialize Firestore:", error);
    throw error;
  }
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
