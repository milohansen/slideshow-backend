import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { listBlobs, listUnanalyzedBlobs, updateBlob } from "../db/helpers-firestore";
import { FieldValue } from "@google-cloud/firestore";

export async function generateImageAnalysis(hash: string, fileUri: string, skipBlobUpdate: boolean = false): Promise<AIAnalysis | undefined> {
  const ai = new GoogleGenAI({
    vertexai: false,
    apiKey: process.env.GEMINI_API_KEY,
  });

  const contents = createUserContent([
    //     `Role: You are a precision object detection system designed to isolate the single primary subject of an image.

    // Task: Analyze the image and output a JSON object with keys: title, description, and focal_points.

    // Strict Subject Logic (Read Carefully):
    // 1. Check for Living Subjects: Scan for people or animals.
    //   - IF FOUND: These are the ONLY allowed focal_points. You must discard all other elements (mountains, sky, flowers, paths, buildings), no matter how prominent or beautiful they are.
    //   - IF NOT FOUND: Identify the single most prominent inanimate object (e.g., a specific car, a lone tree, a vase).

    // Constraint Checklist:
    // - NO "Whole Image" Labels: Never create a bounding box that encompasses the entire image (e.g., [0,0,1,1]) or label the image as "Landscape," "Scenery," or "View."
    // - NO Environment: Do not list "Sky," "Ground," "Grass," "Walls," or "Floor."
    // - NO Parts: Do not list body parts (eyes, hands) or accessories (backpacks, hats) as separate entries. They are part of the "Subject."

    // Output Format:
    // \`\`\`json
    // {
    //   "title": "String (2-9 words)",
    //   "description": "String (Short paragraph)",
    //   "focal_points": [
    //     {
    //       "label": "String (e.g., 'Hiker', 'Dog')",
    //       "score": Number (1-10),
    //       "box_2d": [x, y, w, h]  // Normalized (0-1)
    //     }
    //   ]
    // }
    // \`\`\``,
    createPartFromUri(fileUri, "image/jpeg"),
  ]);

  try {
    // console.log("fileUri:", fileUri);
    const response = await ai.models.generateContent({
      model: "gemini-flash-latest",
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            image_analysis: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "A concise title (2-9 words) capturing the essence of the image.",
                },
                description: {
                  type: "string",
                  description: "A concise, normalized description of the scene content.",
                },
                mood: {
                  type: "string",
                  description: "The emotional tone (e.g., Joyful, Serene, Melancholic).",
                },
                time_of_day: {
                  type: "string",
                  description: "Estimated time (e.g., Golden Hour, Mid-day, Artificial).",
                },
                composition: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      description: "Compositional style (e.g., Rule of Thirds, Center Weighted).",
                    },
                    clutter_score: {
                      type: "number",
                      description: "Float 0.0 (Minimalist) to 1.0 (Chaotic).",
                    },
                  },
                  required: ["type", "clutter_score"],
                  propertyOrdering: ["type", "clutter_score"],
                },
                colors: {
                  type: "object",
                  properties: {
                    dominant_hex: {
                      type: "array",
                      description: "List of dominant hex color codes.",
                      items: {
                        type: "string",
                      },
                    },
                    accent_hex: {
                      type: "array",
                      description: "List of accent hex color codes.",
                      items: {
                        type: "string",
                      },
                    },
                  },
                  required: ["dominant_hex", "accent_hex"],
                  propertyOrdering: ["dominant_hex", "accent_hex"],
                },
              },
              required: ["title", "description", "mood", "time_of_day", "composition", "colors"],
              propertyOrdering: ["title", "description", "mood", "time_of_day", "composition", "colors"],
            },
            directionality: {
              type: "object",
              properties: {
                score: {
                  type: "number",
                  description: "-1.0 (Left Flow) to 1.0 (Right Flow). 0.0 is Static/Head-on.",
                },
                reasoning: {
                  type: "string",
                  description: "Brief explanation for the score.",
                },
              },
              required: ["score", "reasoning"],
              propertyOrdering: ["score", "reasoning"],
            },
            identities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["Person", "Pet", "Other"],
                  },
                  demographics: {
                    type: "string",
                    description: "e.g., 'Adult Male', 'Senior Female'.",
                  },
                  facial_structure: {
                    type: "object",
                    properties: {
                      face_shape: {
                        type: "string",
                        description: "e.g. Oval, Square, Heart, Round, Long.",
                      },
                      complexion_description: {
                        type: "string",
                        description: "Visual description of skin tone/undertone. e.g. 'Fair warm', 'Olive', 'Deep cool'.",
                      },
                      eye_characteristics: {
                        type: "string",
                        description: "Shape and set. e.g. 'Round', 'Almond', 'Hooded', 'Deep-set'.",
                      },
                      nose_structure: {
                        type: "string",
                        description: "e.g. 'Straight', 'Button', 'Aquiline/Hooked', 'Wide'.",
                      },
                      cheek_chin_structure: {
                        type: "string",
                        description: "e.g. 'High cheekbones', 'Soft jawline', 'Pointed chin', 'Square jaw'.",
                      },
                    },
                    required: ["face_shape", "complexion_description", "eye_characteristics", "nose_structure"],
                    propertyOrdering: ["face_shape", "complexion_description", "eye_characteristics", "nose_structure", "cheek_chin_structure"],
                  },
                  transient_features: {
                    type: "object",
                    properties: {
                      hair_style: {
                        type: "string",
                      },
                      eyewear: {
                        type: "string",
                      },
                      facial_hair: {
                        type: "string",
                      },
                    },
                    propertyOrdering: ["hair_style", "eyewear", "facial_hair"],
                  },
                },
                required: ["type", "demographics", "facial_structure", "transient_features"],
                propertyOrdering: ["type", "demographics", "facial_structure", "transient_features"],
              },
            },
            smart_crop: {
              type: "object",
              properties: {
                regions_of_interest: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "Feature name (e.g., Left Eye, Face).",
                      },
                      box_2d: {
                        type: "array",
                        description: "[ymin, xmin, ymax, xmax] normalized 0.0-1.0.",
                        items: {
                          type: "number",
                        },
                      },
                      importance_rank: {
                        type: "integer",
                        description: "1 = Highest Priority (Eyes/Focal Point), 2 = Head, 3 = Body.",
                      },
                      saliency_score: {
                        type: "number",
                        description: "0.0 to 1.0 relevance score.",
                      },
                    },
                    required: ["label", "box_2d", "importance_rank", "saliency_score"],
                    propertyOrdering: ["label", "box_2d", "importance_rank", "saliency_score"],
                  },
                },
              },
              required: ["regions_of_interest"],
              propertyOrdering: ["regions_of_interest"],
            },
          },
          required: ["image_analysis", "directionality", "identities", "smart_crop"],
          propertyOrdering: ["image_analysis", "directionality", "identities", "smart_crop"],
        },
        candidateCount: 1,
        systemInstruction: `You are an expert computer vision aesthetic analysis engine. Your job is to analyze images for a smart display slideshow backend.

**Analysis Guidelines:**

1.  **Smart Crop Hierarchy:**
    * Do not just identify objects; identify the *hierarchy* of focus.
    * **Rank 1 (Critical):** The absolute focal point. For humans/animals, this is the Eyes. For landscapes, the peak or specific flower.
    * **Rank 2 (High):** The "Head" or primary subject boundary.
    * **Rank 3 (Medium):** The "Upper Body" or immediate context.
    * **Rank 5 (Low):** The full environmental context.
    * *Coordinates:* Must be normalized [ymin, xmin, ymax, xmax] relative to the image dimensions (0.0 to 1.0).

2.  **Directionality Scoring:**
    * Assess the visual flow or gaze of the subject.
    * **-1.0:** Subject is moving or looking strongly to the LEFT.
    * **-0.5:** Subject is facing forward but looking Left.
    * **0.0:** Subject is head-on, static, or symmetrical.
    * **0.5:** Subject is facing forward but looking Right.
    * **1.0:** Subject is moving or looking strongly to the RIGHT.

3.  **Facial Geometry & Bone Structure:**
    * When analyzing people, prioritize **permanent structural features** over changeable ones.
    * **Face Shape:** Look for the silhouette (Oval, Square, Heart).
    * **Eyes/Nose:** Describe the physical shape (e.g., "Hooded eyes," "Aquiline nose") rather than expression.
    * **Complexion:** Use descriptive visual terms for skin tone (e.g., "Olive," "Fair warm," "Deep cool").
    * **Transient:** Put hair, glasses, and beards in the \`transient_features\` object, as these change over time.

4.  **Composition & Color:**
    * Provide normalized descriptions and hex codes to assist with pairing images.`,
      },
      contents,
    });

    try {
      // console.log("AI Response Text:", response.text);
      const jsonResponse: AIAnalysis = JSON.parse(response.text);
      // console.log("Parsed JSON Response:", jsonResponse);
      if (!skipBlobUpdate) {
        await updateBlob(hash, { title: jsonResponse.image_analysis.title, description: jsonResponse.image_analysis.description, analysis: jsonResponse, analyzed_at: new Date().toISOString() });
      }
      return jsonResponse;
    } catch (error) {
      console.log("Failed to parse AI response as JSON:", error, response.text);
      return undefined;
    }
  } catch (error) {
    console.error("Error during AI content generation:", error);
    return undefined;
  }
}

export type AIAnalysis = {
  image_analysis: ImageAnalysis;
  directionality: {
    score: number;
    reasoning: string;
  };
  identities: Identity[];
  smart_crop: {
    regions_of_interest: RegionOfInterest[];
  };
};
export type ImageAnalysis = {
  title: string;
  description: string;
  mood: string;
  time_of_day: string;
  composition: {
    type: string;
    clutter_score: number;
  };
  colors: {
    dominant_hex: string[];
    accent_hex: string[];
  };
};
export type Identity = {
  type: "Person" | "Pet" | "Other";
  demographics: string;
  facial_structure: {
    face_shape: string;
    complexion_description: string;
    eye_characteristics: string;
    nose_structure: string;
    cheek_chin_structure?: string;
  };
  transient_features: {
    hair_style?: string;
    eyewear?: string;
    facial_hair?: string;
  };
};
export type RegionOfInterest = {
  label: string;
  box_2d: [number, number, number, number];
  importance_rank: number;
  saliency_score: number;
};

export async function analyzeAllUnanalyzedImages() {
  const unanalyzedBlobs = await listUnanalyzedBlobs();
  console.log(`Found ${unanalyzedBlobs.length} unanalyzed blobs.`);
  for (const blob of unanalyzedBlobs) {
    try {
      console.log(`Analyzing blob ${blob.hash}...`);
      await generateImageAnalysis(blob.hash, blob.storage_path.replace("gs://", "https://storage.googleapis.com/"));
      console.log(`Successfully analyzed blob ${blob.hash}.`);
    } catch (error) {
      console.error(`Failed to analyze blob ${blob.hash}:`, error);
    }
  }
  // Implementation to fetch all blobs without analyzed_at and run generateImageAnalysis on them
}
export async function reanalyzeAllImages() {
  const blobs = await listBlobs();
  console.log(`Found ${blobs.length} blobs.`);
  for (const blob of blobs) {
    if ("analysis" in blob && blob.analysis) {
      console.log(`Skipping already analyzed blob ${blob.hash}.`);
      continue;
    }
    try {
      await updateBlob(blob.hash, { focal_points: FieldValue.delete() } as any);
    } catch (error) {
      console.log(`No focal_points to delete for blob ${blob.hash}.`);
    }
    try {
      console.log(`Analyzing blob ${blob.hash}...`);
      await generateImageAnalysis(blob.hash, blob.storage_path.replace("gs://", "https://storage.googleapis.com/"));
      console.log(`Successfully analyzed blob ${blob.hash}.`);
    } catch (error) {
      console.error(`Failed to analyze blob ${blob.hash}:`, error);
    }
  }
  // Implementation to fetch all blobs without analyzed_at and run generateImageAnalysis on them
}
