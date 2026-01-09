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
      <link rel="stylesheet" href="/assets/css/photos-picker.css" />
      
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
                <button 
                  id="open-picker-btn"
                  class="button button-primary"
                  data-picker-uri={session.pickerUri}
                >
                  Open Google Photos Picker
                </button>
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

      {session && (
        <script dangerouslySetInnerHTML={{ __html: `
          window.photosPickerSession = ${JSON.stringify({
            sessionId: session.sessionId,
            pollingConfig: null
          })};
        ` }} />
      )}
      <script src="/assets/js/photos-picker.js"></script>
    </Layout>
  );
};
