#!/usr/bin/env bash
set -euo pipefail

KEY="${HOME}/Downloads/ssh-key-2026-07-17.key"
HOST="ubuntu@51.170.133.19"
REPO="https://github.com/Zarruk16/zkteco-adms.git"

chmod 400 "$KEY"

ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" bash << 'EOF'
set -euo pipefail
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl build-essential
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
echo "Node: $(node -v)"

if [ -d "$HOME/zkteco-adms/.git" ]; then
  cd "$HOME/zkteco-adms"
  git pull --ff-only || true
else
  rm -rf "$HOME/zkteco-adms"
  git clone https://github.com/Zarruk16/zkteco-adms.git "$HOME/zkteco-adms"
  cd "$HOME/zkteco-adms"
fi

npm install

# Keep the OS firewall open for the app
sudo iptables -C INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT

# systemd service so it survives logout/reboot
sudo tee /etc/systemd/system/zkteco-adms.service >/dev/null << 'UNIT'
[Unit]
Description=ZKTeco ADMS Attendance Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/zkteco-adms
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=8080
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable zkteco-adms
sudo systemctl restart zkteco-adms
sleep 2
sudo systemctl --no-pager --full status zkteco-adms || true
curl -sS -o /dev/null -w "Local HTTP %{http_code}\n" http://127.0.0.1:8080/ || true
echo DONE
EOF

echo
echo "Open: http://51.170.133.19:8080"
echo "K20 Pro: Domain OFF, Address 51.170.133.19, Port 8080, Proxy OFF"
