#!/bin/bash
set -e

BASE_URL="${NIMBUS_LEMONADE_BASE_URL:-http://localhost:13305}"
MODEL="user.Qwen3.6-35B-A3B-MTP-GGUF"

echo "Pulling $MODEL ..."
curl -fS -X POST "$BASE_URL/api/v1/pull" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "user.Qwen3.6-35B-A3B-MTP-GGUF",
    "checkpoint": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    "mmproj": "mmproj-F16.gguf",
    "labels": ["vision", "tool-calling", "mtp"],
    "recipe": "llamacpp",
    "recipe_options": {"ctx_size": 32768},
    "stream": true
  }'

echo
echo "Loading $MODEL ..."
curl -fS -X POST "$BASE_URL/api/v1/load" \
  -H "Content-Type: application/json" \
  -d "{\"model_name\": \"$MODEL\"}"

echo
echo "Done."
