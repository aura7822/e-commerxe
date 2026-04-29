#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate.sh
# Runs TypeORM migrations against the configured database.
# Loads .env automatically.
#
# Usage:
#   ./scripts/migrate.sh [run|revert|show]
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ACTION="${1:-run}"
ENV_FILE="$(dirname "$0")/../.env"

if [[ -f "$ENV_FILE" ]]; then
  # Export all vars from .env (ignoring comments and blanks)
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +o allexport
fi

DATA_SOURCE="src/database/data-source.ts"

case "$ACTION" in
  run)
    echo "▶ Running pending migrations..."
    npx ts-node -r tsconfig-paths/register \
      ./node_modules/typeorm/cli.js migration:run \
      -d "$DATA_SOURCE"
    echo "✅ Migrations complete."
    ;;
  revert)
    echo "⏪ Reverting last migration..."
    npx ts-node -r tsconfig-paths/register \
      ./node_modules/typeorm/cli.js migration:revert \
      -d "$DATA_SOURCE"
    ;;
  show)
    echo "📋 Migration status:"
    npx ts-node -r tsconfig-paths/register \
      ./node_modules/typeorm/cli.js migration:show \
      -d "$DATA_SOURCE"
    ;;
  *)
    echo "❌ Unknown action: $ACTION"
    echo "   Usage: ./scripts/migrate.sh [run|revert|show]"
    exit 1
    ;;
esac
