#!/usr/bin/env bash
#
# One-click setup for macOS, Linux and Git Bash.
#
#   ./setup.sh        (or: bash setup.sh)
#
# A thin front door for `npm run setup` (scripts/setup.ts), which does the real
# work: installs the locked dependencies, creates .env.local, makes sure a local
# PostgreSQL is running (Docker, or one already listening on localhost:5432),
# and prepares the test and development databases. This file only checks that
# Node.js is present and the right version first, so a missing prerequisite is
# one clear sentence instead of a stack trace.

set -euo pipefail

cd "$(dirname "$0")"

wanted="$(tr -d '[:space:]' < .nvmrc)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js ${wanted} from https://nodejs.org and run this again." >&2
  exit 1
fi

actual="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "${actual}" != "${wanted}" ]; then
  echo "This project needs Node.js ${wanted}; you have $(node --version). Install Node.js ${wanted} from https://nodejs.org and run this again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. It ships with Node.js - reinstall Node.js ${wanted} from https://nodejs.org." >&2
  exit 1
fi

npm run setup
