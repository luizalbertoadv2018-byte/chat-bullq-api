#!/usr/bin/env bash
# Publica a API e/ou o web no Coolify e espera o contêiner novo subir.
#
#   bash scripts/publicar.sh api | web | ambos
#
# Lê ../../.coolify.env (pasta chat-bullq, fora dos repositórios) ou o
# caminho em COOLIFY_ENV. O token tem "|", por isso não dá `source` no arquivo.
# O token só precisa da permissão "deploy": a espera é conferida por SSH na
# VPS (a tag da imagem do contêiner é o SHA do commit publicado).
set -euo pipefail

alvo="${1:-}"
case "$alvo" in api|web|ambos) ;; *) echo "uso: $0 api|web|ambos" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
raiz="$here/../.."
envfile="${COOLIFY_ENV:-$raiz/.coolify.env}"
[ -f "$envfile" ] || { echo "não achei $envfile" >&2; exit 1; }
val() { grep "^$1=" "$envfile" | cut -d= -f2- | tr -d '\r'; }

url="$(val COOLIFY_URL)"
token="$(val COOLIFY_TOKEN)"
ssh_key="${SSH_KEY:-$HOME/.ssh/bullq_ed25519}"
vps="root@srv1880778.hstgr.cloud"

publicar() {
  local nome="$1" uuid="$2" repo="$3"
  git -C "$repo" fetch -q origin
  local sha
  sha="$(git -C "$repo" rev-parse origin/main)"
  echo "→ publicando $nome (${sha:0:7})"
  resp="$(curl -s -X POST -H "Authorization: Bearer $token" "$url/api/v1/deploy?uuid=$uuid")"
  case "$resp" in *queued*) echo "  na fila" ;; *) echo "  falhou: $resp" >&2; return 1 ;; esac

  for _ in $(seq 1 60); do
    sleep 10
    if ssh -i "$ssh_key" -o BatchMode=yes "$vps" \
      "docker ps --format '{{.Image}} {{.Status}}' | grep '^$uuid:$sha' | grep -q healthy"; then
      echo "  ok: $nome no ar"
      return 0
    fi
  done
  echo "  ainda não subiu após 10 min; confira no painel do Coolify" >&2
  return 1
}

if [ "$alvo" = api ] || [ "$alvo" = ambos ]; then
  publicar api "$(val COOLIFY_APP_API)" "$raiz/chat-bullq-api"
fi
if [ "$alvo" = web ] || [ "$alvo" = ambos ]; then
  publicar web "$(val COOLIFY_APP_WEB)" "$raiz/chat-bullq-web"
fi
