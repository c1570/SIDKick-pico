#!/bin/bash

set -e

# Configure here: which firmware variant the test runs against.
: "${BUILD_DIR:=build-2350}"
FIRMWARE="../Source/${BUILD_DIR}/SKpico.uf2"
export FIRMWARE

if [[ ! -d rp2350js ]]; then
  git clone --depth 1 https://github.com/c1570/rp2350js.git
fi

# (Re)build the emulator library whenever the compiled output is missing.
if [[ ! -f rp2350js/dist/esm/index.js ]]; then
  cd rp2350js/
  npm install
  npm run build
  cd ..
fi

npm install

if [[ ! -f "$FIRMWARE" ]]; then
  echo "Build firmware first: expected $FIRMWARE"
  echo "(override with: BUILD_DIR=build-2350 ./run_tests.sh)"
  exit 1
fi

npm run test
