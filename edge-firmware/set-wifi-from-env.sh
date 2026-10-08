#!/usr/bin/env bash
# set-wifi-from-env.sh — Injects WiFi credentials from .env into sdkconfig.
#
# Usage (from the repo root OR from edge-firmware/):
#   ./edge-firmware/set-wifi-from-env.sh
#   # or from inside edge-firmware/:
#   ./set-wifi-from-env.sh
#
# What it does:
#   1. Reads SSID_NAME and SSID_PASSWORD from edge-firmware/.env
#   2. Strips enclosing quotes (single or double), trailing CR, and
#      surrounding whitespace from each value.
#   3. Idempotently writes/replaces CONFIG_UGP_WIFI_SSID and
#      CONFIG_UGP_WIFI_PASSWORD in edge-firmware/sdkconfig using a
#      grep-and-append approach (no sed replacement — handles backslashes
#      and double-quote characters in passwords safely).
#   4. Does NOT print the password.
#
# Prerequisites:
#   - edge-firmware/.env must contain SSID_NAME=... and SSID_PASSWORD=...
#   - edge-firmware/sdkconfig must already exist (idf.py creates it on first
#     `idf.py set-target esp32` or `idf.py menuconfig`).
#     If missing, run: cd edge-firmware && idf.py set-target esp32
#
# sdkconfig is listed in .gitignore — credentials never reach git.

set -euo pipefail

# ── Resolve paths relative to this script's location ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
SDK_CONFIG="${SCRIPT_DIR}/sdkconfig"

# ── Helper: strip enclosing quotes, trailing CR, surrounding whitespace ────
#
# strip_value INPUT
#   Prints the cleaned string to stdout.  Caller does:
#     MYVAR="$(strip_value "${MYVAR}")"
#
#   Steps (in order):
#     1. Strip leading/trailing ASCII space and tab.
#     2. Strip a trailing \r (CRLF line endings from Windows .env files).
#        This MUST happen before quote detection: a value like 'YourHotspotSSID'\r
#        ends in \r, not a quote, so the quote-strip pattern would not match
#        and the literal quotes would survive into sdkconfig.
#     3. Strip a single pair of enclosing quotes ('' or "") — ONLY if both
#        the first and last characters are the same quote character.
#
# Mental verification for SSID_NAME='YourHotspotSSID'\r\n read by `read -r`:
#   raw value after IFS= read:  'YourHotspotSSID'\r
#   after step 1 (trim spaces): 'YourHotspotSSID'\r   (no change)
#   after step 2 (strip \r):    'YourHotspotSSID'
#   after step 3 (strip quotes): YourHotspotSSID      ✓
#
# Implemented with pure bash parameter expansion; no external tools.
strip_value() {
  local v="${1}"

  # 1. Trim leading spaces/tabs
  v="${v#"${v%%[! $'\t']*}"}"
  # 1b. Trim trailing spaces/tabs
  v="${v%"${v##*[! $'\t']}"}"

  # 2. Strip trailing carriage return (CRLF) — BEFORE quote detection.
  v="${v%$'\r'}"

  # 3. Strip one pair of enclosing single quotes
  if [[ ${#v} -ge 2 && "${v:0:1}" == "'" && "${v: -1}" == "'" ]]; then
    v="${v:1:${#v}-2}"
  # 3b. Strip one pair of enclosing double quotes
  elif [[ ${#v} -ge 2 && "${v:0:1}" == '"' && "${v: -1}" == '"' ]]; then
    v="${v:1:${#v}-2}"
  fi

  printf '%s' "${v}"
}

# ── Load .env ──────────────────────────────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: .env not found at ${ENV_FILE}" >&2
  exit 1
fi

# Parse only the two required keys — avoid running arbitrary code in .env.
# Read raw lines so that IFS splitting does not eat the value side.
SSID_NAME=""
SSID_PASSWORD=""

while IFS= read -r line || [[ -n "${line}" ]]; do
  # Skip blank lines and comments
  [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue

  # Split on first '=' only (handles passwords containing '=')
  local_key="${line%%=*}"
  local_value="${line#*=}"

  # Strip whitespace from key
  local_key="${local_key//[[:space:]]/}"

  case "${local_key}" in
    SSID_NAME)
      SSID_NAME="$(strip_value "${local_value}")"
      ;;
    SSID_PASSWORD)
      SSID_PASSWORD="$(strip_value "${local_value}")"
      ;;
  esac
done < "${ENV_FILE}"

if [[ -z "${SSID_NAME}" ]]; then
  echo "ERROR: SSID_NAME not found or empty in ${ENV_FILE}" >&2
  exit 1
fi
if [[ -z "${SSID_PASSWORD}" ]]; then
  echo "ERROR: SSID_PASSWORD not found or empty in ${ENV_FILE}" >&2
  exit 1
fi

# ── Check sdkconfig exists ─────────────────────────────────────────────────
if [[ ! -f "${SDK_CONFIG}" ]]; then
  echo "ERROR: sdkconfig not found at ${SDK_CONFIG}" >&2
  echo "  Run first: cd \"${SCRIPT_DIR}\" && idf.py set-target esp32" >&2
  exit 1
fi

# ── Kconfig/C-string escaping ──────────────────────────────────────────────
#
# Kconfig string values are written as:  KEY="value"
# The value is interpreted as a C string literal, so two characters must be
# escaped before wrapping in double quotes:
#   \  →  \\   (backslash must be doubled)
#   "  →  \"   (double-quote must be escaped)
#
# We apply these transformations with bash parameter expansion only (no sed),
# so that a password like  p\ss"w0rd  becomes  p\\ss\"w0rd  in sdkconfig.
kconfig_escape() {
  local val="${1}"
  # 1. Escape every backslash first (order matters: do this before escaping quotes)
  val="${val//\\/\\\\}"
  # 2. Escape every double-quote
  val="${val//\"/\\\"}"
  printf '%s' "${val}"
}

# ── Idempotent upsert of CONFIG lines ─────────────────────────────────────
#
# Strategy: filter the existing line out with grep -v, then append the new
# line.  This avoids sed replacement entirely, which is unsafe for values
# that contain '/', '&', or '\'.
#
# A temporary file is used so that a write failure never leaves sdkconfig
# half-written.
upsert_config() {
  local file="${1}"
  local key="${2}"
  local val="${3}"         # plain value (not yet escaped or quoted)

  local escaped
  escaped="$(kconfig_escape "${val}")"

  local tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"

  # Keep all lines except the existing key=... line, then append the new one.
  grep -v "^${key}=" "${file}" > "${tmp}" || true
  printf '%s="%s"\n' "${key}" "${escaped}" >> "${tmp}"

  # Atomic replace (same filesystem, so mv is atomic on POSIX).
  mv "${tmp}" "${file}"
}

upsert_config "${SDK_CONFIG}" "CONFIG_UGP_WIFI_SSID"     "${SSID_NAME}"
upsert_config "${SDK_CONFIG}" "CONFIG_UGP_WIFI_PASSWORD" "${SSID_PASSWORD}"

echo "✅  sdkconfig updated: CONFIG_UGP_WIFI_SSID and CONFIG_UGP_WIFI_PASSWORD set."
echo "   SSID: ${SSID_NAME}"
echo "   (password written to sdkconfig — NOT printed here)"
