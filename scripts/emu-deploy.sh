#!/usr/bin/env bash
#
# emu-deploy.sh - Build and deploy a Vela Quick App RPK to the Vela emulator
#
# Usage:
#   ./emu-deploy.sh --project <dir>  [options]
#
# Options:
#   --project <dir>       Path to the Vela JS project (required)
#   --serial <serial>     Emulator ADB serial (default: emulator-5554)
#   --no-build            Skip building, deploy existing RPK
#   --no-screenshot       Skip taking a screenshot after deploy
#   --grpc-port <port>    gRPC port for emulator (default: auto-detect or 8554)
#   -h, --help            Show this help
#
# Environment variables:
#   EMU_SERIAL            Emulator ADB serial (overridden by --serial)
#   GRPC_PORT             gRPC port (overridden by --grpc-port)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Defaults ---
EMU_SERIAL="${EMU_SERIAL:-emulator-5554}"
APP_DIR="/data/quickapp/app"
PROJECT_DIR=""
DO_BUILD=true
DO_SCREENSHOT=true
GRPC_PORT="${GRPC_PORT:-}"

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)     PROJECT_DIR="$2"; shift 2 ;;
        --serial)      EMU_SERIAL="$2"; shift 2 ;;
        --grpc-port)   GRPC_PORT="$2"; shift 2 ;;
        --no-build)    DO_BUILD=false; shift ;;
        --no-screenshot) DO_SCREENSHOT=false; shift ;;
        -h|--help)
            sed -n '2,/^$/{ s/^# \?//; p }' "$0"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1 (use --help for usage)"
            exit 1
            ;;
    esac
done

if [ -z "$PROJECT_DIR" ]; then
    echo "ERROR: --project <dir> is required"
    echo "Run with --help for usage"
    exit 1
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
ADB="adb -s ${EMU_SERIAL}"

# --- Read package name from manifest.json ---
MANIFEST="$PROJECT_DIR/src/manifest.json"
if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: No manifest.json found at $MANIFEST"
    exit 1
fi
PKG_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST')).package)")

# --- Check emulator is connected ---
if ! $ADB get-state >/dev/null 2>&1; then
    echo "ERROR: Emulator not found at ${EMU_SERIAL}"
    echo "Start the emulator from AIoT IDE first."
    exit 1
fi

# --- Build ---
if $DO_BUILD; then
    echo "Building..."
    (cd "$PROJECT_DIR" && npm run build 2>&1 | tail -3)
fi

# --- Find latest RPK ---
RPK=$(ls -t "$PROJECT_DIR/dist/"*.rpk 2>/dev/null | head -1)
if [ -z "$RPK" ]; then
    echo "ERROR: No .rpk file found in $PROJECT_DIR/dist/"
    exit 1
fi
echo "Deploying: $(basename "$RPK")"

# --- Push RPK ---
$ADB push "$RPK" "$APP_DIR/$PKG_NAME.rpk" 2>&1

# --- Extract RPK ---
$ADB shell unzip -o "$APP_DIR/$PKG_NAME.rpk" -d "$APP_DIR/$PKG_NAME" 2>&1

# --- Start app (kills old instance automatically) ---
echo "Starting app..."
$ADB shell "vapp app/$PKG_NAME &" 2>&1
sleep 2

# --- Screenshot ---
if $DO_SCREENSHOT; then
    SCREENSHOT="/tmp/emu-screenshot.png"
    GRPC_ARGS=""
    if [ -n "$GRPC_PORT" ]; then
        GRPC_ARGS="--port $GRPC_PORT"
    fi
    node "$SCRIPT_DIR/emulator-grpc.js" $GRPC_ARGS screenshot "$SCREENSHOT" >/dev/null 2>&1 && \
        echo "Screenshot saved to $SCREENSHOT" || \
        echo "WARN: Screenshot failed (gRPC not available?)"
fi

echo "Done!"
