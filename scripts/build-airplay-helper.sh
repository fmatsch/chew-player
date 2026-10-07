#!/bin/sh
# Builds the native macOS AirPlay helper (universal binary) into build/native/chew-airplay.
set -e
[ "$(uname)" = "Darwin" ] || { echo "skipping AirPlay helper (macOS only)"; exit 0; }
cd "$(dirname "$0")/.."
mkdir -p build/native
SRC=native/airplay-helper/main.swift
swiftc -O -target arm64-apple-macos13 -o build/native/chew-airplay-arm64 "$SRC"
swiftc -O -target x86_64-apple-macos13 -o build/native/chew-airplay-x64 "$SRC"
lipo -create -output build/native/chew-airplay build/native/chew-airplay-arm64 build/native/chew-airplay-x64
rm build/native/chew-airplay-arm64 build/native/chew-airplay-x64
echo "built build/native/chew-airplay"
