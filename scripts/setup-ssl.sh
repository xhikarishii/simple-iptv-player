#!/bin/bash

# Target directory (default to ./ssl or first argument)
TARGET_DIR="${1:-ssl}"
mkdir -p "$TARGET_DIR"

# Check if certificates already exist in the target directory
if [ -f "$TARGET_DIR/fullchain.pem" ] && [ -f "$TARGET_DIR/privkey.pem" ]; then
    echo "SSL certificates already exist in $TARGET_DIR"
    exit 0
fi

echo "Generating self-signed SSL certificates in $TARGET_DIR..."

# Generate self-signed certificate
# Using -subj to avoid interactive prompts during docker build/start
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$TARGET_DIR/privkey.pem" \
    -out "$TARGET_DIR/fullchain.pem" \
    -subj "/C=US/ST=State/L=City/O=SimpleIPTV/OU=Dev/CN=localhost"

if [ $? -eq 0 ]; then
    echo "Success! Certificates generated in $TARGET_DIR"
else
    echo "Error: Failed to generate certificates."
    exit 1
fi
