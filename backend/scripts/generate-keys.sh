#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-keys.sh
# Generates RS256 RSA key pair for JWT signing.
# Run once before starting the application.
#
# Usage:
#   chmod +x scripts/generate-keys.sh
#   ./scripts/generate-keys.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

KEYS_DIR="$(dirname "$0")/../keys"
mkdir -p "$KEYS_DIR"

echo "🔑 Generating 4096-bit RSA key pair for JWT RS256..."

# Private key
openssl genrsa -out "$KEYS_DIR/private.pem" 4096

# Public key (derived from private)
openssl rsa -in "$KEYS_DIR/private.pem" -pubout -out "$KEYS_DIR/public.pem"

# Restrict permissions — private key must not be world-readable
chmod 600 "$KEYS_DIR/private.pem"
chmod 644 "$KEYS_DIR/public.pem"

echo "✅ Keys written to:"
echo "   Private: $KEYS_DIR/private.pem"
echo "   Public:  $KEYS_DIR/public.pem"
echo ""
echo "⚠️  Add 'keys/' to .gitignore — never commit private keys!"
echo "   In production, mount keys via Docker secret or K8s Secret volume."
