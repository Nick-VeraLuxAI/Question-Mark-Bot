#!/bin/bash
APP_PREFIX="/solomon"

# Fetch all params under /solomon and dump into .env
aws ssm get-parameters-by-path \
  --path "$APP_PREFIX" \
  --with-decryption \
  --query "Parameters[*].[Name,Value]" \
  --output text | while read -r name value; do
    key=$(basename "$name")
    echo "$key=$value"
done > .env

echo "✔ Environment variables written to .env"
