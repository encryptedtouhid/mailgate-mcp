#!/bin/bash
#
# Frees the configured port, installs dependencies, builds, and starts the
# email MCP server in HTTP mode.
#
# Usage:
#   ./run.sh            start on http://127.0.0.1:$PORT/mcp
#   ./run.sh --tunnel   also open a public HTTPS URL via cloudflared
#                       (for ChatGPT and claude.ai custom connectors)

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="${ROOT_DIR}/.env"
readonly TUNNEL_LOG="${ROOT_DIR}/.tunnel.log"

TUNNEL_PID=""

err() {
  echo "error: $*" >&2
}

info() {
  echo "==> $*"
}

# Prints the last value of KEY in .env, without surrounding quotes.
env_value() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2-)" || true
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  echo "${value}"
}

check_env() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    err ".env not found. Copy .env.example to .env and fill in your mailbox."
    exit 1
  fi
  if [[ -n "$(env_value EMAIL_ACCOUNTS_FILE)" ]]; then
    return
  fi
  local address password
  address="$(env_value EMAIL_ADDRESS)"
  password="$(env_value EMAIL_PASSWORD)"
  if [[ -z "${address}" || "${address}" == "you@yourdomain.com" \
      || -z "${password}" || "${password}" == "your-password-or-app-password" ]]; then
    err "Set EMAIL_ADDRESS and EMAIL_PASSWORD in ${ENV_FILE} first."
    exit 1
  fi
}

# Generates MCP_AUTH_TOKEN in .env when it is blank.
ensure_token() {
  if [[ -n "$(env_value MCP_AUTH_TOKEN)" ]]; then
    return
  fi
  local token
  token="$(openssl rand -hex 32)"
  if grep -qE '^MCP_AUTH_TOKEN=' "${ENV_FILE}"; then
    sed -i '' -e "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=${token}/" "${ENV_FILE}"
  else
    echo "MCP_AUTH_TOKEN=${token}" >> "${ENV_FILE}"
  fi
  info "Generated a new MCP_AUTH_TOKEN in .env"
}

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN || true)"
  if [[ -z "${pids}" ]]; then
    return
  fi
  info "Stopping process(es) on port ${port}: ${pids//$'\n'/ }"
  # Word splitting is intended: one PID per word.
  kill ${pids} 2> /dev/null || true
  local i
  for i in {1..10}; do
    if [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN || true)" ]]; then
      return
    fi
    sleep 0.5
  done
  kill -9 ${pids} 2> /dev/null || true
}

start_tunnel() {
  local port="$1"
  if ! command -v cloudflared > /dev/null; then
    err "cloudflared is not installed (brew install cloudflared)."
    exit 1
  fi
  : > "${TUNNEL_LOG}"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" \
    > "${TUNNEL_LOG}" 2>&1 &
  TUNNEL_PID=$!
  info "Waiting for the tunnel URL..."
  local url="" i
  for i in {1..60}; do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG}" \
      | head -n 1)" || true
    if [[ -n "${url}" ]]; then
      break
    fi
    sleep 0.5
  done
  if [[ -z "${url}" ]]; then
    err "Tunnel did not start. See ${TUNNEL_LOG}"
    exit 1
  fi
  echo
  echo "  Connector URL (paste into ChatGPT / claude.ai; keep it secret):"
  echo "  ${url}/mcp/$(env_value MCP_AUTH_TOKEN)"
  echo
}

cleanup() {
  if [[ -n "${TUNNEL_PID}" ]]; then
    kill "${TUNNEL_PID}" 2> /dev/null || true
  fi
}

main() {
  local use_tunnel=false
  case "${1:-}" in
    --tunnel) use_tunnel=true ;;
    "") ;;
    *)
      err "unknown option: $1 (usage: ./run.sh [--tunnel])"
      exit 1
      ;;
  esac

  cd "${ROOT_DIR}"
  check_env
  ensure_token

  local port
  port="$(env_value PORT)"
  port="${port:-3000}"

  free_port "${port}"

  info "Installing dependencies"
  npm install --no-audit --no-fund --loglevel=error

  info "Building"
  npm run build --silent

  trap cleanup EXIT
  if [[ "${use_tunnel}" == true ]]; then
    start_tunnel "${port}"
  else
    echo
    echo "  Local URL: http://127.0.0.1:${port}/mcp/$(env_value MCP_AUTH_TOKEN)"
    echo "  Run ./run.sh --tunnel for a public HTTPS URL."
    echo
  fi

  info "Starting mailgate-mcp (Ctrl+C to stop)"
  node dist/index.js --http
}

main "$@"
