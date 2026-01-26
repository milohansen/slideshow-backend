import { Layout } from "./layout.tsx";

export function Upload() {
  return (
    <Layout title="Upload Images">
      <div class="container mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold mb-6">Upload Images</h1>
        
        <div class="bg-white rounded-lg shadow p-6">
          <form id="uploadForm" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">
                Select Images
              </label>
              <input
                type="file"
                id="fileInput"
                name="files"
                multiple
                accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                class="block w-full text-sm text-gray-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-full file:border-0
                  file:text-sm file:font-semibold
                  file:bg-blue-50 file:text-blue-700
                  hover:file:bg-blue-100"
              />
              <p class="mt-2 text-sm text-gray-500">
                Supported formats: JPG, PNG, WebP, GIF
              </p>
            </div>
            
            <div id="fileList" class="space-y-2"></div>
            
            <button
              type="submit"
              class="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              id="uploadButton"
            >
              Upload Images
            </button>
          </form>
          
          <div id="uploadProgress" class="mt-4 hidden">
            <div class="bg-gray-200 rounded-full h-4 overflow-hidden">
              <div id="progressBar" class="bg-blue-500 h-4 transition-all duration-300" style="width: 0%"></div>
            </div>
            <p id="progressText" class="text-sm text-gray-600 mt-2 text-center"></p>
          </div>
          
          <div id="results" class="mt-6 space-y-2"></div>
        </div>
        
        <script src="/assets/js/upload.js"></script>
      </div>
    </Layout>
  );
}
