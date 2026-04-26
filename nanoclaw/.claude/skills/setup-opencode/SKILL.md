---
name: setup-opencode
description: Set up the OpenCode agent runtime. Clones the OpenCode repo, creates the NanoClaw entry point and build script, builds the bundle, and rebuilds the container image. Run after cloning the project or when OpenCode needs to be updated.
---

# Setup OpenCode

Sets up the OpenCode agent runtime that NanoClaw uses inside containers.

## When to Use

- First-time setup after cloning the project
- After `opencode/` is deleted or re-cloned
- When updating OpenCode to a newer version

## Steps

### 1. Clone OpenCode (if not present)

```bash
cd <project-root>  # the parent of nanoclaw/
if [ ! -d opencode ]; then
  git clone https://github.com/anomalyco/opencode.git
fi
```

### 2. Install OpenCode dependencies

```bash
cd <project-root>/opencode
bun install
```

### 3. Copy NanoClaw files into OpenCode

Copy the two files from this skill directory into the OpenCode source tree:

```bash
cp .claude/skills/setup-opencode/nanoclaw.ts <project-root>/opencode/packages/opencode/src/nanoclaw.ts
cp .claude/skills/setup-opencode/build-nanoclaw.ts <project-root>/opencode/packages/opencode/script/build-nanoclaw.ts
```

### 4. Build and pack

```bash
cd <project-root>
./rebuild-sdk.sh
```

This runs the build script, packs the tarball into `nanoclaw/container/deps/`, and rebuilds the container image.

### 5. Verify

Check that these exist:
- `nanoclaw/container/deps/opencode-*.tgz` — the packed bundle
- Container image `nanoclaw-opencode-agent:latest` — run `docker images | grep nanoclaw-opencode`
