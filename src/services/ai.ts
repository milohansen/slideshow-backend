import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { listUnanalyzedBlobs, updateBlob } from "../db/helpers-firestore";

export async function generateImageAnalysis(hash: string, fileUri: string, skipBlobUpdate: boolean = false): Promise<ResponseSchema | undefined> {
  const ai = new GoogleGenAI({
    vertexai: false,
    apiKey: process.env.GEMINI_API_KEY,
  });

  const contents = createUserContent([
    `Role: You are a precision object detection system designed to isolate the single primary subject of an image.

Task: Analyze the image and output a JSON object with keys: title, description, and focal_points.

Strict Subject Logic (Read Carefully):
1. Check for Living Subjects: Scan for people or animals.
  - IF FOUND: These are the ONLY allowed focal_points. You must discard all other elements (mountains, sky, flowers, paths, buildings), no matter how prominent or beautiful they are.
  - IF NOT FOUND: Identify the single most prominent inanimate object (e.g., a specific car, a lone tree, a vase).

Constraint Checklist:
- NO "Whole Image" Labels: Never create a bounding box that encompasses the entire image (e.g., [0,0,1,1]) or label the image as "Landscape," "Scenery," or "View."
- NO Environment: Do not list "Sky," "Ground," "Grass," "Walls," or "Floor."
- NO Parts: Do not list body parts (eyes, hands) or accessories (backpacks, hats) as separate entries. They are part of the "Subject."

Output Format:
\`\`\`json
{
  "title": "String (2-7 words)",
  "description": "String (Short paragraph)",
  "focal_points": [
    {
      "label": "String (e.g., 'Hiker', 'Dog')",
      "score": Number (1-10),
      "box_2d": [x, y, w, h]  // Normalized (0-1)
    }
  ]
}
\`\`\``,
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
            title: {
              type: "string",
              description: "A concise title (2-7 words) capturing the essence of the image.",
            },
            description: {
              type: "string",
              description: "A short paragraph summarizing the scene.",
            },
            focal_points: {
              type: "array",
              description: "A list of the primary subject(s) only.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "The name of the object (e.g., 'Hiker', 'Dog').",
                  },
                  score: {
                    type: "number",
                    description: "Interest score between 1-10.",
                    minimum: 1,
                    maximum: 10,
                  },
                  box_2d: {
                    type: "array",
                    description: "Normalized bounding box [x, y, width, height].",
                    minItems: 4,
                    maxItems: 4,
                    items: {
                      type: "number",
                      minimum: 0,
                      maximum: 1,
                    },
                  },
                },
                required: ["label", "score", "box_2d"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "description", "focal_points"],
          additionalProperties: false,
        },
      },
      contents,
    });

    try {
      // console.log("AI Response Text:", response.text);
      const jsonResponse: ResponseSchema = JSON.parse(response.text);
      // console.log("Parsed JSON Response:", jsonResponse);
      if (!skipBlobUpdate) {
        await updateBlob(hash, { ...jsonResponse, analyzed_at: new Date().toISOString() });
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

type ResponseSchema = {
  title: string;
  description: string;
  focal_points: FocalPoint[];
};
export type FocalPoint = {
  label: string;
  score: number;
  box_2d: [number, number, number, number];
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
