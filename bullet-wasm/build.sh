#!/bin/sh
# Builds bullet.wasm for the physics lessons: Bullet's unity sources (LinearMath, BulletCollision,
# BulletDynamics) plus bullet_web.cpp, compiled with Zig's clang++ for wasm32-wasi
# (pip install ziglang), single-threaded, no exceptions.
# Usage: ./build.sh /path/to/bullet3   (a checkout of github.com/bulletphysics/bullet3)
set -e
BT=${1:-../vendor/bullet3}
python3 -m ziglang c++ -target wasm32-wasi -O2 -DNDEBUG -DBT_NO_PROFILE -fno-exceptions -fno-rtti \
  -I"$BT/src" -mexec-model=reactor -Wl,--no-entry -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  "$BT/src/btLinearMathAll.cpp" "$BT/src/btBulletCollisionAll.cpp" "$BT/src/btBulletDynamicsAll.cpp" \
  bullet_web.cpp -o bullet.wasm
echo "built bullet.wasm ($(wc -c < bullet.wasm) bytes) from $(cd "$BT" && git log -1 --format='%h %cs' 2>/dev/null)"
