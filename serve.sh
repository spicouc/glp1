#!/usr/bin/env bash
# Servidor de desenvolupament/ús local — accessible des de tota la xarxa.
#
#   ./serve.sh              # 0.0.0.0:8099 (totes les interfícies)
#   PORT=9000 ./serve.sh    # altre port
#   BIND=192.168.1.146 ./serve.sh   # només una interfície concreta

set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8099}"
BIND="${BIND:-0.0.0.0}"

# --- adreces accessibles -------------------------------------------------
print_urls() {
  echo ""
  echo "  Seguiment GLP-1 / GIP — accessible des de la xarxa"
  echo "  ───────────────────────────────────────────────────"
  # Interfícies IPv4 globals, excloent els ponts de Docker
  local rows ip ifc
  rows="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); if ($2 !~ /^(docker|br-)/) print $2, a[1]}')"
  if [ -n "$rows" ]; then
    while read -r ifc ip; do
      echo "    http://${ip}:${PORT}/   (${ifc})"
    done <<< "$rows"
  else
    for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'); do
      echo "    http://${ip}:${PORT}/"
    done
  fi
  echo "    http://127.0.0.1:${PORT}/        (aquest mateix ordinador)"
  echo ""
  echo "  Obre qualsevol d'aquests des del mòbil, tauleta o ordinador de la xarxa."
  echo "  Les dades es desen al navegador de cada dispositiu (localStorage)."
  echo "  Atura'l amb Ctrl+C."
  echo ""
}

print_urls

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: cal python3 per executar el servidor." >&2
  exit 1
fi

exec python3 -m http.server "$PORT" --bind "$BIND"
