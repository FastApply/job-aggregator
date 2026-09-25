#!/usr/bin/env bash
# One-time prep for the Coolify VPS (netcup VPS 4000 G12.5, Manassas VA, Debian 13).
#   ssh root@<ip> 'bash -s' < deploy/coolify/bootstrap-vps.sh
#
# Installs Coolify, adds swap, and closes Coolify's own ports (8000 dashboard, 6001/6002
# realtime + terminal) to the internet. Run the port block only AFTER Coolify has an https
# instance domain (Settings -> Instance's Domain), or you lock yourself out of the dashboard.
set -euo pipefail

# Swap: a safety net so an indexing spike degrades instead of OOM-killing the worker.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

# Coolify (installs Docker too).
command -v docker >/dev/null || curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

[ "${BLOCK_PORTS:-0}" = "1" ] || { echo "Coolify installed. Set its https domain, then re-run with BLOCK_PORTS=1."; exit 0; }

# Docker-published ports bypass ufw/nftables INPUT rules, so filter in DOCKER-USER instead.
# ctorigdstport matches the port as the client sent it (before Docker's DNAT to the container).
IF=$(ip route show default | awk '{print $5; exit}')
cat > /usr/local/sbin/block-coolify-ports.sh <<SH
#!/bin/sh
for ipt in iptables ip6tables; do
  for p in 8000 6001 6002; do
    \$ipt -C DOCKER-USER -i $IF -p tcp -m conntrack --ctorigdstport \$p --ctdir ORIGINAL -j DROP 2>/dev/null ||
      \$ipt -I DOCKER-USER -i $IF -p tcp -m conntrack --ctorigdstport \$p --ctdir ORIGINAL -j DROP
  done
done
SH
chmod +x /usr/local/sbin/block-coolify-ports.sh
cat > /etc/systemd/system/block-coolify-ports.service <<'UNIT'
[Unit]
Description=Block public access to Coolify internal ports
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/block-coolify-ports.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now block-coolify-ports.service
iptables -S DOCKER-USER
