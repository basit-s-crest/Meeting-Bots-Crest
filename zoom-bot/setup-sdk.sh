#!/bin/bash
# Exit on error
set -e

# Directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SDK_DIR="${SCRIPT_DIR}/lib/zoomsdk"

echo "Setting up Zoom Linux Meeting SDK symlinks..."

if [ ! -d "${SDK_DIR}" ]; then
    echo "Error: Zoom SDK directory ${SDK_DIR} does not exist. Please extract the SDK first."
    exit 1
fi

# Create symlink for libmeetingsdk.so
cd "${SDK_DIR}"
if [ ! -L "libmeetingsdk.so.1" ] && [ ! -f "libmeetingsdk.so.1" ]; then
    ln -sf libmeetingsdk.so libmeetingsdk.so.1
    echo "Created symlink: libmeetingsdk.so.1 -> libmeetingsdk.so"
else
    echo "Symlink libmeetingsdk.so.1 already exists."
fi

echo "SDK setup completed successfully."
