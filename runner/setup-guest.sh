#!/bin/sh
# Installs the CI toolchain into the Debian guest image (run by runner/Containerfile).
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends git ca-certificates curl xz-utils unzip libatomic1
node=$(curl -fsSL https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt | grep -o 'node-v26[0-9.]*-linux-arm64.tar.xz' | head -1)
curl -fsSL "https://nodejs.org/dist/latest-v26.x/$node" | tar -xJ -C /usr/local --strip-components=1
curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip
unzip -o -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64
# bun check, bun lint and bun fmt ship in canary builds.
bun upgrade --canary
node --version
bun --version
git --version
