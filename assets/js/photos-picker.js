// Global state
let sessionId = null;
let pollInterval = null;
let pollIntervalMs = 10000; // Default 10 seconds
let longPollTimeoutMs = 60000; // Default 60 seconds

// Parse ISO 8601 duration (e.g., "PT10S" -> 10000ms)
function parseDuration(duration) {
  if (!duration) return null;
  const match = duration.match(/PT(\d+(?:\.\d+)?)([HMS])/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2];
  if (unit === 'H') return value * 3600000;
  if (unit === 'M') return value * 60000;
  if (unit === 'S') return value * 1000;
  return null;
}

// Initialize from page data
function initializeSession(sessionData) {
  if (sessionData) {
    sessionId = sessionData.sessionId;
    
    // Initialize polling config from session data
    if (sessionData.pollingConfig) {
      const interval = parseDuration(sessionData.pollingConfig.pollInterval);
      if (interval) pollIntervalMs = interval;
      const timeout = parseDuration(sessionData.pollingConfig.longPollTimeout);
      if (timeout) longPollTimeoutMs = timeout;
    }
    
    // Auto-start polling
    checkStatus();
    pollInterval = setInterval(checkStatus, pollIntervalMs);
  }
}

// Create picker session
function setupCreateButton() {
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
}

// Check session status
async function checkStatus() {
  if (!sessionId) return;

  try {
    const response = await fetch("/api/admin/photos/picker/" + sessionId);
    const data = await response.json();

    const statusMsg = document.getElementById("status-message");
    statusMsg.style.display = "block";

    // Check if session has expired (410 Gone or expired flag)
    if (response.status === 410 || data.expired) {
      statusMsg.className = "status-message error";
      statusMsg.textContent = "⏰ Session has expired. Please create a new session.";
      
      // Stop polling
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      
      // Reload page to show create button
      setTimeout(() => window.location.reload(), 2000);
      return;
    }

    // Update polling config if provided
    if (data.pollingConfig) {
      const newPollInterval = parseDuration(data.pollingConfig.pollInterval);
      if (newPollInterval && newPollInterval !== pollIntervalMs) {
        pollIntervalMs = newPollInterval;
        console.log(`Updated poll interval to ${pollIntervalMs}ms`);
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
function setupCheckButton() {
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
}

// New session button
function setupNewSessionButton() {
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
}

// Ingest photos
function setupIngestButton() {
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
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  setupCreateButton();
  setupCheckButton();
  setupNewSessionButton();
  setupIngestButton();
  
  // Initialize session if data is provided via global var
  if (window.photosPickerSession) {
    initializeSession(window.photosPickerSession);
  }
});
