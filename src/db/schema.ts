import { Database } from "sqlite";

let db: Database;

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

// deno-lint-ignore require-await
export async function initDatabase() {
  db = new Database("slideshow.db");

  // Enable WAL mode for better concurrency and crash recovery
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA wal_autocheckpoint=1000");
  db.exec("PRAGMA busy_timeout=5000");

  // Blobs table - stores unique image content by hash (deduplication)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      storage_path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      aspect_ratio REAL NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape', 'square')),
      file_size INTEGER,
      mime_type TEXT,
      color_palette TEXT,
      color_source TEXT,
      blurhash TEXT,
      exif_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Sources table - user-facing image records with ingestion status
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      blob_hash TEXT,
      origin TEXT NOT NULL CHECK(origin IN ('google_photos', 'upload', 'url')),
      external_id TEXT,
      status TEXT DEFAULT 'staged' CHECK(status IN ('staged', 'processing', 'ready', 'failed')),
      status_message TEXT,
      staging_path TEXT,
      ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (blob_hash) REFERENCES blobs(hash) ON DELETE SET NULL,
      UNIQUE(user_id, external_id, origin)
    )
  `);

  // Device variants table - processed image outputs keyed by blob and size
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_variants (
      id TEXT PRIMARY KEY,
      blob_hash TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape')),
      storage_path TEXT NOT NULL,
      file_size INTEGER,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (blob_hash) REFERENCES blobs(hash) ON DELETE CASCADE,
      UNIQUE(blob_hash, width, height)
    )
  `);

  // Legacy: Images table - stores original image metadata (DEPRECATED, keep for migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      file_hash TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      aspect_ratio REAL NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape', 'square')),
      thumbnail_path TEXT,
      processing_status TEXT DEFAULT 'pending' CHECK(processing_status IN ('pending', 'processing', 'complete', 'failed')),
      processing_error TEXT,
      processing_app_id TEXT,
      ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_modified DATETIME NOT NULL
    )
  `);

  // Legacy: Processed images table - stores resized variants with color data (DEPRECATED, keep for migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_images (
      id TEXT PRIMARY KEY,
      image_id TEXT NOT NULL,
      device_size TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      color_primary TEXT NOT NULL,
      color_secondary TEXT NOT NULL,
      color_tertiary TEXT NOT NULL,
      color_source TEXT NOT NULL,
      color_palette TEXT NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
      UNIQUE(image_id, device_size)
    )
  `);

  // Devices table - stores device configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape')),
      capabilities TEXT,
      version TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME
    )
  `);

  // Device queue state table - persists slideshow queue per device
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_queue_state (
      device_id TEXT PRIMARY KEY,
      queue_data TEXT NOT NULL,
      current_index INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Auth sessions table - stores OAuth tokens for authenticated users
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      name TEXT,
      picture TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Picker sessions table - tracks Google Photos Picker sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS picker_sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      picker_session_id TEXT NOT NULL,
      picker_uri TEXT NOT NULL,
      media_items_set BOOLEAN DEFAULT 0,
      polling_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES auth_sessions(user_id) ON DELETE CASCADE
    )
  `);

  // Create indices for better query performance
  // New schema indices
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_blob_hash ON sources(blob_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_user_id ON sources(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_device_variants_blob_hash ON device_variants(blob_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_device_variants_dimensions ON device_variants(width, height)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blobs_orientation ON blobs(orientation)`);
  
  // Legacy schema indices
  db.exec(`CREATE INDEX IF NOT EXISTS idx_images_orientation ON images(orientation)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_images_image_id ON processed_images(image_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_images_device_size ON processed_images(device_size)`);

  // Run migrations for schema updates
  runMigrations(db);

  // Initialize with default devices if table is empty
  initializeDefaultDevices(db);

  console.log("✅ Database initialized");
}

/**
 * Run schema migrations for existing databases
 */
function runMigrations(db: Database): void {
  // Migration 1: Add thumbnail_path column to images table if it doesn't exist
  try {
    const tableInfo = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const hasThumbnailPath = tableInfo.some(col => col.name === "thumbnail_path");
    
    if (!hasThumbnailPath) {
      console.log("🔄 Running migration: Adding thumbnail_path column to images table");
      db.exec("ALTER TABLE images ADD COLUMN thumbnail_path TEXT");
      console.log("✅ Migration completed: thumbnail_path column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 2: Add processing_status and processing_error columns
  try {
    const tableInfo = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const hasProcessingStatus = tableInfo.some(col => col.name === "processing_status");
    const hasProcessingError = tableInfo.some(col => col.name === "processing_error");
    
    if (!hasProcessingStatus) {
      console.log("🔄 Running migration: Adding processing_status column to images table");
      db.exec("ALTER TABLE images ADD COLUMN processing_status TEXT DEFAULT 'failed' CHECK(processing_status IN ('pending', 'processing', 'complete', 'failed'))");
      
      console.log("✅ Migration completed: processing_status column added");
    }
    
    if (!hasProcessingError) {
      console.log("🔄 Running migration: Adding processing_error column to images table");
      db.exec("ALTER TABLE images ADD COLUMN processing_error TEXT DEFAULT 'Migration: status unknown'");
      console.log("✅ Migration completed: processing_error column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 3: Add expire_time column to picker_sessions table
  try {
    const tableInfo = db.prepare("PRAGMA table_info(picker_sessions)").all() as Array<{ name: string }>;
    const hasExpireTime = tableInfo.some(col => col.name === "expire_time");
    
    if (!hasExpireTime) {
      console.log("🔄 Running migration: Adding expire_time column to picker_sessions table");
      db.exec("ALTER TABLE picker_sessions ADD COLUMN expire_time DATETIME");
      console.log("✅ Migration completed: expire_time column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 4: Add processing_app_id column to images table
  try {
    const tableInfo = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const hasProcessingAppId = tableInfo.some(col => col.name === "processing_app_id");
    
    if (!hasProcessingAppId) {
      console.log("🔄 Running migration: Adding processing_app_id column to images table");
      db.exec("ALTER TABLE images ADD COLUMN processing_app_id TEXT");
      console.log("✅ Migration completed: processing_app_id column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 5: Add aspect_ratio column to images table
  try {
    const tableInfo = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const hasAspectRatio = tableInfo.some(col => col.name === "aspect_ratio");
    
    if (!hasAspectRatio) {
      console.log("🔄 Running migration: Adding aspect_ratio column to images table");
      db.exec("ALTER TABLE images ADD COLUMN aspect_ratio REAL");
      
      // Calculate and update aspect ratio for existing images
      const images = db.prepare("SELECT id, width, height FROM images").all() as Array<{ id: string; width: number; height: number }>;
      const updateStmt = db.prepare("UPDATE images SET aspect_ratio = ? WHERE id = ?");
      
      for (const image of images) {
        // Prevent division by zero
        const ratio = image.height > 0 ? parseFloat((image.width / image.height).toFixed(5)) : 1.0;
        updateStmt.run(ratio, image.id);
      }
      
      console.log(`✅ Migration completed: aspect_ratio column added and calculated for ${images.length} images`);
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 6: Remove google_photos_base_url column if it exists (no longer needed)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const hasGooglePhotosBaseUrl = tableInfo.some(col => col.name === "google_photos_base_url");
    
    if (hasGooglePhotosBaseUrl) {
      console.log("🔄 Running migration: Removing google_photos_base_url column from images table");
      // SQLite doesn't support DROP COLUMN directly, but since this was just added in a recent migration
      // and the column is optional, we can leave it (it won't be used)
      console.log("✅ Migration skipped: Column exists but will not be used (SQLite limitation)");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 7: Add source_color column to processed_images table
  try {
    const tableInfo = db.prepare("PRAGMA table_info(processed_images)").all() as Array<{ name: string }>;
    const hasSourceColor = tableInfo.some(col => col.name === "color_source");
    
    if (!hasSourceColor) {
      console.log("🔄 Running migration: Adding color_source column to processed_images table");
      db.exec("ALTER TABLE processed_images ADD COLUMN color_source TEXT");
      
      // Update existing rows to use primary color as source color
      db.exec("UPDATE processed_images SET color_source = color_primary WHERE color_source IS NULL");
      
      console.log("✅ Migration completed: color_source column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }

  // Migration 8: Add capabilities and version columns to devices table
  try {
    const tableInfo = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    const hasCapabilities = tableInfo.some(col => col.name === "capabilities");
    const hasVersion = tableInfo.some(col => col.name === "version");
    
    if (!hasCapabilities) {
      console.log("🔄 Running migration: Adding capabilities column to devices table");
      db.exec("ALTER TABLE devices ADD COLUMN capabilities TEXT");
      console.log("✅ Migration completed: capabilities column added");
    }
    
    if (!hasVersion) {
      console.log("🔄 Running migration: Adding version column to devices table");
      db.exec("ALTER TABLE devices ADD COLUMN version TEXT");
      console.log("✅ Migration completed: version column added");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
  }
}

/**
 * Initialize default devices if devices table is empty
 */
function initializeDefaultDevices(db: Database): void {
  const count = db.prepare("SELECT COUNT(*) as count FROM devices").get() as { count: number };
  
  if (count.count === 0) {
    console.log("📱 Initializing default devices...");
    
    const defaultDevices = [
      {
        id: "kitchen-display",
        name: "Kitchen Display",
        width: 1024,
        height: 600,
        orientation: "landscape",
      },
      {
        id: "bedroom-clock",
        name: "Bedroom Clock",
        width: 300,
        height: 400,
        orientation: "portrait",
      },
    ];
    
    const stmt = db.prepare(`
      INSERT INTO devices (id, name, width, height, orientation, last_seen)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    for (const device of defaultDevices) {
      stmt.run(device.id, device.name, device.width, device.height, device.orientation);
      console.log(`  ✓ ${device.name} (${device.width}x${device.height} ${device.orientation})`);
    }
    
    console.log(`✅ Initialized ${defaultDevices.length} default devices`);
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
  }
}
