#!/usr/bin/env python3
"""Generate an image using Gemini via Vertex AI."""

import argparse
import datetime
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

    # Log exactly what the AI passed to this tool: prompt text, whether a
    # reference image (-i) was supplied and if it actually exists on disk, and
    # the output path. Written to stderr (visible in the OpenCode tool result)
    # and appended to <output-dir>/generate-image.log, which for group calls is
    # /workspace/group/ -> host groups/<name>/ so it survives unattended runs
    # (e.g. the scheduled good-morning photo).
    input_exists = bool(args.input_image) and os.path.exists(args.input_image)
    log_line = (
        f"[{datetime.datetime.now().isoformat(timespec='seconds')}] generate_image "
        f"input_image={args.input_image or '(none)'} "
        f"input_exists={input_exists} "
        f"output={args.output} "
        f"prompt={args.prompt!r}"
    )
    print(log_line, file=sys.stderr)
    try:
        log_path = os.path.join(os.path.dirname(args.output) or ".", "generate-image.log")
        with open(log_path, "a") as log_file:
            log_file.write(log_line + "\n")
    except OSError as log_err:
        print(f"Warning: could not write log file: {log_err}", file=sys.stderr)

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
        model="gemini-3.1-flash-image",
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
