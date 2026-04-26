#!/usr/bin/env python3
"""Generate an image using Gemini via Vertex AI."""

import argparse
import os
import sys

from PIL import Image

from google import genai
from google.genai import types


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", help="Image generation prompt")
    parser.add_argument("-o", "--output", default="/workspace/group/generated_image.png",
                        help="Output file path (must be under /workspace/group/)")
    parser.add_argument("-i", "--input-image", default=None,
                        help="Path to an input image for editing/transformation")
    args = parser.parse_args()

    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/gcloud-credentials.json")
    if not os.path.exists(creds_path):
        print("Error: Vertex AI is not configured. No credentials file found at "
              f"{creds_path}. Ask the admin to set up Vertex AI (add "
              "GOOGLE_APPLICATION_CREDENTIALS to .env).", file=sys.stderr)
        sys.exit(1)

    # Build contents: text-only or text+image
    if args.input_image:
        if not os.path.exists(args.input_image):
            print(f"Error: input image not found: {args.input_image}", file=sys.stderr)
            sys.exit(1)
        with open(args.input_image, "rb") as f:
            image_data = f.read()
        # Detect MIME type from extension
        ext = os.path.splitext(args.input_image)[1].lower()
        mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".gif": "image/gif", ".webp": "image/webp"}
        mime_type = mime_map.get(ext, "image/png")
        contents = [
            types.Part.from_bytes(data=image_data, mime_type=mime_type),
            args.prompt,
        ]
    else:
        contents = args.prompt

    client = genai.Client(vertexai=True, location="global")
    response = client.models.generate_content(
        model="gemini-3.1-flash-image-preview",
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
        ),
    )

    # Check for errors
    if response.candidates[0].finish_reason != types.FinishReason.STOP:
        reason = response.candidates[0].finish_reason
        print(f"Error: {reason}", file=sys.stderr)
        sys.exit(1)

    for part in response.candidates[0].content.parts:
        if part.thought:
            continue
        if part.inline_data:
            with open(args.output, "wb") as f:
                f.write(part.inline_data.data)
            img = Image.open(args.output)
            img.save(args.output, optimize=True, compress_level=9)
            print(args.output)
            return

    print("Error: no image was generated", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
