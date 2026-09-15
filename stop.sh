#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "this service supports Linux amd64 only" >&2
  exit 1
fi

env_file=${MULTI_CPA_ENV_FILE:-}
if [ -z "$env_file" ]; then
  if [ -f "$ROOT_DIR/controller.env" ]; then
    env_file=$ROOT_DIR/controller.env
  elif [ -f "$ROOT_DIR/deploy/controller.env" ]; then
    env_file=$ROOT_DIR/deploy/controller.env
  elif [ -f /etc/multi-cliproxyapi/controller.env ]; then
    env_file=/etc/multi-cliproxyapi/controller.env
  fi
fi
if [ -n "$env_file" ] && [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

systemd_unit_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl cat multi-cliproxyapi.service >/dev/null 2>&1 || return 1
  systemd_state=$(systemctl is-system-running 2>/dev/null || true)
  case "$systemd_state" in
    running|degraded|starting|initializing) return 0 ;;
    *) return 1 ;;
  esac
}

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo systemctl "$@"
  else
    echo "systemd control requires root or sudo" >&2
    exit 1
  fi
}

runtime=${MULTI_CPA_RUNTIME:-}
if [ "$runtime" = "systemd" ]; then
  if ! systemd_unit_available; then
    echo "MULTI_CPA_RUNTIME=systemd was requested, but systemd is not running or the controller unit is unavailable" >&2
    exit 1
  fi
  run_systemctl stop multi-cliproxyapi.service
  echo "multi-cliproxyapi.service stopped"
  exit 0
elif [ "$runtime" != "process" ] && systemd_unit_available; then
  run_systemctl stop multi-cliproxyapi.service
  echo "multi-cliproxyapi.service stopped"
  exit 0
fi

data_dir=${MULTI_CPA_DATA_DIR:-$ROOT_DIR/.local-data}
pid_file=${MULTI_CPA_PID_FILE:-$data_dir/controller.pid}
if [ ! -f "$pid_file" ]; then
  echo "multi-cliproxyapi is not running"
  exit 0
fi

pid=$(cat "$pid_file" 2>/dev/null || true)
case "$pid" in
  ''|*[!0-9]*)
    rm -f "$pid_file"
    echo "removed invalid controller pid file"
    exit 0
    ;;
esac
if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file"
  echo "removed stale controller pid file"
  exit 0
fi
command_line=$(ps -p "$pid" -o args= 2>/dev/null || true)
case "$command_line" in
  *"$ROOT_DIR/server/index.js"*) ;;
  *)
    echo "refusing to stop pid $pid because it is not the controller" >&2
    exit 1
    ;;
esac

kill -TERM "$pid"
index=0
while kill -0 "$pid" 2>/dev/null && [ "$index" -lt 100 ]; do
  sleep 0.1
  index=$((index + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid"
fi
rm -f "$pid_file"
echo "multi-cliproxyapi stopped (controller only; child instances were not stopped)"
