#!/usr/bin/env bash
# Installs pinned, checksum-verified scanner binaries (Linux x86_64 CI runners) into ./.tools/bin.
set -euo pipefail
mkdir -p .tools/bin
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
OSV_VERSION=2.6.0
OSV_SHA256=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108

curl -fsSL -o .tools/gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  .tools/gitleaks.tgz" | sha256sum -c -
tar -xzf .tools/gitleaks.tgz -C .tools/bin gitleaks

curl -fsSL -o .tools/bin/osv-scanner "https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_linux_amd64"
echo "${OSV_SHA256}  .tools/bin/osv-scanner" | sha256sum -c -
chmod +x .tools/bin/gitleaks .tools/bin/osv-scanner
echo "$(pwd)/.tools/bin" >> "${GITHUB_PATH:-/dev/null}"
