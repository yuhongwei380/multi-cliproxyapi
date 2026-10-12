# Multi CLIProxyAPI binary release

- Binary: multi-cliproxyapi-linux-x64
- Target: Linux amd64
- SHA-256: see multi-cliproxyapi-linux-x64.sha256

The executable embeds the controller and web UI. For a server installation, run sudo bash install.sh, then use sudo bash start.sh and sudo bash stop.sh; the installer registers the controller service, the multi-cpa@.service template, and the restricted polkit rule. Instance data defaults to /opt/mutli-cliproxycpa-data (override with MULTI_CPA_DATA_DIR). Controller output is dual-written to the systemd journal and /var/log/multi-cpa.log; the installer configures daily logrotate with 7 days by default, or 14 days when MULTI_CPA_LOG_RETENTION_DAYS=14 is set during installation. ./uninstall.sh refuses to uninstall while any CPA child service or process is running (including old instances), and asks once before removing services and the binary, then asks for the exact data path before permanently deleting instance data; declining the second prompt keeps the data. Set MULTI_CPA_LISTEN and other supported environment variables before starting it. The first administrator password defaults to admin unless MULTI_CPA_ADMIN_PASSWORD is set; change it from the administrator avatar settings after login.
