#!/usr/bin/env bash
# Seed a handful of sample orders on the LOCAL Supabase dev DB.
#
# Usage: ./scripts/seed-sample-orders.sh [slug] [docker-db-container]
#   slug      merchant slug to attach orders to (default: demo-bakery,
#             created as an active shop if it does not exist)
#   container default: supabase_db_bitetime-app
#
# Idempotent — re-running does nothing (order numbers are unique per merchant).
set -euo pipefail

SLUG="${1:-demo-bakery}"
CONTAINER="${2:-supabase_db_bitetime-app}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Reject anything that isn't a plain slug to avoid injection via the arg.
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
  echo "error: '$SLUG' is not a valid slug (a-z 0-9 -)" >&2
  exit 2
fi

docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -v slug="$SLUG" -f - < "$HERE/seed-sample-orders.sql"

echo "Done: seeded sample orders for merchant '${SLUG}'."
