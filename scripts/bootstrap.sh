#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -m)" != arm64 ]]; then
  echo 'This checkout targets Apple Silicon Macs.' >&2
  exit 1
fi
command -v brew >/dev/null || { echo 'Homebrew required: https://brew.sh'; exit 1; }
PYTHON="${PYTHON:-/opt/homebrew/bin/python3.12}"
if [[ ! -x "$PYTHON" ]]; then brew install python@3.12; fi
# Live input and DEBUG PCM WAV use memory/wave, so ffmpeg is not needed.
# Install only for optional conversion of other audio formats.
if [[ "${INSTALL_FFMPEG:-0}" == 1 ]] && ! command -v ffmpeg >/dev/null; then brew install ffmpeg; fi
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install -r asr/requirements.txt
mkdir -p .cache/huggingface logs build
npm install
