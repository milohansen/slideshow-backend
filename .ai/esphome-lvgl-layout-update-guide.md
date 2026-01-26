# ESPHome LVGL Multi-Layout Implementation Guide

## Overview
This guide describes the complete process for updating the ESPHome LVGL display to support multi-layout slideshow rendering, including single-image and paired-image (side-by-side) layouts.

## Architecture Changes

### Current State
- 6 display slots arranged horizontally in a scrolling container
- Each slot has a single `background_image_*` widget
- 4 `online_image` components buffer images (slots 0-3 loaded, 4-5 pending)
- Queue items contain: `imageId`, `filePath`, `colorPalette`

### Target State
- 6 display slots, each with **2 image sub-slots** (12 total image widgets)
- 8 `online_image` components to handle dual loading
- Queue items include: `layoutType`, `variantDimensions`, `isPaired`, `pairedWith`, `pairedFilePath`
- Dynamic visibility: hide second sub-slot for single layouts, show both for paired layouts

---

## Implementation Steps

### 1. Update Global Variables

**File:** `esphome-devices/core/code.yaml` or `esphome-devices/core/esphome.yaml`

Add new globals to track layout state:

```yaml
globals:
  # Existing globals (keep these)
  - id: component_to_slot
    type: int[8]  # Changed from 4 to 8
    restore_value: no
    initial_value: "{0, 1, 2, 3, 4, 5, 6, 7}"
  
  - id: slot_source_colors
    type: std::map<int, std::vector<uint32_t>>
    restore_value: no
  
  - id: slideshow_queue_ids
    type: std::vector<std::string>
    restore_value: no
  
  - id: slideshow_queue_index
    type: int
    restore_value: no
    initial_value: "0"
  
  - id: current_display_index
    type: int
    restore_value: no
    initial_value: "0"
  
  # NEW: Track layout types per slot
  - id: slot_layout_types
    type: std::map<int, std::string>  # "single", "pair-vertical", "pair-horizontal"
    restore_value: no
  
  # NEW: Track pairing relationships
  - id: slot_is_paired
    type: bool[6]
    restore_value: no
    initial_value: "{false, false, false, false, false, false}"
  
  - id: slot_paired_with_index
    type: int[6]  # Index of paired queue item (-1 if not paired)
    restore_value: no
    initial_value: "{-1, -1, -1, -1, -1, -1, -1}"
  
  # NEW: Track variant dimensions for dynamic resizing
  - id: slot_image_widths
    type: int[6]
    restore_value: no
    initial_value: "{1024, 1024, 1024, 1024, 1024, 1024}"
  
  - id: slot_image_heights
    type: int[6]
    restore_value: no
    initial_value: "{600, 600, 600, 600, 600, 600}"
```

---

### 2. Update LVGL Container Structure

**File:** `esphome-devices/hw/lvgl.yaml`

Modify each image container to have dual image slots:

```yaml
# Example for container 0 (repeat for containers 1-5)
- obj:
    id: image_container_0
    width: SIZE_CONTENT
    height: ${container_height}
    layout:
      type: FLEX
      flex_flow: ROW
      flex_main_place: CENTER
      flex_cross_place: CENTER
      flex_track_place: CENTER
    flex_grow: 0
    flex_shrink: 0
    snappable: true
    widgets:
      # Primary image (always visible)
      - image:
          id: background_image_0_primary
          src: landscape
          align: CENTER
          width: ${screenwidth}  # Will be adjusted dynamically
          height: ${screenheight}
      
      # Secondary image (hidden for single layouts)
      - image:
          id: background_image_0_secondary
          src: landscape
          align: CENTER
          width: ${screenwidth}  # Will be adjusted dynamically
          height: ${screenheight}
          hidden: true  # Start hidden
```

**Key points:**
- Use `FLEX` layout with `ROW` flow for horizontal arrangement
- Both images start at full screen size
- Secondary image starts hidden
- Remove or update any existing single `background_image_*` widgets

---

### 3. Update Queue Fetch Script

**File:** `esphome-devices/core/code.yaml`

Modify `fetch_slideshow_queue` to parse layout metadata:

```yaml
- id: fetch_slideshow_queue
  then:
    - logger.log: "Fetching slideshow queue from API..."
    - http_request.get:
        url: "${slideshow_api_base}/api/devices/${slideshow_device_id}/slideshow"
        capture_response: true
        on_response:
          then:
            - lambda: |-
                if (response->status_code != 200)
                {
                  ESP_LOGW("slideshow_api", "Failed to fetch queue: status %d", response->status_code);
                  return;
                }
                
                ESP_LOGI("slideshow_api", "Parsing JSON response...");
                
                // Parse JSON array
                json::parse_json(response->body, [](JsonObject root) {
                  if (!root.containsKey("queue"))
                  {
                    ESP_LOGW("slideshow_api", "No 'queue' field in response");
                    return;
                  }
                  
                  JsonArray queue = root["queue"];
                  int queue_size = queue.size();
                  ESP_LOGI("slideshow_api", "Queue size: %d", queue_size);
                  
                  // Clear existing data
                  id(slideshow_queue_ids).clear();
                  id(slot_layout_types).clear();
                  id(slot_source_colors).clear();
                  
                  // Reset pairing state
                  for (int i = 0; i < 6; i++)
                  {
                    id(slot_is_paired)[i] = false;
                    id(slot_paired_with_index)[i] = -1;
                  }
                  
                  // Parse each queue item
                  for (int i = 0; i < queue_size && i < 6; i++)
                  {
                    JsonObject item = queue[i];
                    
                    // Image ID and file path
                    std::string image_id = item["imageId"] | item["blobHash"];
                    std::string file_path = item["filePath"];
                    
                    // Layout information
                    std::string layout_type = item["layoutType"] | "single";
                    id(slot_layout_types)[i] = layout_type;
                    
                    // Variant dimensions
                    if (item.containsKey("variantDimensions"))
                    {
                      JsonObject dims = item["variantDimensions"];
                      id(slot_image_widths)[i] = dims["width"] | 1024;
                      id(slot_image_heights)[i] = dims["height"] | 600;
                    }
                    
                    // Pairing information
                    bool is_paired = item["isPaired"] | false;
                    if (is_paired && item.containsKey("pairedWith"))
                    {
                      id(slot_is_paired)[i] = true;
                      std::string paired_file_path = item["pairedFilePath"];
                      
                      // Store paired image path for later loading
                      // (implement custom storage if needed)
                    }
                    
                    // Color palette
                    if (item.containsKey("colorPalette"))
                    {
                      JsonObject palette = item["colorPalette"];
                      if (palette.containsKey("allColors"))
                      {
                        JsonArray colors = palette["allColors"];
                        std::vector<uint32_t> color_vec;
                        
                        for (JsonVariant color : colors)
                        {
                          std::string hex_color = color.as<std::string>();
                          uint32_t argb = parse_hex_color(hex_color);
                          color_vec.push_back(argb);
                        }
                        
                        id(slot_source_colors)[i] = color_vec;
                      }
                    }
                    
                    // Build image URL
                    std::string url = "${slideshow_api_base}/api/devices/${slideshow_device_id}/images/" + image_id;
                    id(slideshow_queue_ids).push_back(image_id);
                    
                    // Publish to text sensors (keep for compatibility)
                    if (i < 6)
                    {
                      text_sensor::TextSensor* url_sensors[6] = {
                        id(ha_image_url_slot_0), id(ha_image_url_slot_1), 
                        id(ha_image_url_slot_2), id(ha_image_url_slot_3),
                        id(ha_image_url_slot_4), id(ha_image_url_slot_5)
                      };
                      url_sensors[i]->publish_state(url);
                    }
                    
                    ESP_LOGI("slideshow_api", "Slot %d: layout=%s, size=%dx%d, paired=%d",
                             i, layout_type.c_str(), 
                             id(slot_image_widths)[i], id(slot_image_heights)[i],
                             is_paired);
                  }
                });
                
                // Trigger initial image load
                id(update_online_images).execute();
```

**Helper function to add:**
```cpp
// In lambda or globals section
uint32_t parse_hex_color(const std::string& hex) {
  if (hex.empty() || hex[0] != '#') return 0xFF000000;
  
  uint32_t rgb = std::stoul(hex.substr(1), nullptr, 16);
  return 0xFF000000 | rgb;  // Add full alpha
}
```

---

### 4. Update Image Loading Script

**File:** `esphome-devices/core/code.yaml`

Modify `update_online_images` to handle layouts and dimensions:

```yaml
- id: update_online_images
  then:
    - lambda: |-
        ESP_LOGI("slideshow", "Updating online images with layout awareness...");
        
        // Get queue size
        int queue_size = id(slideshow_queue_ids).size();
        if (queue_size == 0)
        {
          ESP_LOGW("slideshow", "Queue is empty, cannot update images");
          return;
        }
        
        // Load current + 3 lookahead slots
        int current_slot = id(current_display_index).state;
        int slots_to_load[4];
        
        for (int i = 0; i < 4; i++)
        {
          slots_to_load[i] = (current_slot + i) % 6;
        }
        
        // Map components to slots
        esphome::online_image::OnlineImage* components[8] = {
          id(online_image_0), id(online_image_1), id(online_image_2), id(online_image_3),
          id(online_image_4), id(online_image_5), id(online_image_6), id(online_image_7)
        };
        
        int component_idx = 0;
        
        for (int i = 0; i < 4; i++)
        {
          int slot = slots_to_load[i];
          int queue_idx = slot % queue_size;
          
          std::string layout = id(slot_layout_types)[slot];
          bool is_paired = id(slot_is_paired)[slot];
          
          int img_width = id(slot_image_widths)[slot];
          int img_height = id(slot_image_heights)[slot];
          
          // Build primary image URL
          std::string image_id = id(slideshow_queue_ids)[queue_idx];
          std::string url = "${slideshow_api_base}/api/devices/${slideshow_device_id}/images/" + image_id;
          
          // Load primary image
          if (component_idx < 8)
          {
            auto* comp = components[component_idx];
            id(component_to_slot)[component_idx] = slot;
            
            // Set dynamic resize dimensions
            comp->set_resize_width(img_width);
            comp->set_resize_height(img_height);
            
            comp->set_url(url);
            comp->update();
            
            ESP_LOGI("slideshow", "Component %d -> Slot %d: %s (%dx%d, layout=%s)",
                     component_idx, slot, url.c_str(), img_width, img_height, layout.c_str());
            
            component_idx++;
          }
          
          // Load secondary image if paired
          if (is_paired && component_idx < 8)
          {
            // Get paired image URL (from stored pairedFilePath or next queue item)
            // For now, use next queue item as paired image
            int paired_queue_idx = (queue_idx + 1) % queue_size;
            std::string paired_id = id(slideshow_queue_ids)[paired_queue_idx];
            std::string paired_url = "${slideshow_api_base}/api/devices/${slideshow_device_id}/images/" + paired_id;
            
            auto* comp = components[component_idx];
            id(component_to_slot)[component_idx] = slot;  // Same slot, different sub-slot
            
            comp->set_resize_width(img_width);
            comp->set_resize_height(img_height);
            comp->set_url(paired_url);
            comp->update();
            
            ESP_LOGI("slideshow", "Component %d -> Slot %d (paired): %s", 
                     component_idx, slot, paired_url.c_str());
            
            component_idx++;
          }
        }
```

---

### 5. Update LVGL Widget Update Logic

**File:** `esphome-devices/core/code.yaml`

In the `online_image` `on_download_finished` callbacks, update both primary and secondary widgets:

```yaml
online_image:
  - id: online_image_0
    on_download_finished:
      - lambda: |-
          int slot = id(component_to_slot)[0];
          ESP_LOGI("online_image", "Component 0 -> Slot %d downloaded", slot);
          
          // Determine which sub-slot this is (primary or secondary)
          // Check if previous component targets same slot (means this is secondary)
          bool is_secondary = false;
          if (slot >= 0 && slot < 8)
          {
            for (int i = 0; i < component_idx; i++)
            {
              if (i != 0 && id(component_to_slot)[i] == slot)
              {
                is_secondary = true;
                break;
              }
            }
          }
          
          // Get layout type
          std::string layout = id(slot_layout_types)[slot];
          bool is_paired = (layout == "pair-vertical" || layout == "pair-horizontal");
          
          // Update LVGL widgets
          auto call = id(lvgl_component).get_object(slot);  // Get container
          if (call != nullptr)
          {
            // Get image widgets
            lv_obj_t* primary = lv_obj_get_child(call, 0);
            lv_obj_t* secondary = lv_obj_get_child(call, 1);
            
            if (!is_secondary)
            {
              // Update primary image
              lv_img_set_src(primary, id(online_image_0)->get_lv_img_dsc());
              
              // Adjust width based on layout
              if (is_paired)
              {
                int pair_width = id(slot_image_widths)[slot];
                lv_obj_set_width(primary, pair_width);
                lv_obj_set_height(primary, id(slot_image_heights)[slot]);
                
                // Show secondary slot
                lv_obj_clear_flag(secondary, LV_OBJ_FLAG_HIDDEN);
              }
              else
              {
                // Single layout - use full width
                lv_obj_set_width(primary, ${screenwidth});
                lv_obj_set_height(primary, ${screenheight});
                
                // Hide secondary slot
                lv_obj_add_flag(secondary, LV_OBJ_FLAG_HIDDEN);
              }
            }
            else
            {
              // Update secondary image (only for paired layouts)
              lv_img_set_src(secondary, id(online_image_0)->get_lv_img_dsc());
              lv_obj_set_width(secondary, id(slot_image_widths)[slot]);
              lv_obj_set_height(secondary, id(slot_image_heights)[slot]);
            }
          }
          
          id(image_slot_success)[slot] = true;
          id(image_slot_loading)[slot] = false;
```

---

### 6. Add Dynamic Resize Method

The `online_image` component in ESPHome doesn't expose `set_resize_width()` directly. Instead, update dimensions before calling `set_url()`:

**Alternative approach:** Create variants with fixed dimensions or use substitutions.

For kitchen-display with 4px divider:
- Single layout: 1024×600
- Pair layout: 508×600 per image (508 = (1024 - 8) / 2)

**Simplified approach:**
1. Backend generates two resize variants: full-size and half-size
2. ESPHome loads appropriate variant based on `layoutType` in queue
3. LVGL containers adjust visibility and layout

---

### 7. Test Plan

#### Phase 1: Backend Testing
```bash
cd slideshow-backend
deno task dev

# Test device registration
curl http://localhost:8000/api/devices/kitchen-display

# Verify layouts field is present
```

#### Phase 2: Image Reprocessing
```bash
# Trigger reprocessing to generate pair-* variants
# Backend should detect missing variants and create processing jobs
```

#### Phase 3: Queue Testing
```bash
# Test queue generation
curl http://localhost:8000/api/devices/kitchen-display/slideshow

# Verify response includes layoutType, variantDimensions, isPaired
```

#### Phase 4: ESPHome Integration
```bash
cd esphome-devices
esphome compile Guition_P4_7.0.yaml
esphome upload Guition_P4_7.0.yaml

# Monitor logs
esphome logs Guition_P4_7.0.yaml
```

---

## Troubleshooting

### Issue: Images not loading
- Check `online_image` component logs for download errors
- Verify API URLs are correct in queue fetch response
- Check network connectivity

### Issue: Wrong dimensions
- Verify `variantDimensions` in queue response
- Check `slot_image_widths` and `slot_image_heights` globals
- Ensure processor generated variants with correct `layout_type`

### Issue: Secondary images not showing
- Verify `isPaired` flag in queue response
- Check LVGL widget visibility flags
- Ensure component_to_slot mapping includes secondary slots

### Issue: Color theme not applying
- Check `colorPalette` parsing in fetch script
- Verify `slot_source_colors` map population
- Ensure Material Theme component receives color data

---

## Future Enhancements

1. **Horizontal pairing**: Add support for `pair-horizontal` layout (top/bottom split)
2. **Triple/quad layouts**: Support more than 2 images per container
3. **Dynamic divider width**: Allow per-device divider configuration
4. **Smooth transitions**: Add crossfade animations between layouts
5. **Aspect ratio preservation**: Add letterboxing option instead of crop
6. **Manual override**: Allow user to force layout type via Home Assistant

---

## References

- Backend schema: `slideshow-backend/src/db/schema.ts`
- Layout logic: `slideshow-backend/src/services/image-layout.ts`
- Queue generation: `slideshow-backend/src/services/slideshow-queue.ts`
- Processor: `slideshow-processor/processor-v2.ts`
- ESPHome config: `esphome-devices/Guition_P4_7.0.yaml`
- LVGL widgets: `esphome-devices/hw/lvgl.yaml`
- Scripts: `esphome-devices/core/code.yaml`
