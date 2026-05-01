#!/bin/bash

# Create the ssl directory if it doesn't exist
mkdir -p ssl

# Check if certificates already exist
if [ -f "ssl/fullchain.pem" ] && [ -f "ssl/privkey.pem" ]; then
    echo "SSL certificates already exist in ./ssl/"
    exit 0
fi

echo "Generating self-signed SSL certificates..."

# Generate self-signed certificate
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout ssl/privkey.pem \
    -out ssl/fullchain.pem \
    -subj "/C=US/ST=State/L=City/O=SimpleIPTV/OU=Dev/CN=localhost"

if [ $? -eq 0 ]; then
    echo "Success! Certificates generated in ./ssl/"
    echo "You can now run: docker-compose up -d"
else
    echo "Error: Failed to generate certificates."
    exit 1
fi
