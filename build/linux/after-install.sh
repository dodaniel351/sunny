#!/bin/bash
# Custom .deb postinst (referenced from electron-builder.yml → deb.afterInstall).
#
# WHY THIS EXISTS: electron-builder's default postinst only SUID-roots
# chrome-sandbox when it decides user namespaces are unavailable (via
# `unshare --user true`). On Ubuntu 23.10+/24.04 that probe FALSELY succeeds —
# unshare works, but AppArmor's unprivileged-userns restriction blocks the
# namespace Chromium's sandbox actually needs — so the default leaves
# chrome-sandbox at 0755 and the app fails to launch ("The SUID sandbox helper
# binary was found, but is not configured correctly"). We therefore ALWAYS SUID
# it: the setuid sandbox helper is the traditional, supported fallback and is
# harmless on systems where the userns sandbox also works.
chmod 4755 '/opt/Sunny/chrome-sandbox' || true

# CLI launcher symlink (mirrors electron-builder's default behavior).
ln -sf '/opt/Sunny/sunny' '/usr/bin/sunny' || true

# Best-effort desktop integration refresh.
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
