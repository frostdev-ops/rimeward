#!/usr/bin/env bash
# Run on the deployment host after creating the DNS-only turn.frostdev.io A record.
# Keeps existing HTTPS listeners and application configuration intact.
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Run TURN setup as root on the deployment host.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
public_ip=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
getent ahostsv4 turn.frostdev.io | awk '{print $1}' | sort -u | grep -Fxq "$public_ip" || {
  echo 'Create a DNS-only turn.frostdev.io A record pointing at this host before setup.' >&2; exit 1;
}
python3 - "$public_ip" <<'PY'
import ipaddress, sys
if not ipaddress.ip_address(sys.argv[1]).is_global: raise SystemExit('A public listening address is required')
PY
backup_dir=$(mktemp -d /var/backups/rimeward-turn-XXXXXXXX)
for item in /etc/rimeward /etc/nginx/sites-available/rimeward-turn-acme /etc/systemd/system/rimeward-turn.service /etc/letsencrypt/renewal-hooks/deploy/rimeward-turn; do
  if test -e "$item"; then cp -a --parents "$item" "$backup_dir/"; fi
done
# Prevent the package's unconfigured listener from starting during installation.
if ! dpkg-query -W coturn >/dev/null 2>&1; then systemctl mask coturn.service; fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn certbot
install -d -m 755 /var/lib/rimeward-acme
cat > /etc/nginx/sites-available/rimeward-turn-acme <<'NGINX'
server {
    listen 80;
    server_name turn.frostdev.io;
    location ^~ /.well-known/acme-challenge/ { root /var/lib/rimeward-acme; }
    location / { return 404; }
}
NGINX
ln -sfn /etc/nginx/sites-available/rimeward-turn-acme /etc/nginx/sites-enabled/rimeward-turn-acme
if ! nginx -t; then
  rm /etc/nginx/sites-enabled/rimeward-turn-acme
  if test -f "$backup_dir/etc/nginx/sites-available/rimeward-turn-acme"; then
    cp -a "$backup_dir/etc/nginx/sites-available/rimeward-turn-acme" /etc/nginx/sites-available/rimeward-turn-acme
    ln -s /etc/nginx/sites-available/rimeward-turn-acme /etc/nginx/sites-enabled/rimeward-turn-acme
  fi
  exit 1
fi
systemctl reload nginx
certbot certonly --webroot -w /var/lib/rimeward-acme -d turn.frostdev.io --non-interactive --agree-tos --register-unsafely-without-email
install -d -m 750 -o root -g turnserver /etc/rimeward /etc/rimeward/turn-tls
if ! test -s /etc/rimeward/turn.secret; then openssl rand -hex 32 > /etc/rimeward/turn.secret; fi
chmod 600 /etc/rimeward/turn.secret
python3 - "$source_dir/turnserver.conf" "$public_ip" <<'PY'
from pathlib import Path
import sys
secret = Path('/etc/rimeward/turn.secret').read_text().strip()
if len(secret) < 32 or not secret.isalnum(): raise SystemExit('Invalid TURN secret file')
text = Path(sys.argv[1]).read_text().replace('@PUBLIC_IP@', sys.argv[2])
Path('/etc/rimeward/turnserver.conf').write_text(text + '\nstatic-auth-secret=' + secret + '\n')
PY
chown root:turnserver /etc/rimeward/turnserver.conf
chmod 640 /etc/rimeward/turnserver.conf
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/rimeward-turn <<'RENEW'
#!/bin/sh
set -eu
test "${RENEWED_LINEAGE:-/etc/letsencrypt/live/turn.frostdev.io}" = /etc/letsencrypt/live/turn.frostdev.io || exit 0
install -m 640 -o root -g turnserver /etc/letsencrypt/live/turn.frostdev.io/fullchain.pem /etc/rimeward/turn-tls/fullchain.pem
install -m 640 -o root -g turnserver /etc/letsencrypt/live/turn.frostdev.io/privkey.pem /etc/rimeward/turn-tls/privkey.pem
if systemctl is-active --quiet rimeward-turn.service; then systemctl restart rimeward-turn.service; fi
RENEW
chmod 700 /etc/letsencrypt/renewal-hooks/deploy/rimeward-turn
/etc/letsencrypt/renewal-hooks/deploy/rimeward-turn
cat > /etc/systemd/system/rimeward-turn.service <<'UNIT'
[Unit]
Description=Rimeward authenticated TURN relay
After=network-online.target
Wants=network-online.target
[Service]
User=turnserver
Group=turnserver
RuntimeDirectory=rimeward-turn
ExecStart=/usr/bin/turnserver -c /etc/rimeward/turnserver.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=512M
TasksMax=128
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rimeward-turn.service
systemctl restart rimeward-turn.service
systemctl is-active --quiet rimeward-turn.service
echo "TURN configured. Rollback files: $backup_dir"
echo 'Verify firewall/provider access to UDP/TCP 3478, TCP 5349, UDP 55000–55199 and run forced-TURN acceptance.'
