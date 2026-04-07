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
  initialize_env_file

  log "Installed source into $INSTALL_DIR"

  if [ "$START_STACK" = "1" ]; then
    [ "${#COMPOSE_CMD[@]}" -gt 0 ] || detect_compose_cmd
    log "Starting Docker services"
    (
      cd "$INSTALL_DIR"
      "${COMPOSE_CMD[@]}" up -d --build
    )
    log "Virtual Workstation is starting at http://localhost:${API_GATEWAY_PORT_VALUE}"
  else
    log "Skipping Docker startup because START_STACK=${START_STACK}"
  fi

  log "Done"
}

main "$@"
