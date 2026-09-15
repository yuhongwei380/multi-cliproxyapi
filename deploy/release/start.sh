#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  systemctl start multi-cliproxyapi.service
else
  echo "run this script with sudo or as root" >&2
  exit 1
fi
echo "multi-cliproxyapi.service started"
