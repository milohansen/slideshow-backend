const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const uploadForm = document.getElementById('uploadForm');
const uploadButton = document.getElementById('uploadButton');
const uploadProgress = document.getElementById('uploadProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const results = document.getElementById('results');

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  fileList.innerHTML = '';
  
  if (files.length === 0) {
    fileList.innerHTML = '<p class="text-sm text-gray-500">No files selected</p>';
    return;
  }
  
  fileList.innerHTML = '<p class="text-sm font-medium text-gray-700 mb-2">Selected files:</p>';
  files.forEach(file => {
    const fileItem = document.createElement('div');
    fileItem.className = 'text-sm text-gray-600 flex items-center';
    fileItem.innerHTML = `
      <svg class="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clip-rule="evenodd"/>
      </svg>
      ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)
    `;
    fileList.appendChild(fileItem);
  });
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const files = fileInput.files;
  if (!files || files.length === 0) {
    alert('Please select at least one file');
    return;
  }
  
  // Show progress
  uploadProgress.classList.remove('hidden');
  uploadButton.disabled = true;
  results.innerHTML = '';
  progressBar.style.width = '0%';
  progressText.textContent = 'Uploading...';
  
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append(`files${i}`, files[i]);
  }
  
  try {
    progressBar.style.width = '50%';
    
    const response = await fetch('/api/admin/upload', {
      method: 'POST',
      body: formData,
    });
    
    progressBar.style.width = '100%';
    
    const data = await response.json();
    
    if (data.success) {
      progressText.textContent = `Successfully uploaded ${data.uploaded} image(s)`;
      
      // Show results
      results.innerHTML = '<h3 class="font-medium text-gray-900 mb-2">Upload Results:</h3>';
      
      data.results.forEach(result => {
        const resultItem = document.createElement('div');
        resultItem.className = `p-3 rounded ${result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`;
        resultItem.innerHTML = `
          <div class="flex items-start">
            <svg class="w-5 h-5 mr-2 ${result.success ? 'text-green-500' : 'text-red-500'}" fill="currentColor" viewBox="0 0 20 20">
              ${result.success 
                ? '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>'
                : '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>'
              }
            </svg>
            <div class="flex-1">
              <p class="font-medium ${result.success ? 'text-green-900' : 'text-red-900'}">${result.filename}</p>
              ${result.success 
                ? `<p class="text-sm text-gray-600">ID: ${result.id} | ${result.dimensions} | ${result.orientation}</p>`
                : `<p class="text-sm text-red-700">${result.error}</p>`
              }
            </div>
          </div>
        `;
        results.appendChild(resultItem);
      });
      
      // Reset form after 2 seconds
      setTimeout(() => {
        fileInput.value = '';
        fileList.innerHTML = '';
        uploadProgress.classList.add('hidden');
        uploadButton.disabled = false;
      }, 2000);
    } else {
      throw new Error(data.error || 'Upload failed');
    }
  } catch (error) {
    progressBar.style.width = '100%';
    progressBar.className = 'bg-red-500 h-4 transition-all duration-300';
    progressText.textContent = 'Upload failed: ' + error.message;
    uploadButton.disabled = false;
  }
});
