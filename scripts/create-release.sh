#!/usr/bin/env bash
# Create GitHub Release and upload VSIX artifact
# Usage: bash scripts/create-release.sh [version]
# Example: bash scripts/create-release.sh 0.0.4
#
# IMPORTANT: Auto mode must be OFF to run this script.
# The auto mode classifier blocks git credential extraction and curl with tokens.
# Use /noauto or disable auto mode before running.
set -euo pipefail

VERSION="${1:?Usage: bash scripts/create-release.sh <version> (e.g. 0.0.4)}"
TAG="v${VERSION}"
REPO="pengqiyu123/broker-chat-vscode"
VSIX="artifacts/broker-chat-vscode-${VERSION}.vsix"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Verify VSIX exists
if [ ! -f "$VSIX" ]; then
  echo "ERROR: $VSIX not found. Run 'npm run package:vsix' first."
  exit 1
fi

# Get token from git credential store
TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2-)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not get GitHub token from git credentials"
  exit 1
fi

echo "Creating release $TAG..."

# Create tag if not exists
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -a "$TAG" -m "$TAG"
  git push origin "$TAG"
  echo "Tag $TAG created and pushed."
else
  echo "Tag $TAG already exists."
fi

# Create release
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":\"Broker Chat VS Code Extension $TAG\",\"draft\":false,\"prerelease\":false}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ne 201 ]; then
  echo "ERROR: Failed to create release (HTTP $HTTP_CODE)"
  echo "$BODY"
  exit 1
fi

RELEASE_ID=$(echo "$BODY" | python -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Release created with ID: $RELEASE_ID"

# Upload VSIX
echo "Uploading $VSIX..."
UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @"$VSIX" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$(basename $VSIX)")

UPLOAD_CODE=$(echo "$UPLOAD_RESPONSE" | tail -1)
UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')

if [ "$UPLOAD_CODE" -ne 201 ]; then
  echo "ERROR: Failed to upload asset (HTTP $UPLOAD_CODE)"
  echo "$UPLOAD_BODY"
  exit 1
fi

DOWNLOAD_URL=$(echo "$UPLOAD_BODY" | python -c "import sys,json; print(json.load(sys.stdin)['browser_download_url'])")
echo ""
echo "SUCCESS!"
echo "Release URL: https://github.com/$REPO/releases/tag/$TAG"
echo "Download: $DOWNLOAD_URL"
