import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

type Device = {
  id: string;
  name: string;
  width: number;
  height: number;
  orientation: string;
  created_at: string;
  last_seen: string | null;
}

type DevicesProps = {
  devices: Device[];
  error?: string;
}

export const Devices: FC<DevicesProps> = ({ devices, error }) => {
  return (
    <Layout title="Devices">
      {error && (
        <div style="background-color: #fee; border: 1px solid #f88; border-radius: 4px; padding: 1rem; margin-bottom: 1rem; color: #c33;">
          <strong>Error:</strong> {error}
        </div>
      )}
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
        <h1>Registered Devices</h1>
        <button id="add-device-btn" class="btn btn-primary">+ Add Device</button>
      </div>
      
      {/* Add Device Modal */}
      <div id="device-modal" class="modal" style="display: none;">
        <div class="modal-content">
          <div class="modal-header">
            <h2 id="modal-title">Add Device</h2>
            <button class="close-btn" onclick="closeDeviceModal()">&times;</button>
          </div>
          <form id="device-form">
            <input type="hidden" id="device-original-id" />
            <div class="form-group">
              <label for="device-id">Device ID *</label>
              <input type="text" id="device-id" required placeholder="e.g., living-room-display" />
              <small>Unique identifier for the device</small>
            </div>
            <div class="form-group">
              <label for="device-name">Name *</label>
              <input type="text" id="device-name" required placeholder="e.g., Living Room Display" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="device-width">Width (px) *</label>
                <input type="number" id="device-width" required placeholder="800" />
              </div>
              <div class="form-group">
                <label for="device-height">Height (px) *</label>
                <input type="number" id="device-height" required placeholder="480" />
              </div>
            </div>
            <div class="form-group">
              <label for="device-orientation">Orientation *</label>
              <select id="device-orientation" required>
                <option value="">Select orientation</option>
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-secondary" onclick="closeDeviceModal()">Cancel</button>
              <button type="submit" class="btn btn-primary" id="save-device-btn">Save Device</button>
            </div>
          </form>
        </div>
      </div>

      {devices.length === 0 ? (
        <div class="card empty-state">
          <p>No devices registered yet.</p>
          <p style="margin-top: 1rem;">Click "Add Device" to register your first device.</p>
        </div>
      ) : (
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Resolution</th>
                <th>Orientation</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr>
                  <td><strong>{device.name}</strong></td>
                  <td><code>{device.id}</code></td>
                  <td>{device.width} × {device.height}</td>
                  <td>
                    <span class={`badge badge-${device.orientation}`}>
                      {device.orientation}
                    </span>
                  </td>
                  <td class="device-info">
                    {device.last_seen 
                      ? new Date(device.last_seen).toLocaleString()
                      : "Never"}
                  </td>
                  <td>
                    <button 
                      class="btn btn-sm btn-secondary" 
                      onclick={`editDevice('${device.id}', '${device.name}', ${device.width}, ${device.height}, '${device.orientation}')`}
                    >
                      Edit
                    </button>
                    <button 
                      class="btn btn-sm btn-danger" 
                      onclick={`deleteDevice('${device.id}', '${device.name}')`}
                      style="margin-left: 0.5rem;"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <script dangerouslySetInnerHTML={{ __html: `
        let isEditMode = false;

        document.getElementById('add-device-btn').addEventListener('click', () => {
          isEditMode = false;
          document.getElementById('modal-title').textContent = 'Add Device';
          document.getElementById('device-form').reset();
          document.getElementById('device-id').disabled = false;
          document.getElementById('device-original-id').value = '';
          document.getElementById('device-modal').style.display = 'flex';
        });

        function closeDeviceModal() {
          document.getElementById('device-modal').style.display = 'none';
        }

        function editDevice(id, name, width, height, orientation) {
          isEditMode = true;
          document.getElementById('modal-title').textContent = 'Edit Device';
          document.getElementById('device-id').value = id;
          document.getElementById('device-id').disabled = true;
          document.getElementById('device-original-id').value = id;
          document.getElementById('device-name').value = name;
          document.getElementById('device-width').value = width;
          document.getElementById('device-height').value = height;
          document.getElementById('device-orientation').value = orientation;
          document.getElementById('device-modal').style.display = 'flex';
        }

        async function deleteDevice(id, name) {
          if (!confirm(\`Are you sure you want to delete device "\${name}"? This action cannot be undone.\`)) {
            return;
          }

          try {
            const response = await fetch(\`/api/devices/\${id}\`, {
              method: 'DELETE'
            });

            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.error || 'Failed to delete device');
            }

            window.location.reload();
          } catch (error) {
            alert('Error deleting device: ' + error.message);
          }
        }

        document.getElementById('device-form').addEventListener('submit', async (e) => {
          e.preventDefault();

          const id = document.getElementById('device-id').value;
          const name = document.getElementById('device-name').value;
          const width = parseInt(document.getElementById('device-width').value);
          const height = parseInt(document.getElementById('device-height').value);
          const orientation = document.getElementById('device-orientation').value;

          const data = { name, width, height, orientation };
          
          try {
            let response;
            if (isEditMode) {
              const originalId = document.getElementById('device-original-id').value;
              response = await fetch(\`/api/devices/\${originalId}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
            } else {
              data.id = id;
              response = await fetch('/api/devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
            }

            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.error || 'Failed to save device');
            }

            window.location.reload();
          } catch (error) {
            alert('Error saving device: ' + error.message);
          }
        });

        // Close modal when clicking outside
        document.getElementById('device-modal').addEventListener('click', (e) => {
          if (e.target.id === 'device-modal') {
            closeDeviceModal();
          }
        });
      ` }} />

      <style dangerouslySetInnerHTML={{ __html: `
        .modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-content {
          background: white;
          border-radius: 8px;
          width: 90%;
          max-width: 500px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1.5rem;
          border-bottom: 1px solid #e5e7eb;
        }

        .modal-header h2 {
          margin: 0;
          font-size: 1.5rem;
        }

        .close-btn {
          background: none;
          border: none;
          font-size: 2rem;
          cursor: pointer;
          color: #6b7280;
          line-height: 1;
          padding: 0;
          width: 2rem;
          height: 2rem;
        }

        .close-btn:hover {
          color: #1f2937;
        }

        #device-form {
          padding: 1.5rem;
        }

        .form-group {
          margin-bottom: 1.25rem;
        }

        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }

        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 500;
          color: #374151;
        }

        .form-group input,
        .form-group select {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          font-size: 1rem;
        }

        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .form-group small {
          display: block;
          margin-top: 0.25rem;
          color: #6b7280;
          font-size: 0.875rem;
        }

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.75rem;
          padding-top: 1rem;
          border-top: 1px solid #e5e7eb;
        }

        .btn {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          cursor: pointer;
          font-weight: 500;
          transition: background-color 0.2s;
        }

        .btn-primary {
          background: #3b82f6;
          color: white;
        }

        .btn-primary:hover {
          background: #2563eb;
        }

        .btn-secondary {
          background: #e5e7eb;
          color: #374151;
        }

        .btn-secondary:hover {
          background: #d1d5db;
        }

        .btn-danger {
          background: #ef4444;
          color: white;
        }

        .btn-danger:hover {
          background: #dc2626;
        }

        .btn-sm {
          padding: 0.25rem 0.75rem;
          font-size: 0.875rem;
        }

        table td:last-child {
          white-space: nowrap;
        }
      ` }} />
    </Layout>
  );
};
