#!/bin/sh
# XCODE CLOUD — after clone, before the build. Apple's runner has Xcode but not Node, and the iOS
# project resolves Capacitor's Swift packages out of node_modules (ios/App/CapApp-SPM/Package.swift
# points at ../../../node_modules/@capacitor/...). So: install Node, install the exact lockfile,
# and let Capacitor write its native config. Fails loudly — a missing node_modules would otherwise
# surface as an opaque Swift package resolution error.
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH"

echo "== node =="
if ! command -v node >/dev/null 2>&1; then
  brew install node@22 >/dev/null
  export PATH="/usr/local/opt/node@22/bin:/opt/homebrew/opt/node@22/bin:$PATH"
fi
node -v
npm -v

echo "== npm ci =="
npm ci --no-audit --no-fund

echo "== capacitor sync (native config only; the UI is server.url) =="
npx cap sync ios --no-build 2>/dev/null || npx cap sync ios
echo "post-clone done"
