#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# E-CommerXE — full dependency + system setup
# Usage:  chmod +x install.sh && ./install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 1. Node dependencies (npm) ─────────────────────────────────────────────
echo "▶ Installing npm packages…"
npm install

# ── 2. System packages (Ubuntu/Debian) ────────────────────────────────────
echo "▶ Installing system packages…"
sudo apt-get update -qq
sudo apt-get install -y \
  openssl \
  clamav clamav-daemon \
  libvips-dev \
  postgresql-client

# ── 3. Update ClamAV signatures ────────────────────────────────────────────
echo "▶ Updating ClamAV virus definitions…"
sudo systemctl stop clamav-freshclam 2>/dev/null || true
sudo freshclam
sudo systemctl start clamav-freshclam 2>/dev/null || true
sudo systemctl enable clamav-daemon 2>/dev/null || true

# ── 4. Generate RSA key pair (JWT RS256) ──────────────────────────────────
echo "▶ Generating RSA-4096 key pair…"
mkdir -p keys
openssl genrsa -out keys/private.pem 4096
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
chmod 600 keys/private.pem
chmod 644 keys/public.pem

# ── 5. Copy env template ──────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo "▶ .env created — fill in credentials before starting"
else
  echo "▶ .env already exists — skipping"
fi

# ── 6. Docker services (Postgres + Redis) ─────────────────────────────────
echo "▶ Starting Docker services…"
docker compose up -d postgres redis

# ── 7. Wait for Postgres to be ready ──────────────────────────────────────
echo "▶ Waiting for PostgreSQL…"
until docker compose exec -T postgres \
  pg_isready -U ecommerxe_user -d ecommerxe -q; do
  sleep 1
done

# ── 8. Run migrations ─────────────────────────────────────────────────────
echo "▶ Running database migrations…"
chmod +x scripts/migrate.sh
./scripts/migrate.sh run

# ── 9. Done ───────────────────────────────────────────────────────────────
echo ""
echo "✅  Setup complete. Next steps:"
echo "   1. Edit .env  — add R2, SMTP, Google OAuth, Turnstile keys"
echo "   2. npm run start:dev"
echo "   3. Open http://localhost:3000/api/docs"
