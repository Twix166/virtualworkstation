#!/usr/bin/env bash
set -eu

mkdir -p \
  /run/dbus \
  /run/systemd \
  /run/systemd/seats \
  /run/systemd/sessions \
  /run/systemd/users \
  /run/user/1001 \
  /tmp/.X11-unix \
  /tmp/.ICE-unix

chown 1001:1001 /run/user/1001
chmod 700 /run/user/1001
chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix
