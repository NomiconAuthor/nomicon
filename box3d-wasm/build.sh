#!/bin/sh
# Builds box3d.wasm for the physics lessons: Box3D's sources plus box3d_web.c, compiled with
# Zig's clang for wasm32-wasi (pip install ziglang), single-threaded and without SIMD.
# Usage: ./build.sh /path/to/box3d   (a checkout of github.com/erincatto/box3d)
set -e
BOX3D=${1:-../vendor/box3d}
python3 -m ziglang cc -target wasm32-wasi -O2 -std=c17 -DNDEBUG -DBOX3D_DISABLE_SIMD \
  -I"$BOX3D/include" -I"$BOX3D/src" \
  -mexec-model=reactor -Wl,--no-entry -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  "$BOX3D"/src/*.c box3d_web.c -o box3d.wasm
echo "built box3d.wasm ($(wc -c < box3d.wasm) bytes) from $(cd "$BOX3D" && git log -1 --format='%h %cs' 2>/dev/null)"
