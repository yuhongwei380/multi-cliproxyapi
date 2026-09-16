#!/bin/sh
set -eu

prefix=${PREFIX:-/usr/local}
case "$prefix" in /*) ;; *) echo "PREFIX must be an absolute Linux path" >&2; exit 2 ;; esac
release=${1:-""}
if [ -z "$release" ] || [ ! -d "$release/server" ] || [ ! -f "$release/server/index.js" ] || [ ! -f "$release/package.json" ]; then
  echo "usage: $0 /path/to/multi-cliproxyapi-release" >&2
  exit 2
fi
release_root=$(CDPATH= cd -- "$release" && pwd)
data_dir=${MULTI_CPA_DATA_DIR:-/opt/mutli-cliproxycpa-data}
log_file=${MULTI_CPA_LOG_FILE:-/var/log/multi-cpa.log}
log_retention_days=${MULTI_CPA_LOG_RETENTION_DAYS:-7}
case "$data_dir" in
  /*) ;;
  *) echo "MULTI_CPA_DATA_DIR must be an absolute Linux path" >&2; exit 2 ;;
esac
case "$log_file" in
  /*) ;;
  *) echo "MULTI_CPA_LOG_FILE must be an absolute path" >&2; exit 2 ;;
esac
case "$log_file" in
  *[!A-Za-z0-9_./:-]*|*..*) echo "MULTI_CPA_LOG_FILE contains unsafe characters" >&2; exit 2 ;;
esac
case "$log_retention_days" in
  ''|*[!0-9]*) echo "MULTI_CPA_LOG_RETENTION_DAYS must be an integer between 1 and 365" >&2; exit 2 ;;
esac
if [ "$log_retention_days" -lt 1 ] || [ "$log_retention_days" -gt 365 ]; then
  echo "MULTI_CPA_LOG_RETENTION_DAYS must be an integer between 1 and 365" >&2
  exit 2
fi
case "$prefix$data_dir" in
  *[!A-Za-z0-9_./:-]*|*%*) echo "installation paths may contain only letters, digits, /, ., _, :, and -" >&2; exit 2 ;;
esac
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "this release supports Linux amd64 only" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run the installer as root" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required" >&2
  exit 1
fi
if ! command -v pkaction >/dev/null 2>&1; then
  echo "polkit (pkaction) is required for the restricted controller account" >&2
  exit 1
fi
if ! command -v logrotate >/dev/null 2>&1; then
  echo "logrotate is required for controller log retention" >&2
  exit 1
fi
if ! command -v ldconfig >/dev/null 2>&1 || ! ldconfig -p 2>/dev/null | grep -Eq 'lib(duktape|mozjs)[^ ]*\.so'; then
  echo "polkit JavaScript rules backend (libduktape or libmozjs) is required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5 or newer is required" >&2
  exit 1
fi
if ! node -e "const { DatabaseSync } = require('node:sqlite'); if (!DatabaseSync) process.exit(1)" >/dev/null 2>&1; then
  echo "Node.js with node:sqlite (22.5 or newer) is required" >&2
  exit 1
fi
node_binary=$(node -p 'process.execPath')

if ! getent group multi-cpa >/dev/null 2>&1; then groupadd --system multi-cpa; fi
if ! id -u multi-cpa >/dev/null 2>&1; then useradd --system --gid multi-cpa --home-dir "$data_dir" --no-create-home --shell /usr/sbin/nologin multi-cpa; fi
install -d -o multi-cpa -g multi-cpa -m 0750 "$data_dir" "$data_dir/instances" "$data_dir/versions"
install -d -m 0755 "$prefix/lib/multi-cliproxyapi" "$prefix/lib/multi-cliproxyapi/server" "$prefix/lib/multi-cliproxyapi/web" "$prefix/lib/multi-cliproxyapi/runtime" /etc/multi-cliproxyapi /etc/systemd/system /etc/polkit-1/rules.d
log_dir=$(dirname -- "$log_file")
if [ ! -d "$log_dir" ]; then install -d -o multi-cpa -g multi-cpa -m 0750 "$log_dir"; fi
if [ -L "$log_file" ] || { [ -e "$log_file" ] && [ ! -f "$log_file" ]; }; then
  echo "MULTI_CPA_LOG_FILE must be a regular file" >&2
  exit 2
fi
if [ ! -e "$log_file" ]; then install -o multi-cpa -g multi-cpa -m 0640 /dev/null "$log_file"; else chown multi-cpa:multi-cpa "$log_file"; chmod 0640 "$log_file"; fi
cat > /etc/logrotate.d/multi-cpa <<EOF
"$log_file" {
  daily
  rotate $log_retention_days
  maxage $log_retention_days
  maxsize 100M
  missingok
  notifempty
  compress
  delaycompress
  create 0640 multi-cpa multi-cpa
}
EOF
chmod 0644 /etc/logrotate.d/multi-cpa
if [ "$node_binary" != "$prefix/lib/multi-cliproxyapi/runtime/node" ]; then
  install -m 0755 "$node_binary" "$prefix/lib/multi-cliproxyapi/runtime/node"
fi
cp -a "$release/server/." "$prefix/lib/multi-cliproxyapi/server/"
if [ -d "$release/web/dist" ]; then cp -a "$release/web/dist" "$prefix/lib/multi-cliproxyapi/web/"; fi
install -m 0644 "$release/package.json" "$prefix/lib/multi-cliproxyapi/package.json"
node "$(dirname "$0")/render-controller-unit.mjs" "$(dirname "$0")/systemd/multi-cliproxyapi.service" /etc/systemd/system/multi-cliproxyapi.service "$prefix" "$data_dir" "$log_file"
if [ ! -f /etc/multi-cliproxyapi/controller.env ]; then
  install -m 0600 "$(dirname "$0")/controller.env.example" /etc/multi-cliproxyapi/controller.env
fi
instance_unit=$(mktemp)
sed "s|/opt/mutli-cliproxycpa-data|$data_dir|g" "$(dirname "$0")/systemd/multi-cpa@.service" > "$instance_unit"
install -m 0644 "$instance_unit" /etc/systemd/system/multi-cpa@.service
rm -f "$instance_unit"
install -m 0644 "$(dirname "$0")/polkit/60-multi-cpa.rules" /etc/polkit-1/rules.d/60-multi-cpa.rules
systemctl daemon-reload
systemctl enable multi-cliproxyapi.service
systemctl restart multi-cliproxyapi.service
echo "installed and started; controller is listening on 0.0.0.0:8787"
echo "data: $data_dir"
