This project is the backend for showing my personal photos on esphome smart devices. 

The service must be capable of:
 - Retrieving a selection of large images.
   - First pass can get them from a hard coded location (if it's running on my local machine)
   - *Later* Eventually I'd like it to connect with Google Photos and be sent photos through the picker API
  - Processing each image, which involves
    - Resizing down to the correct dimensions for the screen
      - I will have multiple screens so we will need multiple sizes
    - Using material-color-utilities to generate a color (and potentally full color scheme) for each image
    - *Later* Potentially doing some sort of content analysis to inform where to crop or the slideshow ordering.
    - Adding the image to a list or database so it can be shuffled into the slideshows
  - Furthermore, the service will need to handle portrait images and properly pair them together for display.
    - Portrait images should be stored seperately (don't pair on ingestion).
    - The color scheme will need to work with both images and that will probably need to happen when building the slideshow queue.
  - Which leads me to: building slideshow queues:
    - We'll need a queriable list for each device to know which images they need to download.
    - The slideshow should be infinite but not just a basic loop.
  - I think eventually this will need to run in the cloud but I'm not sure which cloud provider will work best.
    - Initial thinking is GCP to sit next to google photos but IDK
    - Regardless of cloud, I think building this as a container makes the most sense

Implementation:
  - Python or Typescript are the languages I'd prefer.
    - If using typescript I'd go for running a Hono app on Deno
    - No preference (or familiarity) with python frameworks