#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  systemctl stop multi-cliproxyapi.service
else
  echo "run this script with sudo or as root" >&2
  exit 1
fi
echo "multi-cliproxyapi.service stopped; child CPA services were left running"
