#!/usr/bin/env bash
# =============================================================================
# setup.sh — BSEngine Worker File Organiser
#
# Run this script ONCE after downloading all files into a single flat folder.
# It creates the correct directory structure and moves every file to its
# intended location, then installs Node dependencies.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# What it does:
#   1. Creates src/, src/protocol/, src/client/, src/handlers/, src/utils/
#   2. Moves each source file into the correct subdirectory
#   3. Runs `npm install` to fetch Wrangler
#   4. Prints a summary and next-step instructions
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; }

echo ""
echo -e "${CYAN}════════════════════════════════════════${RESET}"
echo -e "${CYAN}  BSEngine Worker — Project Setup       ${RESET}"
echo -e "${CYAN}════════════════════════════════════════${RESET}"
echo ""

# ── 0. Guard: must be run from the flat download directory ─────────────────
if [[ ! -f "index.js" ]]; then
  echo "Error: index.js not found in the current directory."
  echo "Please run this script from the folder where you downloaded all files."
  exit 1
fi

# ── 1. Create directory structure ──────────────────────────────────────────
info "Creating directory structure..."

mkdir -p src/protocol
mkdir -p src/client
mkdir -p src/handlers
mkdir -p src/utils

success "Directories created"

# ── 2. Move source files to correct locations ──────────────────────────────
info "Moving source files..."

# Helper: move a file only if it exists in the current directory
move_file() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mv "$src" "$dst"
    success "  $src → $dst"
  else
    warn "  $src not found — skipping (check download was complete)"
  fi
}

# Root entry point
move_file "index.js"     "src/index.js"
move_file "config.js"    "src/config.js"

# Protocol layer
move_file "constants.js" "src/protocol/constants.js"
move_file "frame.js"     "src/protocol/frame.js"

# TCP client layer
move_file "stream.js"    "src/client/stream.js"
move_file "bsengine.js"  "src/client/bsengine.js"

# HTTP handler layer
move_file "ping.js"      "src/handlers/ping.js"
move_file "stats.js"     "src/handlers/stats.js"
move_file "view.js"      "src/handlers/view.js"
move_file "upsert.js"    "src/handlers/upsert.js"
move_file "delete.js"    "src/handlers/delete.js"
move_file "incr.js"      "src/handlers/incr.js"

# Utility layer
move_file "http.js"      "src/utils/http.js"
move_file "validate.js"  "src/utils/validate.js"

# Project root files — stay where they are (already correct)
# wrangler.toml, package.json, setup.sh, full-guide-doc-worker.md

# ── 3. Verify final structure ──────────────────────────────────────────────
info "Verifying structure..."

EXPECTED_FILES=(
  "src/index.js"
  "src/config.js"
  "src/protocol/constants.js"
  "src/protocol/frame.js"
  "src/client/stream.js"
  "src/client/bsengine.js"
  "src/handlers/ping.js"
  "src/handlers/stats.js"
  "src/handlers/view.js"
  "src/handlers/upsert.js"
  "src/handlers/delete.js"
  "src/handlers/incr.js"
  "src/utils/http.js"
  "src/utils/validate.js"
  "wrangler.toml"
  "package.json"
)

ALL_OK=true
for f in "${EXPECTED_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    success "  $f"
  else
    warn "  MISSING: $f"
    ALL_OK=false
  fi
done

if [[ "$ALL_OK" = false ]]; then
  echo ""
  warn "Some files are missing. Re-download them and re-run ./setup.sh."
  exit 1
fi

# ── 4. Install Node dependencies ───────────────────────────────────────────
echo ""
info "Installing dependencies (npm install)..."
npm install
success "Dependencies installed"

# ── 5. Done ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${RESET}"
echo -e "${GREEN}  Setup complete! 🎉                    ${RESET}"
echo -e "${GREEN}════════════════════════════════════════${RESET}"
echo ""
echo "  Final structure:"
echo ""
find src -type f | sort | sed 's/^/    /'
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit  src/config.js  → set BSENGINE_HOST and BSENGINE_PORT"
echo "  2. Start BSEngine:  ./bsengine  (or docker run ...)"
echo "  3. Dev mode:        npm run dev"
echo "  4. Deploy:          npm run deploy"
echo ""
echo "  See full-guide-doc-worker.md for complete documentation."
echo ""
