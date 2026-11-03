#!/bin/sh
# One command demo: boots the gate service and runs the scripted beats.
# Agents run on the deterministic mock model provider; no API key needed.
set -e
cd "$(dirname "$0")/.."
exec node demo/run-demo.ts
