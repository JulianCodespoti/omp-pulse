#!/usr/bin/env bash
# Shared, source-safe discovery for deployment and endpoint selection.

pulse_target() {
  local unit=omp-pulse.service user_active=0 system_active=0 scope option exec_start exe argv token port port_count=0 i active_status
  local -a argv_words=()
  PULSE_SCOPE=
  PULSE_UNIT=
  PULSE_EXE=
  PULSE_PORT=
  PULSE_LOCAL=
  for scope in user system; do
    option=()
    [[ $scope == user ]] && option=(--user)
    if systemctl "${option[@]}" is-active --quiet "$unit" 2>/dev/null; then
      active_status=0
    else
      active_status=$?
    fi
    case "$active_status" in
      0)
        if [[ $scope == user ]]; then user_active=1; else system_active=1; fi
        ;;
      3|4) ;;
      *)
        printf 'pulse-target: cannot query %s %s active state (systemctl exit %s)\n' "$scope" "$unit" "$active_status" >&2
        return 1
        ;;
    esac
  done

  if (( user_active + system_active != 1 )); then
    if (( user_active && system_active )); then
      printf 'pulse-target: both user and system %s units are active; refusing ambiguity\n' "$unit" >&2
    else
      printf 'pulse-target: neither user nor system %s unit is active\n' "$unit" >&2
    fi
    return 1
  fi
  if (( user_active )); then scope=user; option=(--user); else scope=system; option=(); fi

  exec_start=$(systemctl "${option[@]}" show "$unit" --property=ExecStart --value 2>/dev/null) || {
    printf 'pulse-target: cannot inspect active %s %s ExecStart\n' "$scope" "$unit" >&2
    return 1
  }
  if [[ ! $exec_start =~ path=(.*)[[:space:]]\;[[:space:]]argv\[\]=([^\;]*) ]]; then
    printf 'pulse-target: cannot parse active %s %s ExecStart safely\n' "$scope" "$unit" >&2
    return 1
  fi
  exe=${BASH_REMATCH[1]}
  argv=${BASH_REMATCH[2]}
  if [[ $exe != /* || ! -x $exe ]]; then
    printf 'pulse-target: active %s %s executable is not an absolute executable file\n' "$scope" "$unit" >&2
    return 1
  fi

  # systemctl renders ExecStart as argv tokens. Never evaluate that display as
  # shell code; only accept one literal decimal --port argument.
  read -r -a argv_words <<<"$argv"
  for ((i=0; i<${#argv_words[@]}; i++)); do
    token=${argv_words[i]}
    case "$token" in
      --port=*)
        ((port_count+=1))
        port=${token#--port=}
        ;;
      --port)
        ((port_count+=1))
        (( i + 1 < ${#argv_words[@]} )) || port=
        if (( i + 1 < ${#argv_words[@]} )); then port=${argv_words[i+1]}; fi
        ;;
    esac
  done
  if (( port_count != 1 )) || [[ ! $port =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
    printf 'pulse-target: active %s %s must have exactly one valid literal --port argument\n' "$scope" "$unit" >&2
    return 1
  fi

  PULSE_SCOPE=$scope
  PULSE_UNIT=$unit
  PULSE_EXE=$exe
  PULSE_PORT=$((10#$port))
  PULSE_LOCAL="http://127.0.0.1:$PULSE_PORT"
  export PULSE_SCOPE PULSE_UNIT PULSE_EXE PULSE_PORT PULSE_LOCAL
}

# Validate and canonicalize the configured origin, then add the sole supported
# application path. Python's stdlib parser handles bracketed IPv6 correctly.
_pulse_normalize_endpoint() {
  python3 - "$1" <<'PY'
import ipaddress
import re
import sys
from urllib.parse import urlsplit

value = sys.argv[1]
try:
    if any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "https" or not parsed.netloc or parsed.username is not None or parsed.password is not None:
        raise ValueError
    if any(char in value for char in "?#@"):
        raise ValueError
    if parsed.query or parsed.fragment or parsed.path not in ("", "/", "/app", "/app/"):
        raise ValueError
    host = parsed.hostname
    parsed_port = parsed.port
    port = 443 if parsed_port is None else parsed_port
    if not host or not 1 <= port <= 65535 or "%" in host:
        raise ValueError
    host = host.lower()
    if host.endswith(".") or host == "localhost" or host.endswith((".localhost", ".local", ".localdomain")):
        raise ValueError
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if re.fullmatch(r"[0-9.]+", host):
            raise ValueError
        if len(host) > 253 or not re.fullmatch(r"[a-z0-9.-]+", host):
            raise ValueError
        labels = host.split(".")
        if any(not label or len(label) > 63 or label[0] == "-" or label[-1] == "-" for label in labels):
            raise ValueError
        if labels[-1].isdigit() or labels[-1].startswith("0x"):
            raise ValueError
    else:
        mapped = getattr(address, "ipv4_mapped", None)
        if address.is_loopback or address.is_unspecified or (mapped and (mapped.is_loopback or mapped.is_unspecified)):
            raise ValueError
    authority = f"[{host}]" if ":" in host else host
    if port != 443:
        authority += f":{port}"
    print(f"https://{authority}")
except (ValueError, UnicodeError):
    print("pulse-target: invalid HTTPS endpoint (expected an HTTPS origin or /app/ URL)", file=sys.stderr)
    sys.exit(1)
PY
}

pulse_endpoint() {
  local candidate=${OMP_PULSE_SERVER_URL:-${OMP_PULSE_FUNNEL:-}} origin serve_json match_output previous_serve_host=${PULSE_SERVE_HOST:-}
  local -a matches=()
  PULSE_SERVE_HOST=
  PULSE_ORIGIN=
  PULSE_URL=

  if [[ -n $candidate ]]; then
    origin=$(_pulse_normalize_endpoint "$candidate") || return 1
    if [[ $previous_serve_host == "${origin#https://}" &&
          ( $previous_serve_host == *.ts.net || $previous_serve_host == *.ts.net:* ) ]]; then
      PULSE_SERVE_HOST=$previous_serve_host
    fi
  else
    pulse_target || {
      printf 'pulse-target: set OMP_PULSE_SERVER_URL to build without an active service\n' >&2
      return 1
    }
    command -v tailscale >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || {
      printf 'pulse-target: tailscale and jq are required for Serve endpoint discovery\n' >&2
      return 1
    }
    serve_json=$(tailscale serve status --json) || {
      printf 'pulse-target: cannot read Tailscale Serve configuration\n' >&2
      return 1
    }
    match_output=$(jq -r --arg port "$PULSE_PORT" '
      [ . as $config
        | (.Web // {}) | to_entries[] as $site
        | ($site.key | capture("^(?<host>[A-Za-z0-9.-]+):(?<httpsPort>[0-9]+)$")) as $address
        | select(($site.value.Handlers // {})["/"]? | .Proxy? | type == "string")
        | select(($site.value.Handlers["/"].Proxy) | test("^http://(127\\.0\\.0\\.1|localhost):" + $port + "/?$"; "i"))
        | select(($config.TCP // {})[$address.httpsPort].HTTPS // false)
        | "https://" + $address.host + (if $address.httpsPort == "443" then "" else ":" + $address.httpsPort end)
      ] | unique | .[]' <<<"$serve_json") || {
      printf 'pulse-target: cannot parse Tailscale Serve HTTPS roots\n' >&2
      return 1
    }
    if [[ -n $match_output ]]; then mapfile -t matches <<<"$match_output"; fi
    if (( ${#matches[@]} != 1 )); then
      printf 'pulse-target: expected exactly one HTTPS Serve root proxy for port %s\n' "$PULSE_PORT" >&2
      return 1
    fi
    origin=$(_pulse_normalize_endpoint "${matches[0]}") || return 1
    PULSE_SERVE_HOST=${origin#https://}
  fi

  PULSE_ORIGIN=$origin
  PULSE_URL="$origin/app/"
  export PULSE_ORIGIN PULSE_URL PULSE_SERVE_HOST
}

# Keep the certificate hostname in curl's URL while optionally routing a
# discovered Tailscale name to this machine's tailnet address.
pulse_curl() {
  local url authority host port ip
  (($#)) || { printf 'pulse-target: pulse_curl requires curl arguments and a URL\n' >&2; return 2; }
  url=${!#}
  if [[ $url =~ ^https://([^/]+)(/.*)?$ ]]; then
    authority=${BASH_REMATCH[1]}
    host=${authority%%:*}
    port=443
    [[ $authority == *:* ]] && port=${authority##*:}
    if [[ $host == *.ts.net && $authority == "${PULSE_SERVE_HOST:-}" ]]; then
      command -v tailscale >/dev/null 2>&1 || {
        printf 'pulse-target: tailscale is required to reach a discovered .ts.net endpoint\n' >&2
        return 1
      }
      ip=$(tailscale ip -4) || return 1
      [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
        printf 'pulse-target: invalid Tailscale IPv4 address\n' >&2
        return 1
      }
      curl --resolve "$host:$port:$ip" "$@"
      return $?
    fi
  fi
  curl "$@"
}
