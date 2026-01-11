/**
 * Database synchronization manager for Cloud Run
 * Handles syncing SQLite database to/from Google Cloud Storage
 */

import { Storage } from "@google-cloud/storage";
import { getDb } from "./schema.ts";

type DBSyncConfig = {
  bucketName: string;
  dbPath: string;
  gcsDbPath: string;
  syncIntervalMs: number;
  leaseTimeoutMs: number;
  instanceId: string;
}

type Lease = {
  instanceId: string;
  acquiredAt: string;
  expiresAt: string;
  lastRenewed?: string;
  previousOwner?: string;
}

export class DatabaseSyncManager {
  private storage: Storage;
  private config: DBSyncConfig;
  private isWriter: boolean = false;
  private leaseTimer?: number;
  private syncTimer?: number;
  private lastSyncTime: Date | null = null;
  private lastDbModTime: Date | null = null;

  constructor(config: DBSyncConfig) {
    this.storage = new Storage();
    this.config = config;
  }

  /**
   * Initialize database synchronization
   */
  async initialize(): Promise<void> {
    console.log("🔄 Initializing database sync...");
    
    // Try to acquire write lease
    this.isWriter = await this.tryAcquireWriteLease();
    
    if (this.isWriter) {
      console.log("✅ Acquired write lease - this instance is the primary writer");
    } else {
      console.log("📖 Running in read-only mode");
    }
    
    // Download latest database from GCS
    await this.downloadDatabase();
    
    // If writer, start periodic sync and lease renewal
    if (this.isWriter) {
      this.startSyncLoop();
      this.startLeaseRenewal();
    }
  }

  /**
   * Try to acquire write lease using GCS conditional operations
   */
  private async tryAcquireWriteLease(): Promise<boolean> {
    const bucket = this.storage.bucket(this.config.bucketName);
    const leaseFile = bucket.file('database/db-lease.json');
    
    try {
      const [exists] = await leaseFile.exists();
      
      if (!exists) {
        // No lease exists, create one
        const lease: Lease = {
          instanceId: this.config.instanceId,
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + this.config.leaseTimeoutMs).toISOString(),
        };
        
        await leaseFile.save(JSON.stringify(lease), {
          preconditionOpts: { ifGenerationMatch: 0 },
        } as any);
        
        return true;
      }
      
      // Check if existing lease is expired
      const [metadata] = await leaseFile.getMetadata();
      const [contents] = await leaseFile.download();
      const lease: Lease = JSON.parse(contents.toString());
      
      const expiresAt = new Date(lease.expiresAt);
      const now = new Date();
      
      if (now > expiresAt) {
        // Lease expired, try to acquire
        const newLease: Lease = {
          instanceId: this.config.instanceId,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(Date.now() + this.config.leaseTimeoutMs).toISOString(),
          previousOwner: lease.instanceId,
        };
        
        await leaseFile.save(JSON.stringify(newLease), {
          preconditionOpts: { ifGenerationMatch: metadata.generation },
        } as any);
        
        console.log(`⚠️  Acquired expired lease from ${lease.instanceId}`);
        return true;
      }
      
      // Lease is held by another instance
      return false;
      
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 412) {
        // Precondition failed - someone else got the lease
        return false;
      }
      console.error("Error acquiring lease:", error);
      return false;
    }
  }

  /**
   * Renew lease periodically to maintain writer status
   */
  private startLeaseRenewal(): void {
    const renewInterval = this.config.leaseTimeoutMs / 2;
    
    this.leaseTimer = setInterval(async () => {
      try {
        await this.renewLease();
      } catch (error) {
        console.error("❌ Failed to renew lease:", error);
        this.isWriter = false;
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        if (this.syncTimer) clearInterval(this.syncTimer);
      }
    }, renewInterval);
  }

  /**
   * Renew the write lease
   */
  private async renewLease(): Promise<void> {
    const bucket = this.storage.bucket(this.config.bucketName);
    const leaseFile = bucket.file('database/db-lease.json');
    
    const [metadata] = await leaseFile.getMetadata();
    const [contents] = await leaseFile.download();
    const lease: Lease = JSON.parse(contents.toString());
    
    if (lease.instanceId !== this.config.instanceId) {
      throw new Error("Lease was taken by another instance");
    }
    
    const updatedLease: Lease = {
      ...lease,
      expiresAt: new Date(Date.now() + this.config.leaseTimeoutMs).toISOString(),
      lastRenewed: new Date().toISOString(),
    };
    
    await leaseFile.save(JSON.stringify(updatedLease), {
      preconditionOpts: { ifGenerationMatch: metadata.generation },
    } as any);
  }

  /**
   * Download database from GCS to local filesystem
   */
  private async downloadDatabase(): Promise<void> {
    const bucket = this.storage.bucket(this.config.bucketName);
    const dbFile = bucket.file(this.config.gcsDbPath);
    
    try {
      const [exists] = await dbFile.exists();
      
      if (!exists) {
        console.log("📝 No existing database in GCS, starting fresh");
        return;
      }
      
      console.log("⬇️  Downloading database from GCS...");
      await dbFile.download({ destination: this.config.dbPath });
      
      // Also download WAL and SHM files if they exist
      await this.downloadWalFiles();
      
      console.log("✅ Database downloaded successfully");
      
    } catch (error) {
      console.error("❌ Failed to download database:", error);
      // Continue with local database
    }
  }

  /**
   * Download WAL and SHM files for complete state
   */
  private async downloadWalFiles(): Promise<void> {
    const bucket = this.storage.bucket(this.config.bucketName);
    
    const walFile = bucket.file(`${this.config.gcsDbPath}-wal`);
    const shmFile = bucket.file(`${this.config.gcsDbPath}-shm`);
    
    try {
      const [walExists] = await walFile.exists();
      if (walExists) {
        await walFile.download({ destination: `${this.config.dbPath}-wal` });
      }
      
      const [shmExists] = await shmFile.exists();
      if (shmExists) {
        await shmFile.download({ destination: `${this.config.dbPath}-shm` });
      }
    } catch (error) {
      console.warn("⚠️  Could not download WAL files:", error);
    }
  }

  /**
   * Upload database to GCS
   */
  private async uploadDatabase(): Promise<void> {
    if (!this.isWriter) {
      console.warn("⚠️  Not the writer, skipping upload");
      return;
    }
    
    // Check if database has been modified since last sync
    if (!(await this.shouldSync())) {
      return;
    }
    
    const bucket = this.storage.bucket(this.config.bucketName);
    
    try {
      // Checkpoint WAL to consolidate changes into main DB
      const db = getDb();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      
      console.log("⬆️  Uploading database to GCS...");
      
      // Upload main database file
      await bucket.upload(this.config.dbPath, {
        destination: this.config.gcsDbPath,
        metadata: {
          metadata: {
            uploadedBy: this.config.instanceId,
            uploadedAt: new Date().toISOString(),
          },
        },
      } as any);
      
      // Upload WAL and SHM files if they exist
      await this.uploadWalFiles(bucket);
      
      this.lastSyncTime = new Date();
      console.log("✅ Database uploaded successfully");
      
    } catch (error) {
      console.error("❌ Failed to upload database:", error);
      throw error;
    }
  }

  /**
   * Check if database should be synced (has it been modified?)
   */
  private async shouldSync(): Promise<boolean> {
    try {
      const stat = await Deno.stat(this.config.dbPath);
      const modTime = stat.mtime;
      
      if (!modTime || !this.lastDbModTime) {
        this.lastDbModTime = modTime;
        return true;
      }
      
      const changed = modTime > this.lastDbModTime;
      if (changed) {
        this.lastDbModTime = modTime;
      }
      return changed;
    } catch (error) {
      console.error("Error checking DB modification time:", error);
      return true; // Sync on error to be safe
    }
  }

  /**
   * Upload WAL and SHM files
   */
  private async uploadWalFiles(bucket: ReturnType<Storage['bucket']>): Promise<void> {
    try{
      // Check if WAL file exists
      const walPath = `${this.config.dbPath}-wal`;
      try {
        await Deno.stat(walPath);
        await bucket.upload(walPath, {
          destination: `${this.config.gcsDbPath}-wal`,
        } as any);
      } catch {
        // WAL file doesn't exist, that's okay
      }
      
      // Check if SHM file exists
      const shmPath = `${this.config.dbPath}-shm`;
      try {
        await Deno.stat(shmPath);
        await bucket.upload(shmPath, {
          destination: `${this.config.gcsDbPath}-shm`,
        } as any);
      } catch {
        // SHM file doesn't exist, that's okay
      }
    } catch (error) {
      console.warn("⚠️  Could not upload WAL files:", error);
    }
  }

  /**
   * Start periodic sync loop
   */
  private startSyncLoop(): void {
    this.syncTimer = setInterval(async () => {
      try {
        await this.uploadDatabase();
      } catch (error) {
        console.error("❌ Periodic sync failed:", error);
      }
    }, this.config.syncIntervalMs);
  }

  /**
   * Graceful shutdown - sync one last time and release lease
   */
  async shutdown(): Promise<void> {
    console.log("🛑 Shutting down database sync...");
    
    // Stop timers
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    
    // Final sync if we're the writer
    if (this.isWriter) {
      try {
        await this.uploadDatabase();
        await this.releaseLease();
        console.log("✅ Database synced and lease released");
      } catch (error) {
        console.error("❌ Error during shutdown sync:", error);
      }
    }
  }

  /**
   * Release write lease
   */
  private async releaseLease(): Promise<void> {
    const bucket = this.storage.bucket(this.config.bucketName);
    const leaseFile = bucket.file('database/db-lease.json');
    
    try {
      await leaseFile.delete();
    } catch (error) {
      console.error("⚠️  Failed to release lease:", error);
    }
  }
  
  /**
   * Get sync status for monitoring
   */
  getStatus() {
    return {
      isWriter: this.isWriter,
      instanceId: this.config.instanceId,
      lastSyncTime: this.lastSyncTime,
    };
  }
}
