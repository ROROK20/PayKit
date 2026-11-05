#!/bin/sh
# Vercel build for the playground. It imports the SDK as `file:..`, so the SDK has
# to build first, which needs Root Directory = frontend/ with the repo root above it.
set -e
if ! grep -q '"name": "paykit"' ../package.json 2>/dev/null; then
  echo "Wrong Vercel Root Directory: this build expects frontend/, so that .. is the paykit SDK."
  echo "Fix: Project > Settings > Build & Deployment > Root Directory: frontend, then redeploy."
  exit 1
fi
cd ..
npm ci --include=dev --ignore-scripts
npm run build
cd frontend
npm install --include=dev
npm run build
