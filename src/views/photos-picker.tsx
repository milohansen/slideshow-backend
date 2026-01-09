import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

interface PhotosPickerProps {
  session?: {
    sessionId: string;
    pickerUri: string;
  } | null;
  error?: string;
}

export const PhotosPicker: FC<PhotosPickerProps> = ({ session, error }) => {
  return (
    <Layout title="Google Photos Picker">
      <div class="container">
        <h1>Import from Google Photos</h1>
        <p class="subtitle">Select photos from your Google Photos library to add to the slideshow</p>

        {error && (
          <div class="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!session && !error && (
          <div class="card">
            <h2>Create Picker Session</h2>
            <p>Click the button below to start selecting photos from your Google Photos library.</p>
            <button id="create-session-btn" class="button button-primary">
              Start Photo Selection
            </button>
          </div>
        )}

        {session && (
          <>
            <div class="card">
              <h2>Session Created</h2>
              <p><strong>Session ID:</strong> {session.sessionId}</p>
              
              <div class="picker-actions">
                <a 
                  href={session.pickerUri} 
                  target="_blank" 
                  class="button button-primary"
                >
                  Open Google Photos Picker
                </a>
                <button id="check-status-btn" class="button button-secondary">
                  Check Status
                </button>
                <button id="new-session-btn" class="button button-secondary">
                  Create New Session
                </button>
              </div>

              <div id="status-message" class="status-message" style="display: none;"></div>
            </div>

            <div id="media-preview" class="card" style="display: none;">
              <h2>Selected Photos</h2>
              <div id="media-grid" class="media-grid"></div>
              <button id="ingest-btn" class="button button-success">
                Import Selected Photos
              </button>
            </div>

            <div id="ingest-progress" class="card" style="display: none;">
              <h2>Importing Photos...</h2>
              <div class="progress-bar">
                <div id="progress-fill" class="progress-fill"></div>
              </div>
              <p id="progress-text" class="progress-text"></p>
            </div>
          </>
        )}
      </div>

      <style>{`
        .subtitle {
          color: #666;
          margin-bottom: 2rem;
        }

        .picker-actions {
          display: flex;
          gap: 1rem;
          margin-top: 1rem;
        }

        .status-message {
          margin-top: 1rem;
          padding: 1rem;
          background: #e3f2fd;
          border-left: 4px solid #2196F3;
          border-radius: 4px;
        }

        .status-message.success {
          background: #e8f5e9;
          border-color: #4CAF50;
        }

        .status-message.error {
          background: #ffebee;
          border-color: #f44336;
        }

        .error-message {
          padding: 1rem;
          background: #ffebee;
          border-left: 4px solid #f44336;
          border-radius: 4px;
          margin-bottom: 1rem;
          color: #c62828;
        }

        .media-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .media-item {
          border: 1px solid #ddd;
          border-radius: 8px;
          overflow: hidden;
          background: white;
        }

        .media-item img {
          width: 100%;
          height: 200px;
          object-fit: cover;
        }

        .media-item-info {
          padding: 0.5rem;
          font-size: 0.875rem;
          color: #666;
        }

        .progress-bar {
          width: 100%;
          height: 30px;
          background: #e0e0e0;
          border-radius: 15px;
          overflow: hidden;
          margin: 1rem 0;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #4CAF50, #8BC34A);
          width: 0%;
          transition: width 0.3s ease;
        }

        .progress-text {
          text-align: center;
          color: #666;
          font-weight: 500;
        }
      `}</style>

      <script dangerouslySetInnerHTML={{ __html: `
        const sessionId = ${session ? JSON.stringify(session.sessionId) : "null"};
        let pollInterval = null;
        let pollIntervalMs = 10000; // Default 10 seconds
        let longPollTimeoutMs = 60000; // Default 60 seconds

        // Parse ISO 8601 duration (e.g., "PT10S" -> 10000ms)
        function parseDuration(duration) {
          if (!duration) return null;
          const match = duration.match(/PT(\\d+(?:\\.\\d+)?)([HMS])/);
          if (!match) return null;
          const value = parseFloat(match[1]);
          const unit = match[2];
          if (unit === 'H') return value * 3600000;
          if (unit === 'M') return value * 60000;
          if (unit === 'S') return value * 1000;
          return null;
        }

        // Create picker session
        const createBtn = document.getElementById("create-session-btn");
        if (createBtn) {
          createBtn.addEventListener("click", async () => {
            createBtn.disabled = true;
            createBtn.textContent = "Creating session...";

            try {
              const response = await fetch("/api/admin/photos/picker/create", {
                method: "POST",
              });

              if (!response.ok) {
                throw new Error("Failed to create session");
              }

              const data = await response.json();
              
              // Reload page with new session
              window.location.reload();
            } catch (error) {
              alert("Failed to create picker session: " + error.message);
              createBtn.disabled = false;
              createBtn.textContent = "Start Photo Selection";
            }
          });
        }

        // Check session status
        async function checkStatus() {
          if (!sessionId) return;

          try {
            const response = await fetch("/api/admin/photos/picker/" + sessionId);
            const data = await response.json();

            const statusMsg = document.getElementById("status-message");
            statusMsg.style.display = "block";

            // Update polling config if provided
            if (data.pollingConfig) {
              const newPollInterval = parseDuration(data.pollingConfig.pollInterval);
              if (newPollInterval && newPollInterval !== pollIntervalMs) {
                pollIntervalMs = newPollInterval;
                console.log(\`Updated poll interval to \${pollIntervalMs}ms\`);
                // Restart polling with new interval
                if (pollInterval) {
                  clearInterval(pollInterval);
                  pollInterval = setInterval(checkStatus, pollIntervalMs);
                }
              }
              const newLongPollTimeout = parseDuration(data.pollingConfig.longPollTimeout);
              if (newLongPollTimeout) {
                longPollTimeoutMs = newLongPollTimeout;
              }
            }

            if (data.mediaItemsSet) {
              statusMsg.className = "status-message success";
              statusMsg.textContent = "✅ Photos have been selected! Loading preview...";
              
              // Stop polling
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }

              // Load media items
              await loadMediaItems();
            } else {
              statusMsg.className = "status-message";
              statusMsg.textContent = "⏳ Waiting for photo selection... (polling every 10 seconds)";
            }
          } catch (error) {
            console.error("Failed to check status:", error);
          }
        }

        // Load media items
        async function loadMediaItems() {
          try {
            const response = await fetch("/api/admin/photos/picker/" + sessionId + "/media");
            const data = await response.json();

            if (!data.success) {
              const statusMsg = document.getElementById("status-message");
              statusMsg.className = "status-message error";
              statusMsg.textContent = "❌ " + (data.error || "Failed to load media items");
              return;
            }

            if (data.count === 0) {
              const statusMsg = document.getElementById("status-message");
              statusMsg.className = "status-message";
              statusMsg.textContent = "⚠️ No photos found in selection";
              return;
            }

            const grid = document.getElementById("media-grid");
            const preview = document.getElementById("media-preview");

            // Display first 12 items
            const itemsToShow = data.mediaItems.slice(0, 12);
            
            const items = itemsToShow.map(item => {
              return '<div class="media-item">' +
                '<img src="' + item.baseUrl + '=w400-h400" alt="' + item.filename + '" />' +
                '<div class="media-item-info">' +
                '<div>' + item.filename + '</div>' +
                '<div>' + item.metadata.width + ' × ' + item.metadata.height + '</div>' +
                '</div></div>';
            }).join("");
            
            grid.innerHTML = items;

            if (data.count > 12) {
              grid.innerHTML += '<div style="grid-column: 1/-1; text-align: center; padding: 1rem; color: #666;">... and ' + (data.count - 12) + ' more photos</div>';
            }

            preview.style.display = "block";
          } catch (error) {
            console.error("Failed to load media items:", error);
          }
        }

        // Check status button
        const checkBtn = document.getElementById("check-status-btn");
        if (checkBtn) {
          checkBtn.addEventListener("click", () => {
            checkStatus();
            
            // Start polling at configured interval
            if (!pollInterval) {
              pollInterval = setInterval(checkStatus, pollIntervalMs);
            }
          });
        }

        // New session button
        const newSessionBtn = document.getElementById("new-session-btn");
        if (newSessionBtn) {
          newSessionBtn.addEventListener("click", async () => {
            newSessionBtn.disabled = true;
            newSessionBtn.textContent = "Creating...";
            
            try {
              const response = await fetch("/api/admin/photos/picker/create", {
                method: "POST",
              });

              if (!response.ok) {
                throw new Error("Failed to create session");
              }

              // Reload page with new session
              window.location.reload();
            } catch (error) {
              alert("Failed to create new session: " + error.message);
              newSessionBtn.disabled = false;
              newSessionBtn.textContent = "Create New Session";
            }
          });
        }

        // Ingest photos
        const ingestBtn = document.getElementById("ingest-btn");
        if (ingestBtn) {
          ingestBtn.addEventListener("click", async () => {
            const progressDiv = document.getElementById("ingest-progress");
            const progressFill = document.getElementById("progress-fill");
            const progressText = document.getElementById("progress-text");

            ingestBtn.disabled = true;
            progressDiv.style.display = "block";
            progressText.textContent = "Starting import...";

            try {
              const response = await fetch("/api/admin/photos/picker/" + sessionId + "/ingest", {
                method: "POST",
              });

              if (!response.ok) {
                throw new Error("Failed to ingest photos");
              }

              const data = await response.json();

              progressFill.style.width = "100%";
              progressText.textContent = "✅ Successfully imported " + data.ingested + " photos! (Skipped: " + data.skipped + ", Failed: " + data.failed + ")";

              // Redirect to images page after 2 seconds
              setTimeout(() => {
                window.location.href = "/ui/images";
              }, 2000);
            } catch (error) {
              progressText.textContent = "❌ Failed to import photos: " + error.message;
              ingestBtn.disabled = false;
            }
          });
        }

        // Auto-start polling if session exists
        if (sessionId) {
          // Initialize polling config from session data
          const sessionPollingConfig = ${session ? JSON.stringify(session.pollingConfig || null) : "null"};
          if (sessionPollingConfig) {
            const interval = parseDuration(sessionPollingConfig.pollInterval);
            if (interval) pollIntervalMs = interval;
            const timeout = parseDuration(sessionPollingConfig.longPollTimeout);
            if (timeout) longPollTimeoutMs = timeout;
          }
          
          checkStatus();
          pollInterval = setInterval(checkStatus, pollIntervalMs);
        }
      ` }} />
    </Layout>
  );
};
