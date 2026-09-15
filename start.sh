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
  # WSL often has the systemctl client and even an installed unit file while
  # systemd itself is not PID 1.  Only select the systemd path when the
  # manager is actually reachable.
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
if [ -z "$runtime" ]; then
  if systemd_unit_available; then
    run_systemctl start multi-cliproxyapi.service
    echo "multi-cliproxyapi.service started"
    exit 0
  fi
  runtime=process
elif [ "$runtime" = "systemd" ]; then
  if ! systemd_unit_available; then
    echo "MULTI_CPA_RUNTIME=systemd was requested, but systemd is not running or the controller unit is unavailable" >&2
    exit 1
  fi
  run_systemctl start multi-cliproxyapi.service
  echo "multi-cliproxyapi.service started"
  exit 0
elif [ "$runtime" != "process" ]; then
  echo "MULTI_CPA_RUNTIME must be process or systemd" >&2
  exit 1
fi
export MULTI_CPA_RUNTIME="$runtime"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5 or newer is required" >&2
  exit 1
fi
if ! node -e "const { DatabaseSync } = require('node:sqlite'); if (!DatabaseSync) process.exit(1)" >/dev/null 2>&1; then
  echo "Node.js with node:sqlite is required" >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/server/index.js" ]; then
  echo "server/index.js was not found" >&2
  exit 1
fi

data_dir=${MULTI_CPA_DATA_DIR:-$ROOT_DIR/.local-data}
listen=${MULTI_CPA_LISTEN:-0.0.0.0:8787}
pid_file=${MULTI_CPA_PID_FILE:-$data_dir/controller.pid}
log_file=${MULTI_CPA_LOG_FILE:-$data_dir/controller.log}
mkdir -p "$data_dir"
chmod 700 "$data_dir"
mkdir -p "$(dirname -- "$pid_file")" "$(dirname -- "$log_file")"

is_controller_pid() {
  pid=$1
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(ps -p "$pid" -o args= 2>/dev/null || true)
  case "$command_line" in
    *"$ROOT_DIR/server/index.js"*) return 0 ;;
  esac
  return 1
}

if [ -f "$pid_file" ]; then
  old_pid=$(cat "$pid_file" 2>/dev/null || true)
  if is_controller_pid "$old_pid"; then
    echo "multi-cliproxyapi is already running (pid $old_pid)"
    exit 0
  fi
  rm -f "$pid_file"
fi

# A controller started with another data directory has no PID file here.  A
# quick health probe turns the otherwise opaque EADDRINUSE failure into an
# actionable message without attempting to stop an unrelated process.
listen_port=${listen##*:}
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:${listen_port}/health" >/dev/null 2>&1; then
  echo "a controller is already listening on $listen; set MULTI_CPA_DATA_DIR to its data directory or stop that controller before starting this one" >&2
  exit 1
fi

umask 077
# The source-tree fallback is intended for Linux/WSL environments where the
# systemd manager is unavailable. Use detached child processes there so
# instance actions do not call systemctl as the interactive shell user.
nohup node "$ROOT_DIR/server/index.js" --data-dir "$data_dir" --listen "$listen" "$@" >"$log_file" 2>&1 < /dev/null &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
sleep 1
if ! is_controller_pid "$pid"; then
  echo "multi-cliproxyapi failed to start" >&2
  cat "$log_file" >&2 || true
  rm -f "$pid_file"
  exit 1
fi
echo "multi-cliproxyapi started (pid $pid, listen $listen, runtime $MULTI_CPA_RUNTIME, data $data_dir)"
echo "log: $log_file"
