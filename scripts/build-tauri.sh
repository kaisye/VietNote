#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_CARGO_BIN="${TASK_CARGO_BIN:-/Users/phongnguyen/.cargo/bin}"
TASK_SDK_ROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
TASK_COMPAT_SDK="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
TASK_SYSTEM_TBD="$TASK_SDK_ROOT/usr/lib/libSystem.B.tbd"
# Some beta/newer CLT installs point MacOSX.sdk at a TBD format that their own
# linker cannot parse. Use the installed 15.4 SDK, which matches our macOS 15 target.
if [[ -d "$TASK_COMPAT_SDK" && -f "$TASK_SYSTEM_TBD" ]] &&
   { ! grep -q 'arm64-macos' "$TASK_SYSTEM_TBD" || grep -q 'arm64e\.x1-macos' "$TASK_SYSTEM_TBD"; }; then
  TASK_SDK_ROOT="$TASK_COMPAT_SDK"
fi
SDKROOT="$TASK_SDK_ROOT" \
PATH="$TASK_CARGO_BIN:$PATH" \
npm run tauri build -- --bundles app "$@"
# Tauri's linker signature does not seal copied resources on this Command Line
# Tools setup. Re-sign the development bundle after resources are in place.
TASK_APP="src-tauri/target/release/bundle/macos/VietNote.app"
if [[ -d "$TASK_APP" ]]; then
  # Finder metadata/resource forks are not part of the app and make strict
  # code-sign verification fail after Tauri copies bundled resources.
  # iCloud-synced folders (Desktop/Documents) can re-add Finder metadata right
  # after it is cleared, so retry briefly instead of failing the whole build.
  for TASK_ATTEMPT in 1 2 3 4 5; do
    xattr -cr "$TASK_APP"
    if codesign --force --deep --sign - "$TASK_APP" && codesign --verify --deep --strict "$TASK_APP"; then
      break
    fi
    if [[ "$TASK_ATTEMPT" == 5 ]]; then exit 1; fi
    echo "codesign failed (attempt $TASK_ATTEMPT), retrying…" >&2
    sleep 2
  done
fi
