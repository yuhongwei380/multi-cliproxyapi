#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX=${PREFIX:-/usr/local}
INSTALL_ROOT="$PREFIX/lib/multi-cliproxyapi"
BINARY_SOURCE="$ROOT_DIR/multi-cliproxyapi-linux-x64"
BINARY_PATH="$INSTALL_ROOT/multi-cliproxyapi"
DATA_DIR=${MULTI_CPA_DATA_DIR:-/opt/mutli-cliproxycpa-data}
LOG_FILE=${MULTI_CPA_LOG_FILE:-/var/log/multi-cpa.log}
LOG_RETENTION_DAYS=${MULTI_CPA_LOG_RETENTION_DAYS:-7}
ENV_DIR=/etc/multi-cliproxyapi
ENV_FILE="$ENV_DIR/controller.env"
CONTROLLER_UNIT=/etc/systemd/system/multi-cliproxyapi.service
INSTANCE_UNIT=/etc/systemd/system/multi-cpa@.service
POLKIT_RULE=/etc/polkit-1/rules.d/60-multi-cpa.rules

case "$PREFIX" in
  /*) ;;
  *) echo "PREFIX must be an absolute Linux path" >&2; exit 2 ;;
esac
case "$DATA_DIR" in
  /*) ;;
  *) echo "MULTI_CPA_DATA_DIR must be an absolute Linux path" >&2; exit 2 ;;
esac
case "$LOG_FILE" in
  /*) ;;
  *) echo "MULTI_CPA_LOG_FILE must be an absolute path" >&2; exit 2 ;;
esac
case "$LOG_FILE" in
  *[!A-Za-z0-9_./:-]*|*..*) echo "MULTI_CPA_LOG_FILE contains unsafe characters" >&2; exit 2 ;;
esac
case "$LOG_RETENTION_DAYS" in
  ''|*[!0-9]*) echo "MULTI_CPA_LOG_RETENTION_DAYS must be an integer between 1 and 365" >&2; exit 2 ;;
esac
if [ "$LOG_RETENTION_DAYS" -lt 1 ] || [ "$LOG_RETENTION_DAYS" -gt 365 ]; then
  echo "MULTI_CPA_LOG_RETENTION_DAYS must be an integer between 1 and 365" >&2
  exit 2
fi
case "$PREFIX$DATA_DIR" in
  *[!A-Za-z0-9_./:-]*|*%*) echo "installation paths may contain only letters, digits, /, ., _, :, and -" >&2; exit 2 ;;
esac
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "this release supports Linux amd64 only" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run install.sh with sudo or as root" >&2
  exit 1
fi
if [ ! -f "$BINARY_SOURCE" ]; then
  echo "binary not found: $BINARY_SOURCE" >&2
  exit 2
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
if ! systemctl show --property=Version >/dev/null 2>&1; then
  echo "systemd is not reachable; start this script from the host system" >&2
  exit 1
fi

if ! getent group multi-cpa >/dev/null 2>&1; then groupadd --system multi-cpa; fi
if ! id -u multi-cpa >/dev/null 2>&1; then useradd --system --gid multi-cpa --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin multi-cpa; fi
install -d -o multi-cpa -g multi-cpa -m 0750 "$DATA_DIR" "$DATA_DIR/instances" "$DATA_DIR/versions"
install -d -m 0755 "$INSTALL_ROOT" "$ENV_DIR" /etc/systemd/system /etc/polkit-1/rules.d
LOG_DIR=$(dirname -- "$LOG_FILE")
if [ ! -d "$LOG_DIR" ]; then install -d -o multi-cpa -g multi-cpa -m 0750 "$LOG_DIR"; fi
if [ -L "$LOG_FILE" ] || { [ -e "$LOG_FILE" ] && [ ! -f "$LOG_FILE" ]; }; then
  echo "MULTI_CPA_LOG_FILE must be a regular file" >&2
  exit 2
fi
if [ ! -e "$LOG_FILE" ]; then install -o multi-cpa -g multi-cpa -m 0640 /dev/null "$LOG_FILE"; else chown multi-cpa:multi-cpa "$LOG_FILE"; chmod 0640 "$LOG_FILE"; fi
cat > /etc/logrotate.d/multi-cpa <<EOF
"$LOG_FILE" {
  daily
  rotate $LOG_RETENTION_DAYS
  maxage $LOG_RETENTION_DAYS
  maxsize 100M
  missingok
  notifempty
  compress
  delaycompress
  create 0640 multi-cpa multi-cpa
}
EOF
chmod 0644 /etc/logrotate.d/multi-cpa
install -m 0755 "$BINARY_SOURCE" "$BINARY_PATH"
if [ ! -f "$ENV_FILE" ]; then install -m 0600 /dev/null "$ENV_FILE"; fi

cat > "$CONTROLLER_UNIT" <<EOF
[Unit]
Description=Multi CLIProxyAPI controller
After=network-online.target polkit.service
Wants=network-online.target polkit.service

[Service]
Type=simple
User=multi-cpa
Group=multi-cpa
WorkingDirectory=$DATA_DIR
EnvironmentFile=-$ENV_FILE
ExecStart="$BINARY_PATH" --data-dir "$DATA_DIR" --listen 0.0.0.0:8787 --runtime systemd --log-file "$LOG_FILE"
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
UMask=0077
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
ProtectProc=invisible
ProcSubset=pid
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$DATA_DIR $LOG_FILE

[Install]
WantedBy=multi-user.target
EOF

cat > "$INSTANCE_UNIT" <<EOF
[Unit]
Description=CLIProxyAPI instance %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=multi-cpa
Group=multi-cpa
WorkingDirectory=$DATA_DIR/instances/%i
ExecStart="$DATA_DIR/instances/%i/bin/cli-proxy-api" --config "$DATA_DIR/instances/%i/config.yaml"
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
UMask=0077
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
ProtectProc=invisible
ProcSubset=pid
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
InaccessiblePaths=$DATA_DIR/control.db $DATA_DIR/secrets.key $ENV_DIR
ReadWritePaths=$DATA_DIR/instances/%i
EOF

cat > "$POLKIT_RULE" <<'EOF'
// The controller runs as the unprivileged multi-cpa account. It may control
// only this product's per-instance template units.
polkit.addRule(function (action, subject) {
  if (subject.user !== "multi-cpa" || action.id !== "org.freedesktop.systemd1.manage-units") {
    return polkit.Result.NOT_HANDLED;
  }
  var unit = action.lookup("unit");
  var verb = action.lookup("verb");
  if (typeof unit === "string" && typeof verb === "string" &&
      /^multi-cpa@[A-Za-z0-9_-]+\.service$/.test(unit) &&
      /^(start|stop|restart|status)$/.test(verb)) {
    return polkit.Result.YES;
  }
  return polkit.Result.NOT_HANDLED;
});
EOF

chmod 0644 "$CONTROLLER_UNIT" "$INSTANCE_UNIT" "$POLKIT_RULE"
systemctl daemon-reload
systemctl enable multi-cliproxyapi.service
systemctl restart multi-cliproxyapi.service
echo "installed and started multi-cliproxyapi.service"
echo "data: $DATA_DIR"
echo "binary: $BINARY_PATH"
