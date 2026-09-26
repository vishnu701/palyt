#!/usr/bin/env bash
# Sync app/ + deploy/ to the VM and rebuild the containers there.
# Usage: deploy/deploy.sh            (uses gcloud's active account)
set -euo pipefail
PROJECT=palyt-dev-test
ZONE=asia-south1-a
VM=kitchenvoice
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ syncing to $VM"
tar -C "$ROOT" --exclude node_modules --exclude .git --exclude '.env' -czf /tmp/kitchenvoice.tgz app deploy
gcloud compute scp /tmp/kitchenvoice.tgz "$VM:/tmp/kitchenvoice.tgz" --project "$PROJECT" --zone "$ZONE" --quiet

if [ -f "$ROOT/.env" ]; then
  echo "→ uploading .env (never committed)"
  gcloud compute scp "$ROOT/.env" "$VM:/tmp/kitchenvoice.env" --project "$PROJECT" --zone "$ZONE" --quiet
fi

echo "→ building + restarting on the VM"
gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --quiet --command '
  set -e
  sudo mkdir -p /opt/kitchenvoice/data
  sudo tar -xzf /tmp/kitchenvoice.tgz -C /opt/kitchenvoice
  if [ -f /tmp/kitchenvoice.env ]; then sudo mv /tmp/kitchenvoice.env /opt/kitchenvoice/.env; sudo chmod 600 /opt/kitchenvoice/.env; fi
  [ -f /opt/kitchenvoice/.env ] || sudo touch /opt/kitchenvoice/.env
  cd /opt/kitchenvoice/deploy
  # Real hostname configured → drop "tls internal" so Caddy fetches a Let'"'"'s Encrypt cert.
  SITE=$(grep -E "^SITE_ADDRESS=" /opt/kitchenvoice/.env | cut -d= -f2- || true)
  if [ -n "$SITE" ] && [ "$SITE" != ":443" ]; then sudo sed -i "/^\s*tls internal$/d" Caddyfile; fi
  sudo cp /opt/kitchenvoice/.env .env   # compose reads SITE_ADDRESS from here
  sudo docker compose build --pull gateway
  sudo docker compose up -d --remove-orphans
  sudo docker compose ps
'
IP=$(gcloud compute addresses describe kitchenvoice-ip --project "$PROJECT" --region asia-south1 --format='value(address)')
echo "→ live at https://$IP  (healthz: https://$IP/healthz)"
