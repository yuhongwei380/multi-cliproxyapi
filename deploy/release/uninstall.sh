#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  echo "run uninstall.sh with sudo or as root" >&2
  exit 1
fi
PREFIX=${PREFIX:-/usr/local}
INSTALL_ROOT="$PREFIX/lib/multi-cliproxyapi"
DATA_DIR=${MULTI_CPA_DATA_DIR:-/opt/mutli-cliproxycpa-data}
CONTROLLER_UNIT=/etc/systemd/system/multi-cliproxyapi.service
INSTANCE_UNIT=/etc/systemd/system/multi-cpa@.service
POLKIT_RULE=/etc/polkit-1/rules.d/60-multi-cpa.rules
# Use the installed unit so custom installation paths survive a new shell.
if [ -f "$CONTROLLER_UNIT" ]; then
  installed_data=$(sed -n 's/^WorkingDirectory=//p' "$CONTROLLER_UNIT")
  installed_binary=$(sed -n 's/^ExecStart="\([^"]*\)".*/\1/p' "$CONTROLLER_UNIT")
  if [ -n "$installed_data" ]; then DATA_DIR=$installed_data; fi
  if [ -n "$installed_binary" ]; then INSTALL_ROOT=$(dirname -- "$installed_binary"); fi
fi
case "$INSTALL_ROOT" in
  /*/lib/multi-cliproxyapi) ;;
  *) echo "unsafe installation directory" >&2; exit 2 ;;
esac

case "$PREFIX" in
  /*) ;;
  *) echo "PREFIX must be an absolute Linux path" >&2; exit 2 ;;
esac
case "$DATA_DIR" in
  /*) ;;
  *) echo "MULTI_CPA_DATA_DIR must be an absolute Linux path" >&2; exit 2 ;;
esac
case "$PREFIX$DATA_DIR" in
  *[!A-Za-z0-9_./:-]*|*%*) echo "installation paths may contain only letters, digits, /, ., _, :, and -" >&2; exit 2 ;;
esac
case "$DATA_DIR" in
  *..*|/|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    echo "refusing to remove unsafe data directory: $DATA_DIR" >&2
    exit 2
    ;;
esac
check_children() {
  if ! units=$(systemctl list-units 'multi-cpa@*.service' --all --no-legend --plain --no-pager --state=active,activating,deactivating,reloading); then
    echo "cannot verify CPA service states; uninstall refused" >&2
    exit 1
  fi
  if ! processes=$(ps -eo pid=,comm=); then
    echo "cannot verify CPA processes; uninstall refused" >&2
    exit 1
  fi
  children=$(printf '%s\n' "$processes" | awk '$2 == "cli-proxy-api" || $2 == "cliproxyapi" || $2 == "CLIProxyAPI"')
  if [ -n "$units" ] || [ -n "$children" ]; then
    echo "CPA instances are still running or changing state; uninstall refused. Stop them explicitly first." >&2
    printf '%s\n%s\n' "$units" "$children" >&2
    exit 1
  fi
}
check_children
printf '%s' 'This will stop the controller and remove the installed service files and binary. Continue? [y/N] '
IFS= read -r answer || exit 1
case "$answer" in
  y|Y|yes|YES) ;;
  *) echo "uninstall cancelled"; exit 0 ;;
esac
check_children
systemctl stop multi-cliproxyapi.service
# Recheck after stopping the controller to catch a concurrent instance start.
check_children
systemctl disable multi-cliproxyapi.service
rm -f "$CONTROLLER_UNIT" "$INSTANCE_UNIT" "$POLKIT_RULE" "$INSTALL_ROOT/multi-cliproxyapi"
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
rmdir "$INSTALL_ROOT" 2>/dev/null || true
echo "multi-cliproxyapi services and binary removed"
if [ -e "$DATA_DIR" ] || [ -L "$DATA_DIR" ]; then
  if [ ! -d "$DATA_DIR" ] || [ -L "$DATA_DIR" ]; then
    echo "refusing to remove a non-directory or symlink data path: $DATA_DIR" >&2
    exit 2
  fi
  printf 'Permanently delete all instance data under %s? Type the exact path to confirm: ' "$DATA_DIR"
  IFS= read -r data_confirmation || data_confirmation=''
  if [ "$data_confirmation" = "$DATA_DIR" ]; then
    check_children
    rm -rf -- "$DATA_DIR"
    echo "instance data removed: $DATA_DIR"
  else
    echo "instance data preserved under $DATA_DIR"
  fi
else
  echo "instance data directory was already absent: $DATA_DIR"
fi
