#!/usr/bin/env bash
# Install the pinned NVIDIA Nemotron 3 native runtime for Apple Silicon.
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_ROOT="$PWD"
TASK_REV=97a15afa5caa9bce5baaa86c1184103877af4101
TASK_MODEL_REV=f667ed73aee57d40cc39428eb768b4fd87a0a29e
TASK_MODEL_SHA=08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Automatic setup requires Apple Silicon. For other platforms set NEMOTRON_LIBRARY and NEMOTRON_MODEL to a Nemotron 3 native build.' >&2
  exit 1
fi
if [[ ! -x .venv/bin/python ]]; then
  echo 'Run scripts/bootstrap.sh first to create .venv.' >&2
  exit 1
fi
command -v brew >/dev/null || { echo 'Homebrew is required for sentencepiece.' >&2; exit 1; }
if ! brew list sentencepiece >/dev/null 2>&1; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install sentencepiece
fi
if ! brew list abseil >/dev/null 2>&1; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install abseil
fi
.venv/bin/python -m pip install 'cmake==4.4.3' 'ninja==1.13.2'
mkdir -p .cache/models
if [[ ! -d .cache/nemo-source/.git ]]; then
  git clone --filter=blob:none https://github.com/NVIDIA/NeMo-Speech.cpp.git .cache/nemo-source
  git -C .cache/nemo-source checkout --detach "$TASK_REV"
fi
if [[ "$(git -C .cache/nemo-source rev-parse HEAD)" != "$TASK_REV" ]]; then
  echo "Existing .cache/nemo-source must be at $TASK_REV; preserve local changes before changing revision." >&2
  exit 1
fi
git -C .cache/nemo-source submodule update --init --depth 1 ggml
TASK_SDK="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
if [[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk ]]; then
  TASK_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
fi
.venv/bin/cmake -S .cache/nemo-source -B .cache/nemo-build -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$TASK_ROOT/.venv/bin/ninja" \
  -DCMAKE_PREFIX_PATH="$(brew --prefix)" -DCMAKE_OSX_SYSROOT="$TASK_SDK" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$TASK_ROOT/.cache/nemotron" \
  -DGGML_METAL=ON -DNEMO_SPEECH_GGML_PATCHED=OFF \
  -DNEMO_SPEECH_BUILD_ASR=OFF -DNEMO_SPEECH_BUILD_DIAR=ON \
  -DNEMO_SPEECH_BUILD_TTS=OFF -DNEMO_SPEECH_BUILD_CLI=OFF
.venv/bin/cmake --build .cache/nemo-build -j 4
.venv/bin/cmake --install .cache/nemo-build
# Release CI only needs the runtime: users download the pinned model from Settings.
if [[ "${NEMOTRON_SKIP_MODEL:-}" == 1 ]]; then
  echo 'Nemotron 3 runtime built (model download skipped).'
  exit 0
fi
# Keep TASK_MODEL_REV / TASK_MODEL_SHA in sync with src-tauri/src/diarization_model.rs.
TASK_MODEL=.cache/models/Nemotron-3-Diarization.q8_0.gguf
if [[ ! -f "$TASK_MODEL" ]]; then
  curl --fail --location --retry 3 --output "$TASK_MODEL.partial" \
    "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/$TASK_MODEL_REV/Nemotron-3-Diarization.q8_0.gguf"
  [[ "$(shasum -a 256 "$TASK_MODEL.partial" | cut -d ' ' -f 1)" == "$TASK_MODEL_SHA" ]] || { echo 'Model checksum mismatch' >&2; exit 1; }
  mv "$TASK_MODEL.partial" "$TASK_MODEL"
fi
[[ "$(shasum -a 256 "$TASK_MODEL" | cut -d ' ' -f 1)" == "$TASK_MODEL_SHA" ]] || { echo 'Model checksum mismatch' >&2; exit 1; }
PYTHONPATH=asr .venv/bin/python -c 'from diarization import NativeDiarizer; model = NativeDiarizer(); model.close(); print("Nemotron 3 ready. Restart VietNote.")'
