#!/usr/bin/env bash

set -euo pipefail

REPO_OWNER="${REPO_OWNER:-Twix166}"
REPO_NAME="${REPO_NAME:-virtualworkstation}"
REPO_REF="${REPO_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/virtualworkstation}"
REPO_ARCHIVE_URL="${REPO_ARCHIVE_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_REF}.tar.gz}"
API_GATEWAY_PORT_VALUE="${API_GATEWAY_PORT:-8080}"
AUTH_TOKEN_SECRET_VALUE="${AUTH_TOKEN_SECRET:-virtualworkstation-dev-secret}"
START_STACK="${START_STACK:-1}"
SKIP_DOCKER_CHECK="${SKIP_DOCKER_CHECK:-0}"
TMP_DIR=""
COMPOSE_CMD=()

log() {
  printf '[install] %s\n' "$*"
}

fail() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

detect_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
    return
  fi

  fail "Docker Compose is required. Install the Docker Compose plugin or docker-compose."
}

is_port_in_use() {
  local port="$1"
  local ss_output

  if command -v ss >/dev/null 2>&1; then
    ss_output="$(ss -ltnH "( sport = :${port} )" 2>&1 || true)"
    if [ -n "$ss_output" ] && ! printf '%s' "$ss_output" | grep -q "Operation not permitted"; then
      printf '%s\n' "$ss_output" | grep -q .
      return $?
    fi
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", port))
except OSError as exc:
    if exc.errno == errno.EADDRINUSE:
        raise SystemExit(0)
    raise SystemExit(2)
else:
    raise SystemExit(1)
finally:
    s.close()
PY
    case "$?" in
      0) return 0 ;;
      1) return 1 ;;
    esac
  fi

  return 1
}

find_first_free_port() {
  local port

  for port in "$@"; do
    if ! is_port_in_use "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
  done

  return 1
}

prompt_for_gateway_port() {
  local preferred_port="$1"
  local suggested_ports=()
  local port
  local free_port
  local choice
  local custom_port

  suggested_ports+=("$preferred_port" 18080 18081 28080 38080 48080)

  log "Port ${preferred_port} is already in use on this system."

  if [ -t 0 ] && [ -t 1 ]; then
    printf '\n'
    printf 'Virtual Workstation needs a free host port for the web UI.\n'
    printf 'Choose one of these options:\n'

    local index=1
    for port in "${suggested_ports[@]}"; do
      if ! is_port_in_use "$port"; then
        printf '  %s) Use port %s\n' "$index" "$port"
        index=$((index + 1))
      fi
    done

    printf '  %s) Enter a custom port\n' "$index"
    printf '\n'

    while true; do
      printf 'Selection: '
      read -r choice

      if [ -z "$choice" ]; then
        free_port="$(find_first_free_port "${suggested_ports[@]}")" || true
        [ -n "$free_port" ] || fail "No suggested free ports are available. Set API_GATEWAY_PORT manually and rerun."
        API_GATEWAY_PORT_VALUE="$free_port"
        return
      fi

      index=1
      for port in "${suggested_ports[@]}"; do
        if ! is_port_in_use "$port"; then
          if [ "$choice" = "$index" ]; then
            API_GATEWAY_PORT_VALUE="$port"
            return
          fi
          index=$((index + 1))
        fi
      done

      if [ "$choice" = "$index" ]; then
        while true; do
          printf 'Enter a custom port: '
          read -r custom_port
          printf '%s' "$custom_port" | grep -Eq '^[0-9]+$' || {
            printf 'Please enter a numeric port.\n'
            continue
          }
          if [ "$custom_port" -lt 1 ] || [ "$custom_port" -gt 65535 ]; then
            printf 'Please enter a port between 1 and 65535.\n'
            continue
          fi
          if is_port_in_use "$custom_port"; then
            printf 'Port %s is already in use.\n' "$custom_port"
            continue
          fi
          API_GATEWAY_PORT_VALUE="$custom_port"
          return
        done
      fi

      printf 'Invalid selection.\n'
    done
  fi

  free_port="$(find_first_free_port "${suggested_ports[@]}")" || true
  [ -n "$free_port" ] || fail "Port ${preferred_port} is in use and no automatic fallback port was found. Set API_GATEWAY_PORT manually and rerun."
  API_GATEWAY_PORT_VALUE="$free_port"
  log "Using fallback port ${API_GATEWAY_PORT_VALUE}."
}

resolve_gateway_port() {
  if is_port_in_use "$API_GATEWAY_PORT_VALUE"; then
    prompt_for_gateway_port "$API_GATEWAY_PORT_VALUE"
  fi
}

retry_after_compose_port_conflict() {
  local compose_output="$1"
  local conflicted_port

  conflicted_port="$(
    printf '%s\n' "$compose_output" |
      sed -n 's/.*Bind for 0\.0\.0\.0:\([0-9][0-9]*\) failed: port is already allocated.*/\1/p' |
      tail -n 1
  )"

  [ -n "$conflicted_port" ] || return 1

  API_GATEWAY_PORT_VALUE="$conflicted_port"
  prompt_for_gateway_port "$API_GATEWAY_PORT_VALUE"
  initialize_env_file
  return 0
}

start_stack() {
  local compose_output

  while true; do
    log "Starting Docker services"

    if compose_output="$(
      cd "$INSTALL_DIR" &&
        "${COMPOSE_CMD[@]}" up -d --build 2>&1
    )"; then
      printf '%s\n' "$compose_output"
      return 0
    fi

    printf '%s\n' "$compose_output" >&2

    if retry_after_compose_port_conflict "$compose_output"; then
      log "Retrying with API gateway port ${API_GATEWAY_PORT_VALUE}"
      continue
    fi

    fail "Docker Compose startup failed"
  done
}

upsert_env_file() {
  local file_path="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$file_path" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file_path"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file_path"
  fi
}

download_source_tree() {
  local tmp_dir="$1"
  local archive_path="$tmp_dir/source.tar.gz"

  log "Downloading ${REPO_OWNER}/${REPO_NAME}@${REPO_REF}"
  curl -fsSL "$REPO_ARCHIVE_URL" -o "$archive_path"

  mkdir -p "$tmp_dir/extracted"
  tar -xzf "$archive_path" -C "$tmp_dir/extracted"

  local extracted_root
  extracted_root="$(find "$tmp_dir/extracted" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$extracted_root" ] || fail "Unable to locate extracted repository contents"

  mkdir -p "$INSTALL_DIR"
  cp -a "$extracted_root"/. "$INSTALL_DIR"/
}

initialize_env_file() {
  local env_file="$INSTALL_DIR/.env"

  if [ ! -f "$env_file" ]; then
    if [ -f "$INSTALL_DIR/.env.example" ]; then
      cp "$INSTALL_DIR/.env.example" "$env_file"
    else
      : >"$env_file"
    fi
  fi

  upsert_env_file "$env_file" "API_GATEWAY_PORT" "$API_GATEWAY_PORT_VALUE"
  upsert_env_file "$env_file" "AUTH_TOKEN_SECRET" "$AUTH_TOKEN_SECRET_VALUE"
}

main() {
  need_command curl
  need_command tar
  need_command cp
  need_command sed
  need_command grep
  need_command find

  if [ "$SKIP_DOCKER_CHECK" != "1" ]; then
    need_command docker
    docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable for the current user"
    detect_compose_cmd
  fi

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR:-}"' EXIT

  download_source_tree "$TMP_DIR"
  resolve_gateway_port
  initialize_env_file

  log "Installed source into $INSTALL_DIR"

  if [ "$START_STACK" = "1" ]; then
    [ "${#COMPOSE_CMD[@]}" -gt 0 ] || detect_compose_cmd
    start_stack
    log "Virtual Workstation is starting at http://localhost:${API_GATEWAY_PORT_VALUE}"
  else
    log "Skipping Docker startup because START_STACK=${START_STACK}"
  fi

  log "Done"
}

main "$@"
