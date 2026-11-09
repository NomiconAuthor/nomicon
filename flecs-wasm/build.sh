#!/bin/sh
# Builds flecs.wasm for the site: instrument the flecs sources, then compile
# with Zig's clang for wasm32-wasi (pip install ziglang). Run from this folder.
#   ./build.sh <flecs>/distr                       release build (asserts compiled out) -> flecs.wasm
#   OUT=flecs-debug.wasm CFLAGS=-DFLECS_DEBUG ./build.sh <flecs>/distr   debug build, for checking asserts
# FLECS_NO_SCRIPT_SHELL / FLECS_NO_SCRIPT_INPUT: add-ons new in flecs 4.2 that the site
# doesn't use (a command shell and mouse/keyboard events for scripts); about 200 kB.
set -e
FLECS=${1:-../vendor/flecs/distr}
OUT=${OUT:-flecs.wasm}
python3 instrument.py "$FLECS"
python3 -m ziglang cc -target wasm32-wasi -O2 -DFLECS_NO_OS_API_IMPL -DFLECS_NO_SCRIPT_SHELL -DFLECS_NO_SCRIPT_INPUT $CFLAGS -Ishim \
  -mexec-model=reactor -Wl,--no-entry -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  flecs_web.c -o "$OUT"
echo "built $OUT ($(wc -c < "$OUT") bytes)"
