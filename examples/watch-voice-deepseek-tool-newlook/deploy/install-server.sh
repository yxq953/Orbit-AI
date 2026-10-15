#!/usr/bin/env bash
set -euo pipefail

# Update code while preserving the cloud's existing keys and watch pairing.
upload_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-$$"
release_dir="/opt/orbit-ai/releases/$release_name"
node_bin="$(command -v node)"

[[ "$(id -u)" == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ "$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ]] || { echo 'Node.js 20.3+ required.' >&2; exit 1; }
[[ -s /etc/orbit-ai/connection.json && -s /etc/orbit-ai/server.env ]]
if ! id orbit-ai >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin orbit-ai
fi
install -d -m 755 /opt/orbit-ai /opt/orbit-ai/releases
install -d -m 750 -o root -g orbit-ai /etc/orbit-ai
if [[ -e /etc/orbit-ai/connection.json ]]; then
  backup_dir="/etc/orbit-ai/backups/$release_name"
  install -d -m 700 "$backup_dir"
  cp -p /etc/orbit-ai/connection.json /etc/orbit-ai/server.env "$backup_dir/"
  cp -p /etc/systemd/system/orbit-ai.service "$backup_dir/"
  readlink -f /opt/orbit-ai/current > "$backup_dir/previous-release"
fi
install -d -m 755 "$release_dir"
if [[ ! -s /opt/orbit-ai/anysearch-skill/scripts/anysearch_cli.js ]]; then
  cp -R /opt/orbit-ai/current/tool/anysearch-skill /opt/orbit-ai/anysearch-skill
fi
cp -R "$upload_dir/cloud" "$upload_dir/shared" "$upload_dir/deploy" "$release_dir/"
find "$release_dir" -type d -exec chmod 755 {} +
find "$release_dir" -type f -exec chmod 644 {} +
python3 "$upload_dir/deploy/configure-bridge.py"
sed "s|ExecStart=/usr/local/bin/node |ExecStart=$node_bin |" "$upload_dir/deploy/orbit-ai.service" > /etc/systemd/system/orbit-ai.service
chmod 644 /etc/systemd/system/orbit-ai.service
ln -s "$release_dir" /opt/orbit-ai/current.next
mv -Tf /opt/orbit-ai/current.next /opt/orbit-ai/current
systemctl daemon-reload
systemctl enable orbit-ai.service
systemctl restart orbit-ai.service
echo "Installed $release_dir"
systemctl is-enabled orbit-ai.service
systemctl is-active orbit-ai.service
