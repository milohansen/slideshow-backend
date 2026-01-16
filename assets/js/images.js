document.addEventListener("DOMContentLoaded", () => {
  const deleteAllBtn = document.getElementById("delete-all-btn");

  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", async () => {
      const confirmed = confirm("⚠️ Are you sure you want to delete ALL images? This cannot be undone!");

      if (!confirmed) {
        return;
      }

      deleteAllBtn.disabled = true;
      deleteAllBtn.textContent = "Deleting...";

      try {
        const response = await fetch("/api/admin/images/delete-all", {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error("Failed to delete images");
        }

        const data = await response.json();

        alert(`✓ Successfully deleted ${data.deleted} images and ${data.processedDeleted} processed versions`);

        // Reload page to show empty state
        window.location.reload();
      } catch (error) {
        alert("Failed to delete images: " + error.message);
        deleteAllBtn.disabled = false;
        deleteAllBtn.textContent = "🗑️ Delete All Images";
      }
    });
  }

  // Delete single image
  const deleteImageBtns = document.querySelectorAll(".delete-image-btn");

  deleteImageBtns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const imageId = e.target.dataset.imageId;
      const row = e.target.closest("tr");
      const fileName = row.querySelector("code")?.textContent || "this image";

      const confirmed = confirm(`⚠️ Are you sure you want to delete "${fileName}"? This cannot be undone!`);

      if (!confirmed) {
        return;
      }

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "⏳";

      try {
        const response = await fetch(`/api/admin/images/${imageId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Failed to delete image");
        }

        // Remove the row from the table
        row.remove();

        // Check if there are no more images
        const tbody = document.querySelector("tbody");
        if (tbody && tbody.children.length === 0) {
          window.location.reload();
        }
      } catch (error) {
        alert("Failed to delete image: " + error.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  // Analyze single image
  const analyzeImageBtns = document.querySelectorAll(".analyze-image-btn");

  analyzeImageBtns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const imageId = e.target.dataset.imageId;

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "⏳";

      try {
        const response = await fetch(`/api/admin/images/analyze/${imageId}`, {
          method: "POST",
        });
        if (!response.ok) {
          const data = await response.json();
          console.log("Body:", data);
          throw new Error(data.error || "Failed to analyze image");
        }
        console.log("Response:", response);
        console.log("Body:", await response.json());
      } catch (error) {
        // alert("Failed to analyze image: " + error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  // const colorSwatches = document.querySelectorAll(".color-swatch");
  // colorSwatches.forEach((swatch) => {
  //   swatch.addEventListener("click", (e) => {
  //     const colorHex = e.target.dataset.colorHex.replace("#", "");
  //     fetch(`/api/maketheme/${colorHex}`)
  //       .then((response) => {
  //         if (!response.ok) {
  //           throw new Error("Network response was not ok");
  //         }
  //         return response.json();
  //       })
  //       .then((data) => {
  //         console.log("Theme data:", data);
  //       })
  //       .catch((error) => {
  //         console.error("There was a problem with the fetch operation:", error);
  //       });
  //   });
  // });
});
