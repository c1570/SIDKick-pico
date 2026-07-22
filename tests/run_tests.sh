#!/bin/bash

set -e

# Configure here: which firmware variant the test runs against.
: "${BUILD_DIR:=build-2350}"
FIRMWARE="../Source/${BUILD_DIR}/SKpico.uf2"
export FIRMWARE

npm install

if [[ ! -f "$FIRMWARE" ]]; then
  echo "Build firmware first: expected $FIRMWARE"
  echo "(override with: BUILD_DIR=build-2350 ./run_tests.sh)"
  exit 1
fi

npm run test
