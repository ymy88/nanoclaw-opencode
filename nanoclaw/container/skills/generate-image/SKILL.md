---
name: generate-image
description: Generate an image using Gemini via Vertex AI and send it to the chat. Use when the user asks to create, draw, generate, or make an image/picture/photo/selfie. Supports optional reference images for character consistency, style matching, or image editing.
allowed-tools: Bash(python3:*), mcp__nanoclaw__send_file
---

# Generate Image

You MUST complete BOTH steps. The image is NOT delivered to the user until step 2.

## Step 1: Generate the image

**Text-to-image** (generate from scratch):
```bash
python3 /home/node/.gemini/skills/generate-image/scripts/generate_image.py "detailed prompt here" -o /workspace/group/image.png
```

**With reference image** (use an existing image as input):
```bash
python3 /home/node/.gemini/skills/generate-image/scripts/generate_image.py "prompt describing what to generate" -i /workspace/group/reference.png -o /workspace/group/image.png
```

Use `-i` when:
- The user wants a new image based on an existing character/person (e.g., selfies, new poses, different settings)
- The user provides a reference image for style or content
- The user asks to edit or modify an existing image

## Step 2: Send it to the chat (REQUIRED)

You MUST call the `mcp__nanoclaw__send_file` tool after generating:
- `file_path`: `/workspace/group/image.png`
- `caption`: short description in the user's language

Without step 2, the user will NOT see the image.

## Error: Vertex AI not configured

If the script prints "Vertex AI is not configured", tell the user image generation isn't available yet.

## Prompt tips

- Use detailed, descriptive English prompts for best results
- Add style keywords: "photorealistic", "watercolor", "anime", "oil painting"
- Specify composition: "close-up portrait", "wide landscape", "overhead view"
- For reference images, describe the desired output: "the same person taking a selfie at the beach", "this character in a fantasy setting"
