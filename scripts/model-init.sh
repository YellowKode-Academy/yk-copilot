#!/bin/sh
set -e
echo "[model-init] Pulling ${MODEL_FAST}..."
ollama pull "${MODEL_FAST}"
if [ "${MODEL_FAST}" != "${MODEL_SMART}" ]; then
  echo "[model-init] Pulling ${MODEL_SMART}..."
  ollama pull "${MODEL_SMART}"
fi
echo "[model-init] Done."
