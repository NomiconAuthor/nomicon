#!/bin/sh
# Builds flecs.wasm for the site: instrument the flecs sources, then compile
# with Zig's clang for wasm32-wasi (pip install ziglang). Run from this folder.
set -e
FLECS=${1:-../vendor/flecs/distr}
python3 instrument.py "$FLECS"
python3 -m ziglang cc -target wasm32-wasi -O2 -DFLECS_NO_OS_API_IMPL -Ishim \
  -mexec-model=reactor -Wl,--no-entry -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  flecs_web.c -o flecs.wasm
echo "built flecs.wasm ($(wc -c < flecs.wasm) bytes)"
