# NanoClaw Agent Container
# Runs OpenCode agent runtime in isolated container with browser automation

FROM oven/bun:1-debian

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager) and Google GenAI SDK
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/ && \
    pip3 install --break-system-packages google-genai Pillow

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally
RUN bun install -g agent-browser pnpm

# Create app directory
WORKDIR /app

# Copy package files and local dependency tarballs first for better caching
COPY deps/ ./deps/
COPY agent-runner/package*.json ./

# Install dependencies
RUN bun install

# Copy source code (Bun runs TypeScript directly — no compile step)
COPY agent-runner/ ./

# Create workspace and mount-point directories
# chmod 755 on /home/bun so host UID can traverse to .opencode mount
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input \
    /home/bun/.opencode \
    && chmod 755 /home/bun

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nbun run /app/src/index.ts < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh


# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
