document.addEventListener('DOMContentLoaded', () => {
  const deleteAllBtn = document.getElementById('delete-all-btn');
  
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async () => {
      const confirmed = confirm('⚠️ Are you sure you want to delete ALL images? This cannot be undone!');
      
      if (!confirmed) {
        return;
      }
      
      deleteAllBtn.disabled = true;
      deleteAllBtn.textContent = 'Deleting...';
      
      try {
        const response = await fetch('/api/admin/images/delete-all', {
          method: 'DELETE',
        });
        
        if (!response.ok) {
          throw new Error('Failed to delete images');
        }
        
        const data = await response.json();
        
        alert(`✓ Successfully deleted ${data.deleted} images and ${data.processedDeleted} processed versions`);
        
        // Reload page to show empty state
        window.location.reload();
      } catch (error) {
        alert('Failed to delete images: ' + error.message);
        deleteAllBtn.disabled = false;
        deleteAllBtn.textContent = '🗑️ Delete All Images';
      }
    });
  }
});
