#!/usr/bin/env bash
set -eu

export USER=desktop
export HOME=/home/desktop
export DISPLAY=:1

mkdir -p "${HOME}/.vnc"
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
vncserver -kill :1 >/dev/null 2>&1 || true

exec vncserver :1 \
  -fg \
  -localhost no \
  -SecurityTypes None \
  --I-KNOW-THIS-IS-INSECURE \
  -geometry "${VNC_RESOLUTION:-1600x900}" \
  -depth "${VNC_COL_DEPTH:-24}" \
  -xstartup "${HOME}/.vnc/xstartup"
