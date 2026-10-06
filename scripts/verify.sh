#!/bin/sh
# One-shot verification entrypoint used by the `verify` compose service.
# Fails fast (set -e) so the container exit code reflects the overall result.
set -eu

echo "==> [1/3] Unit and integration tests"
npm test

echo "==> [2/3] Production build (tsc)"
npm run build

echo "==> [3/3] HTTP smoke checks against the running API (${BASE_URL:-http://api:3000})"
node scripts/smoke.mjs

echo "==> All verification checks passed."
