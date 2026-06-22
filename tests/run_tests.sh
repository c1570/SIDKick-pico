#!/bin/bash

set -e

# Configure here: which firmware variant the test runs against.
: "${BUILD_DIR:=build-2350-riscv}"
FIRMWARE="../Source/${BUILD_DIR}/SKpico.uf2"
export FIRMWARE

if [[ ! -d rp2040js ]]; then
  git clone --depth 1 https://github.com/c1570/rp2040js.git
fi

# (Re)build the emulator library whenever the compiled output is missing.
if [[ ! -f rp2040js/dist/esm/index.js ]]; then
  cd rp2040js/
  npm install
  # Build the library (produces dist/esm + dist/cjs and fixes up the .js
  # import extensions that test_runner.js relies on).
  npm run build
  # Compile the bootrom modules that test_runner.js imports as plain .js files.
  npx tsc demo/bootrom.ts --skipLibCheck
  npx tsc demo/bootrom_rp2350.ts --skipLibCheck
  cd ..
fi

npm install

if [[ ! -f "$FIRMWARE" ]]; then
  echo "Build firmware first: expected $FIRMWARE"
  echo "(override with: BUILD_DIR=build-2350 ./run_tests.sh)"
  exit 1
fi

npm run test
