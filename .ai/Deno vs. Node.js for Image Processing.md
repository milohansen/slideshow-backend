# **Architectural Analysis of Deno Runtime and Cloud Run Jobs for High-Throughput Image Processing Pipelines**

## **1\. Introduction**

The evolution of server-side JavaScript has transitioned from a single-threaded curiosity to a dominant force in cloud-native architectures. For developers engaging in personal projects with specific "burst" capacity requirements—such as processing batch uploads of photography, organizing archives, or generating dynamic assets—the architectural choices regarding runtime environments and cloud infrastructure are critical. The decision landscape, once monopolized by Node.js and virtual machines, now includes modern runtimes like Deno and specialized serverless execution models like Google Cloud Run Jobs. This report provides an exhaustive, expert-level analysis of utilizing Deno as the primary execution environment for a personal image processing pipeline, specifically evaluating its performance, security, and maintainability against the established Node.js standard. Furthermore, it rigorously assesses the suitability of Google Cloud Run Jobs for handling batch workloads of approximately 200 images, contrasting this approach with request-based services and alternative compute models.

The analysis synthesizes data regarding the interoperability of high-performance libraries such as sharp and @material/material-color-utilities, the mathematical implications of image resampling algorithms, and the economic efficiency of serverless concurrency. By dissecting the internal mechanisms of V8-based runtimes and the orchestration logic of containerized batch processes, this document aims to validate the hypothesis that a Deno-on-Cloud-Run architecture represents the optimal intersection of developer velocity, performance, and cost-efficiency for the specified workload.

## ---

**2\. Runtime Architecture: The Deno vs. Node.js Paradigm**

The selection of a runtime environment is not merely a syntactic choice but a foundational architectural decision that dictates the security posture, dependency management strategy, and long-term maintainability of the application. While both Node.js and Deno share the underlying V8 JavaScript engine developed by Google, their divergence in design philosophy creates distinct operational profiles for image processing tasks.

### **2.1 The Legacy of Node.js and the Architecture of Regret**

Node.js, introduced in 2009, revolutionized backend development by unifying the language of the browser and the server. However, its architecture reflects the constraints and assumptions of that era. Ryan Dahl, the creator of both Node.js and Deno, has publicly articulated inherent design flaws in Node.js that complicate modern development—flaws that are particularly relevant when building a system designed to process untrusted binary data like images.

One primary structural liability in Node.js is the node\_modules dependency resolution algorithm. In a standard Node.js project, dependencies are installed locally in a recursive directory structure. For a project relying on heavy libraries like sharp (which includes binary bindings to libvips), this results in a significantly bloated project footprint.1 When deploying to a containerized environment like Cloud Run, this bloat translates directly to larger container image sizes, longer build times, and increased cold-start latencies as the I/O subsystem reads thousands of small files during the boot sequence. Furthermore, the CommonJS module system, characterized by the synchronous require() function, presents interoperability challenges with the modern ECMAScript Module (ESM) standard used by contemporary libraries and browser-compatible code. While Node.js has retrofitted ESM support, the dual-mode ecosystem often leads to "module hell," where developers must navigate complex configuration flags to ensure interoperability between CommonJS and ESM packages.2

### **2.2 Deno: A Modern Runtime for Secure Computing**

Deno was engineered to address these structural inefficiencies. It is built on Rust and the Tokio asynchronous runtime, offering a fundamentally different approach to system interaction. For a personal image processing pipeline, Deno’s advantages manifest in three specific areas: security, tooling, and dependency management.

#### **2.2.1 The Capability-Based Security Model**

Image processing libraries are historically significant vectors for security vulnerabilities. Libraries like ImageMagick and libvips parse complex binary headers; malformed images can trigger buffer overflows or remote code execution (RCE) exploits. In the Node.js model, the runtime is trusted by default. A script executing sharp has inherent access to the entire filesystem, environment variables, and network interfaces. If a dependency in the supply chain were compromised, it could exfiltrate sensitive data (such as Cloud Storage credentials) without the developer's knowledge.1

Deno inverts this model by implementing a capability-based security sandbox. By default, a Deno process has no access to the disk, network, or environment. The developer must explicitly grant permissions via command-line flags. For the proposed image processing pipeline, the execution signature would look like this:

Bash

deno run \--allow-read=./input \--allow-write=./output \--allow-env \--allow-net=storage.googleapis.com main.ts

This granular control ensures that even if a vulnerability exists within the image processing logic, the process is cryptographically restricted from accessing unrelated files (like SSH keys) or communicating with unauthorized domains. For a personal project where security auditing bandwidth is limited, this "secure by default" posture provides a critical safety net.1

#### **2.2.2 The "Batteries-Included" Developer Experience**

The user's constraint of "personal use" implies a need for low maintenance overhead. Node.js projects typically require a complex scaffolding of auxiliary tools: prettier for formatting, eslint for linting, jest or vitest for testing, and tsc for TypeScript compilation. Managing the configuration files (tsconfig.json, .eslintrc, .prettierrc, jest.config.js) introduces significant friction and "configuration drift" over time.

Deno eliminates this toolchain fatigue by embedding these utilities directly into the binary. The TypeScript compiler is native to Deno; it treats .ts files as first-class citizens, compiling them on the fly using a highly optimized caching layer implemented in Rust.4 This means the developer can write a TypeScript script to process images and execute it immediately with deno run, without configuring a build pipeline. For a burst-capacity tool that might be updated sporadically, the removal of build-step fragility is a substantial advantage.

### **2.3 Dependency Management and the NPM Bridge**

Historically, the primary argument against Deno was its incompatibility with the vast npm ecosystem. Early versions of Deno required dependencies to be imported via URLs (e.g., import { serve } from "https://deno.land/std/http/server.ts"), which severed access to millions of Node.js packages. However, with the release of Deno 2.x, this limitation has been comprehensively resolved through native npm support.

#### **2.3.1 The npm: Specifier and Compatibility Layer**

Deno now supports the npm: specifier, allowing developers to import packages directly from the npm registry. This is not merely a syntactic sugar but a deep integration. When Deno encounters import sharp from "npm:sharp";, it downloads the package, resolves its dependencies, and crucially, sets up a Node-API (formerly N-API) compatibility layer.2

This compatibility layer is vital for sharp. sharp relies on native C++ bindings to interact with libvips. Deno's implementation of the Node-API ABI (Application Binary Interface) allows it to load these native addons seamlessly. The runtime emulates the necessary Node.js globals (like process and Buffer) and module resolution strategies (like finding the correct binary for the operating system), enabling sharp to function with performance parity to Node.js.7 This breakthrough nullifies the strongest argument for staying with Node.js, as Deno can now leverage the industry-standard image processing library while retaining its own architectural benefits.

#### **2.3.2 Global Caching vs. Local Installation**

Unlike Node.js, which duplicates dependencies in every project's node\_modules folder, Deno utilizes a global cache similar to Go or Maven. This reduces disk usage and accelerates project initialization. However, for compatibility with certain tooling or deployment patterns that expect a local directory, Deno 2 allows for a local node\_modules generation via the "nodeModulesDir": "auto" configuration in deno.json. This hybrid approach offers the flexibility to optimize for container build context—caching layers in Docker—while maintaining a clean development environment.6

### **2.4 Performance Benchmarking: V8 vs. V8**

Since both runtimes utilize the V8 engine, raw JavaScript execution speed is comparable. Differences emerge in I/O handling and startup time. Deno's use of Tokio (Rust) for its event loop typically yields marginal gains in asynchronous I/O throughput compared to Node's libuv (C). However, for image processing, the bottleneck is CPU-bound (pixel manipulation) rather than I/O-bound. Therefore, the choice of library (sharp vs. others) impacts performance far more than the choice of runtime. The "cost" of Deno's TypeScript compilation is mitigated by V8 code caching; subsequent runs of a script are near-instantaneous. For Cloud Run Jobs, which are ephemeral, Deno's fast startup time (once cached) contributes to lower billable durations.1

**Comparative Summary Table: Deno vs. Node.js**

| Feature | Node.js | Deno | Impact on Image Processing Pipeline |
| :---- | :---- | :---- | :---- |
| **Security** | Open access (Trusted) | Sandbox (Secure by Default) | **High:** Mitigates risk of exploits in image parsers. |
| **TypeScript** | External Compiler (tsc) | Native / Built-in | **High:** Reduces maintenance of build configs. |
| **Dependencies** | node\_modules (Local) | Global Cache / npm: | **Medium:** Deno 2 supports sharp via npm. |
| **Module System** | CommonJS / ESM | ESM (Standard) | **Medium:** Future-proof code structure. |
| **Configuration** | package.json \+ tsconfig | deno.json | **High:** Simplified project setup. |
| **Native Bindings** | Native support (Node-API) | Compatibility Layer | **Neutral:** Both support sharp effectively. |

## ---

**3\. Image Processing Strategy and Library Selection**

The efficacy of the pipeline relies heavily on the choice of image manipulation libraries. The requirement involves processing \~200 images at a time, likely resizing them and extracting color palettes. This demands a library that balances speed, memory efficiency, and algorithmic quality.

### **3.1 The Dominance of sharp and libvips**

sharp is widely recognized as the preeminent image processing library in the JavaScript ecosystem. Its performance advantage stems from its underlying engine, libvips. Unlike ImageMagick or pure JavaScript libraries that load the entire image bitmap into memory (a "DOM-like" approach), libvips is a demand-driven, streaming library. It constructs a pipeline of operations and executes them in small chunks, utilizing the L2/L3 CPU cache efficiently.9

#### **3.1.1 Performance Metrics**

Research indicates that sharp is typically 4x-5x faster than ImageMagick and consumes significantly less memory. For a batch of 200 images processed in a cloud environment where memory (RAM) is a billable resource, this efficiency is paramount. A pure JavaScript library might require loading a 50MB image entirely into the V8 heap, potentially triggering garbage collection pauses or Out-Of-Memory (OOM) crashes on smaller instances. sharp, by keeping the data in native buffers and processing it in streams, avoids this V8 heap pressure.10

#### **3.1.2 Algorithmic Quality: The Lanczos3 Kernel**

The user's implicit need for "processing" typically involves downscaling images for web display. The choice of resampling algorithm drastically affects output quality.

* **Nearest Neighbor:** Fast but produces blocky, pixelated artifacts.  
* **Bilinear:** Smoother but blurs edges significantly.  
* **Bicubic:** A standard compromise, utilizing a 4x4 pixel grid for interpolation.  
* **Lanczos3:** A convolution filter based on the windowed sinc function. It considers a 3-lobe window, preserving high-frequency details (sharpness) while minimizing aliasing (moiré patterns).

sharp defaults to the **Lanczos3** kernel for image reduction. Pure JavaScript libraries often default to simpler algorithms like Bilinear to conserve CPU cycles, resulting in inferior visual quality. For a personal archive, retaining visual fidelity is likely a priority, making sharp's default behavior advantageous.12

### **3.2 Evaluating ImageScript: The Deno-Native Alternative**

ImageScript is a notable alternative designed specifically for Deno, utilizing WebAssembly (WASM) to run performant image operations without system dependencies.

* **Pros:** It is truly portable. It runs anywhere Deno runs without requiring the Node-API compatibility layer or specific OS-level libraries.  
* **Cons:** While faster than interpreted JS, WASM implementations currently struggle to match the SIMD (Single Instruction, Multiple Data) optimizations available to native C++ libraries like libvips. Benchmarks generally show ImageScript lagging behind sharp in raw throughput for heavy resizing tasks. Furthermore, documentation does not explicitly confirm support for advanced resampling kernels like Lanczos3, suggesting a reliance on standard algorithms that may yield lower perceptual quality.15

**Verdict:** Given Deno 2's robust support for npm:sharp, the portability benefits of ImageScript do not outweigh the performance and quality penalties. sharp remains the superior choice for this workload.

### **3.3 Color Science: Integrating Material Color Utilities**

The requirement to "extract colors" points to the use of @material/material-color-utilities, a library that implements the Material You (Material Design 3\) dynamic color algorithms. This library introduces a specific technical challenge: interoperability between image buffers and algorithmic input formats.

#### **3.3.1 The HCT Color Space and Quantization**

The Material library uses the **HCT** (Hue, Chroma, Tone) color space, which is perceptually accurate compared to standard HSL. It employs a quantization algorithm (typically a variation of K-Means or Wu's algorithm, specifically QuantizerCelebi) to cluster the thousands of distinct colors in an image into a set of dominant "seed" colors.18

#### **3.3.2 The Data Bridge Challenge**

The QuantizerCelebi.quantize() function requires an input array of pixels represented as **ARGB** integers (Int32). However, sharp typically outputs a Node.js Buffer or Uint8Array containing **RGBA** channels.

* **The Conversion:** A direct bitwise conversion is necessary. The pipeline must iterate through the Uint8Array from sharp, extracting R, G, B, and A values, and packing them into a 32-bit integer: (alpha \<\< 24\) | (red \<\< 16\) | (green \<\< 8\) | blue.  
* **Performance Optimization:** Running this loop in JavaScript for a 12-megapixel image (12 million pixels) is computationally expensive and slow. A critical optimization is to resize the image to a smaller proxy dimension (e.g., 128x128 pixels) *before* quantization. This reduces the pixel count to \~16,000, making the JavaScript conversion instantaneous while still providing sufficient data for the quantization algorithm to identify dominant colors accurately. This "proxy image" technique is a standard pattern in color extraction pipelines.20

## ---

**4\. Cloud Infrastructure: The Case for Cloud Run Jobs**

The user explicitly asks, "Are cloud run jobs the best place to run this processing?" To answer this, we must evaluate the operational characteristics of Cloud Run Jobs against Cloud Run Services and other compute models (Functions, GKE).

### **4.1 The Limits of Request-Based Services**

Cloud Run Services are designed for synchronous HTTP request/response cycles. They utilize an autoscaler (Knative) that spins up instances based on incoming traffic.

* **The Timeout Constraints:** Services enforce a strict request timeout (default 5 minutes, max 60 minutes). If the processing of a batch of 200 images is triggered by a single HTTP request, the client must keep the connection open for the duration. If the process exceeds the timeout, the connection is severed, and the container receives a SIGTERM signal, potentially leaving the batch in a corrupted, half-finished state.21  
* **CPU Throttling:** Crucially, Cloud Run Services throttle the CPU allocated to a container to nearly zero when it is not actively processing a request. This makes background processing (e.g., "fire and forget") unreliable unless the expensive "CPU always allocated" flag is enabled. This architecture is ill-suited for batch work where the processing time is decoupled from the HTTP response.22

### **4.2 Cloud Run Jobs: The "Run-to-Completion" Model**

Cloud Run Jobs adopt a batch execution model. A job is triggered, a container spins up, executes a command, and shuts down upon exit. This model aligns perfectly with the user's requirements for several reasons.

#### **4.2.1 Deterministic Execution and Timeouts**

Jobs do not listen for HTTP requests and are not subject to HTTP timeout limits. A job execution can run for up to 24 hours.24 This guarantees that even if the 200 images are high-resolution TIFFs requiring complex processing, the system will not time out arbitrarily.

#### **4.2.2 The "Array Job" Parallelism**

The most compelling feature for this workload is **Array Jobs**. Cloud Run Jobs allows the user to specify a tasks parameter (e.g., \--tasks 10). This instructs the infrastructure to spin up 10 independent container instances simultaneously.

* **Sharding Strategy:** The Cloud Run control plane injects two environment variables into each container: CLOUD\_RUN\_TASK\_INDEX (the instance ID, 0-9) and CLOUD\_RUN\_TASK\_COUNT (total tasks, 10).  
* **Implementation:** The code can use these variables to "shard" the workload. If there are 200 images in the bucket, Task 0 processes images 0-19, Task 1 processes 20-39, and so on.  
* **Throughput Implication:** This reduces the wall-clock time for the batch by a factor of 10\. Instead of waiting 10 minutes for sequential processing, the user waits 1 minute for parallel processing. This drastic improvement in user experience comes with zero additional code complexity regarding async queues or worker pools.24

#### **4.2.3 Reliability and Retries**

In a batch of 200 images, it is statistically probable that one file might be corrupted or malformed, causing the process to crash.

* **Service Model:** A crash in a service handling multiple requests might terminate the container, causing 50 other concurrent requests to fail (the "noisy neighbor" problem).  
* **Job Model:** If Task 3 crashes, Cloud Run Jobs can be configured to retry *only* Task 3 automatically (--max-retries). The other 9 tasks continue unaffected. This fault isolation is critical for robust batch processing.26

### **4.3 Cost Analysis: The Economics of Burst Processing**

Cloud Run (both Services and Jobs) bills for vCPU-seconds and memory-seconds used.

* **Cost Neutrality of Parallelism:** Google bills for the aggregate resource usage. Processing 200 images sequentially on 1 CPU for 1000 seconds costs exactly the same as processing them on 10 CPUs for 100 seconds (ignoring minor cold start overhead).  
  * *Calculation:* 1000 vCPU-seconds vs. (10 \* 100\) vCPU-seconds.  
* **The Free Tier:** Google Cloud offers a generous free tier of 180,000 vCPU-seconds and 360,000 GiB-seconds per month.  
  * *Workload Estimate:* Assuming each image takes 2 seconds to process on 1 vCPU/1GiB RAM.  
  * *Batch Cost:* 200 images \* 2 seconds \= 400 vCPU-seconds per batch.  
  * *Monthly Capacity:* The user could run this batch 450 times per month (400 \* 450 \= 180,000) before incurring *any* compute cost. This confirms that Cloud Run Jobs is not only performant but effectively free for this personal use case.22

### **4.4 Alternatives Considered**

* **AWS Lambda:** While capable, Lambda's 15-minute timeout and complex layers system for managing libvips binaries make it less developer-friendly for this specific container-based workflow.  
* **Google Kubernetes Engine (GKE):** Excessive operational overhead (control plane management) for a simple batch script.  
* **Virtual Machines (Compute Engine):** Requires management of OS patches and manual scaling. Paying for idle time (if the VM is left on) destroys the cost efficiency.

**Conclusion:** Cloud Run Jobs is unequivocally the superior infrastructure choice. It maximizes reliability via run-to-completion semantics, maximizes performance via array job parallelism, and minimizes cost via the serverless billing model.

## ---

**5\. Technical Implementation: The Deno-Cloud Run Pipeline**

Implementing this architecture requires bridging the Deno runtime with the Cloud Run execution environment.

### **5.1 Project Structure and Configuration**

The project utilizes deno.json to manage configuration, specifically enabling the nodeModulesDir setting to ensure compatibility with Cloud Run's file system expectations for native modules.

JSON

// deno.json  
{  
  "tasks": {  
    "start": "deno run \-A main.ts"  
  },  
  "imports": {  
    "sharp": "npm:sharp@^0.33.5",  
    "@material/material-color-utilities": "npm:@material/material-color-utilities@^0.2.7",  
    "@google-cloud/storage": "npm:@google-cloud/storage"  
  },  
  "nodeModulesDir": "auto"  
}

### **5.2 The Core Processing Logic**

The following implementation demonstrates the integration of sharp resizing, raw pixel extraction, bitwise color conversion, and Material color quantization, wrapped in the Cloud Run Jobs sharding logic.

TypeScript

import sharp from "npm:sharp@0.33.5";  
import { QuantizerCelebi, Score } from "npm:@material/material-color-utilities@0.2.7";  
import { Storage } from "npm:@google-cloud/storage";

// 1\. Task Sharding Logic  
// Cloud Run injects these variables for Array Jobs  
const TASK\_INDEX \= parseInt(Deno.env.get("CLOUD\_RUN\_TASK\_INDEX") |

| "0");  
const TASK\_COUNT \= parseInt(Deno.env.get("CLOUD\_RUN\_TASK\_COUNT") |

| "1");

async function main() {  
  const storage \= new Storage();  
  const bucketName \= Deno.env.get("BUCKET\_NAME");  
  if (\!bucketName) throw new Error("BUCKET\_NAME env var required");  
    
  const bucket \= storage.bucket(bucketName);

  // 2\. Fetch File List  
  // Ideally, this list is passed via a manifest file for strict consistency,  
  // but listing the bucket works for smaller sets (\~200 files).  
  const \[files\] \= await bucket.getFiles({ prefix: "input/" });  
    
  // 3\. Shard the Workload  
  // Each task processes only the files where (index % total\_tasks \== task\_index)  
  const myFiles \= files.filter((\_, index) \=\> index % TASK\_COUNT \=== TASK\_INDEX);

  console.log(\`Task ${TASK\_INDEX}/${TASK\_COUNT} processing ${myFiles.length} images.\`);

  for (const file of myFiles) {  
    try {  
      await processImage(file, bucket);  
    } catch (err) {  
      console.error(\`Failed to process ${file.name}:\`, err);  
      // In a real scenario, you might throw here to trigger a Task retry  
    }  
  }  
}

async function processImage(file: any, bucket: any) {  
  const \[buffer\] \= await file.download();

  // 4\. Image Resizing (Lanczos3)  
  // Sharp defaults to Lanczos3 for reductions, ensuring high quality.  
  const pipeline \= sharp(buffer);  
  const resizedBuffer \= await pipeline  
   .resize(800, 800, { fit: "inside" })  
   .toFormat("jpeg", { quality: 80 })  
   .toBuffer();

  // 5\. Color Extraction Strategy  
  // Resize to a small proxy (128x128) to speed up JS loop  
  const { data: rawPixels, info } \= await sharp(buffer)  
   .resize(128, 128, { fit: "cover" })   
   .ensureAlpha()  
   .raw()  
   .toBuffer({ resolveWithObject: true });

  // 6\. Data Conversion: RGBA (Uint8) \-\> ARGB (Int32)  
  const argbPixels \= new Int32Array(info.width \* info.height);  
  const pixelCount \= rawPixels.length / 4;  
    
  for (let i \= 0; i \< pixelCount; i++) {  
    const offset \= i \* 4;  
    const r \= rawPixels\[offset\];  
    const g \= rawPixels\[offset \+ 1\];  
    const b \= rawPixels\[offset \+ 2\];  
    const a \= rawPixels\[offset \+ 3\];  
    // Bitwise shift to pack channels into ARGB integer  
    argbPixels\[i\] \= (a \<\< 24) | (r \<\< 16) | (g \<\< 8) | b;  
  }

  // 7\. Material Quantization  
  const result \= QuantizerCelebi.quantize(argbPixels, 128);  
  const ranked \= Score.score(result);  
  const topColors \= ranked.slice(0, 5).map(c \=\> \`\#${(c & 0xFFFFFF).toString(16).padStart(6, '0')}\`);

  // 8\. Save Output  
  const baseName \= file.name.split("/").pop();  
  await bucket.file(\`output/resized\_${baseName}\`).save(resizedBuffer);  
  await bucket.file(\`output/colors\_${baseName}.json\`).save(JSON.stringify(topColors));  
}

if (import.meta.main) {  
  main();  
}

### **5.3 Optimizing the Docker Container**

The container build process must ensure that the Deno cache is warmed up to minimize startup latency.

Dockerfile

FROM denoland/deno:2.0.0

WORKDIR /app

\# Cache dependencies  
\# Copy config first to leverage Docker layer caching  
COPY deno.json.  
\# Prefetch the dependencies into the global cache  
RUN deno cache npm:sharp npm:@material/material-color-utilities npm:@google-cloud/storage

COPY main.ts.

\# Run with necessary permissions  
CMD \["run", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "main.ts"\]

By explicitly running deno cache, the dependencies are downloaded during the build phase. When Cloud Run starts the container, Deno finds the packages immediately, reducing the "cold start" time to the duration of the V8 isolate spin-up (milliseconds).

## ---

**6\. Strategic Implications and Conclusion**

### **6.1 The "Middle-Tier" Architecture**

The adoption of this architecture signals a shift towards a "middle-tier" computing model. It avoids the heavy operational complexity of persistent servers (VMs) while bypassing the limitations of ephemeral functions (Lambda timeouts). Cloud Run Jobs acts as a "heavyweight ephemeral" environment, democratizing access to high-performance batch computing. It allows a personal developer to wield a compute cluster capable of processing thousands of images in parallel, purely on-demand, and likely within the free tier.

### **6.2 Deno as a Stability Hedge**

Choosing Deno locks the project into a trajectory aligned with web standards. As the JavaScript ecosystem slowly migrates towards ESM and standard Web APIs (like fetch and Crypto), Node.js is playing catch-up. Deno, having started there, offers a codebase that is inherently more "future-proof." The code written for Deno today is closer to the browser standard than typical Node.js code, reducing cognitive load when switching between frontend and backend development.

### **6.3 Final Verdict**

For the specific requirements of processing 200 images with low maintenance and burst capacity:

1. **Runtime:** **Deno (v2.x)** is the superior choice. Its secure default settings align with the risk profile of image processing. Its zero-config TypeScript support drastically improves the "write and run" experience for personal tools. The npm: compatibility layer effectively neutralizes the historical advantage of Node.js regarding the sharp library.  
2. **Infrastructure:** **Cloud Run Jobs** is the optimal execution environment. It provides the necessary robustness against timeouts and enables massive parallelism via Array Jobs, transforming a 10-minute serial task into a 1-minute parallel event without increased cost.  
3. **Library Strategy:** Adhering to **sharp** ensures professional-grade image quality via Lanczos3 resampling. The complexity of integrating with @material/material-color-utilities is managed through efficient resizing proxies and precise bitwise data conversion.

This architecture delivers a solution that is robust, performant, and economically efficient, perfectly tailored to the user's constraints.

#### **Works cited**

1. Deno vs. Node.js: A Detailed Comparison in 2025, accessed January 10, 2026, [https://www.xavor.com/blog/deno-vs-node-js/](https://www.xavor.com/blog/deno-vs-node-js/)  
2. If you're not using npm specifiers, you're doing it wrong | by Deno \- Medium, accessed January 10, 2026, [https://denoland.medium.com/if-youre-not-using-npm-specifiers-you-re-doing-it-wrong-7881afd2906b](https://denoland.medium.com/if-youre-not-using-npm-specifiers-you-re-doing-it-wrong-7881afd2906b)  
3. Deno Vs Node.js: Which One Is Better In 2025? \- DevsData, accessed January 10, 2026, [https://devsdata.com/deno-vs-node-which-one-is-better-in-2025/](https://devsdata.com/deno-vs-node-which-one-is-better-in-2025/)  
4. Deno vs. Node.js vs Bun: Full Comparison Guide | Zero To Mastery, accessed January 10, 2026, [https://zerotomastery.io/blog/deno-vs-node-vs-bun-comparison-guide/](https://zerotomastery.io/blog/deno-vs-node-vs-bun-comparison-guide/)  
5. Benchmarking in Node.js vs Deno: A Comprehensive Comparison \- DEV Community, accessed January 10, 2026, [https://dev.to/frorning/benchmarking-in-nodejs-vs-deno-a-comprehensive-comparison-p1a](https://dev.to/frorning/benchmarking-in-nodejs-vs-deno-a-comprehensive-comparison-p1a)  
6. Node and npm Compatibility \- Deno Docs, accessed January 10, 2026, [https://docs.deno.com/runtime/fundamentals/node/](https://docs.deno.com/runtime/fundamentals/node/)  
7. High performance Node.js image processing | sharp, accessed January 10, 2026, [https://sharp.pixelplumbing.com/](https://sharp.pixelplumbing.com/)  
8. sharp \- npm, accessed January 10, 2026, [https://www.npmjs.com/package/sharp](https://www.npmjs.com/package/sharp)  
9. The libvips image processing library \- University of Southampton, accessed January 10, 2026, [https://www.southampton.ac.uk/\~km2/papers/2025/vips-ist-preprint.pdf](https://www.southampton.ac.uk/~km2/papers/2025/vips-ist-preprint.pdf)  
10. sharp vs canvas vs jimp vs gm | Image Processing Libraries \- NPM Compare, accessed January 10, 2026, [https://npm-compare.com/canvas,gm,jimp,sharp](https://npm-compare.com/canvas,gm,jimp,sharp)  
11. Sharp vs Imagemin for Image Minification in Node.js | BlockQueue Systems Limited, accessed January 10, 2026, [https://blockqueue.io/blog/2024-09-22-sharp-vs-imagemin-comparison](https://blockqueue.io/blog/2024-09-22-sharp-vs-imagemin-comparison)  
12. Lanczos3 algorithm as a way to produce better image downscaling, accessed January 10, 2026, [https://blog.idrsolutions.com/high-quality-image-downscaling-in-java-lanczos3/](https://blog.idrsolutions.com/high-quality-image-downscaling-in-java-lanczos3/)  
13. Resizing images | sharp, accessed January 10, 2026, [https://sharp.pixelplumbing.com/api-resize/](https://sharp.pixelplumbing.com/api-resize/)  
14. Lanczos: A resampling example with in-depth explanations \- GitHub, accessed January 10, 2026, [https://github.com/jeffboody/Lanczos](https://github.com/jeffboody/Lanczos)  
15. matmen/ImageScript: zero-dependency JavaScript image ... \- GitHub, accessed January 10, 2026, [https://github.com/matmen/ImageScript](https://github.com/matmen/ImageScript)  
16. sharp vs canvas vs jimp vs imagescript | Image Processing Libraries \- NPM Compare, accessed January 10, 2026, [https://npm-compare.com/canvas,imagescript,jimp,sharp](https://npm-compare.com/canvas,imagescript,jimp,sharp)  
17. @matmen/imagescript \- JSR, accessed January 10, 2026, [https://jsr.io/@matmen/imagescript](https://jsr.io/@matmen/imagescript)  
18. material-foundation/material-color-utilities: Color libraries for Material You \- GitHub, accessed January 10, 2026, [https://github.com/material-foundation/material-color-utilities](https://github.com/material-foundation/material-color-utilities)  
19. QuantizerCelebi \- MaterialKolor, accessed January 10, 2026, [https://docs.materialkolor.com/material-color-utilities/com.materialkolor.quantize/-quantizer-celebi/index.html](https://docs.materialkolor.com/material-color-utilities/com.materialkolor.quantize/-quantizer-celebi/index.html)  
20. Configuring image quantization quality to optimize performance \#133 \- GitHub, accessed January 10, 2026, [https://github.com/material-foundation/material-color-utilities/issues/133](https://github.com/material-foundation/material-color-utilities/issues/133)  
21. Cloud Run Quotas and Limits \- Google Cloud Documentation, accessed January 10, 2026, [https://docs.cloud.google.com/run/quotas](https://docs.cloud.google.com/run/quotas)  
22. Cloud Run pricing | Google Cloud, accessed January 10, 2026, [https://cloud.google.com/run/pricing](https://cloud.google.com/run/pricing)  
23. Google Cloud Run Pricing in 2025: A Comprehensive Guide \- Cloudchipr, accessed January 10, 2026, [https://cloudchipr.com/blog/cloud-run-pricing](https://cloudchipr.com/blog/cloud-run-pricing)  
24. Getting started with Cloud Run jobs \- Google Codelabs, accessed January 10, 2026, [https://codelabs.developers.google.com/codelabs/cloud-starting-cloudrun-jobs](https://codelabs.developers.google.com/codelabs/cloud-starting-cloudrun-jobs)  
25. How I Solved a Real-World Load Problem Using GCP Cloud Run Jobs | by Abhijith Mengaram \- Medium, accessed January 10, 2026, [https://medium.com/@abhijith.mengaram/scaling-gcp-cloud-run-jobs-a0417587c70f](https://medium.com/@abhijith.mengaram/scaling-gcp-cloud-run-jobs-a0417587c70f)  
26. Create jobs | Cloud Run \- Google Cloud Documentation, accessed January 10, 2026, [https://docs.cloud.google.com/run/docs/create-jobs](https://docs.cloud.google.com/run/docs/create-jobs)  
27. Google Cloud Run Pricing Savings Guide \- Pump, accessed January 10, 2026, [https://www.pump.co/blog/google-cloud-run-pricing](https://www.pump.co/blog/google-cloud-run-pricing)