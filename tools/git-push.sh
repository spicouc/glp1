#!/usr/bin/env bash
# Commit + push automàtic al final d'una tongada de feina.
#
#   npm run push                  → resum automàtic dels canvis
#   npm run push -- "Missatge"    → missatge propi
#
# No fa res si no hi ha canvis; surt amb error si el push falla.
set -euo pipefail
cd "$(dirname "$0")/.."

git add -A

if git diff --cached --quiet; then
  echo "✓ Res a commitar (tot ja està pujat)."
  exit 0
fi

if [ "$#" -gt 0 ]; then
  MSG="$*"
else
  files=$(git diff --cached --name-only | wc -l | tr -d ' ')
  stats=$(git diff --cached --shortstat | sed 's/^ //' || true)
  MSG="$(date '+%Y-%m-%d %H:%M') · ${files} fitxers · ${stats:-canvis}"
fi

git commit -q -m "$MSG"
echo "✓ Commit: $(git log -1 --oneline)"

if git push -q origin HEAD 2>/dev/null; then
  echo "✓ Push a origin/$(git rev-parse --abbrev-ref HEAD)"
else
  echo "✗ No s'ha pogut fer push (xarxa o credencials). El commit local es conserva:" >&2
  echo "    git push origin $(git rev-parse --abbrev-ref HEAD)" >&2
  exit 1
fi
