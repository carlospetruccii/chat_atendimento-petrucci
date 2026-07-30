#!/usr/bin/env bash
# Roda o backfill das mensagens que o outro sistema (contabilidade) enviou pela
# mesma instância uazapi e que o webhook descartava.
#
# A credencial NÃO fica no arquivo: é lida na hora com a CLI da Supabase (que já
# está logada e linkada). Nada de colar chave em snippet.
#
# Uso:
#   scripts/backfill-mensagens-externas.sh                 # simulação (não grava)
#   scripts/backfill-mensagens-externas.sh --aplicar       # grava de verdade
#   scripts/backfill-mensagens-externas.sh --dias 30       # janela maior (máx 90)
#
# Pagina sozinho até acabar. Ao final imprime o total.

set -euo pipefail

PROJECT_REF="hfcfkxozzbrzzrejtbdj"
FUNCAO="backfill-mensagens-externas"
DIAS=7
LOTE=25
DRY_RUN=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aplicar) DRY_RUN=false; shift ;;
    --dias)    DIAS="${2:?--dias precisa de um número}"; shift 2 ;;
    --lote)    LOTE="${2:?--lote precisa de um número}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

command -v supabase >/dev/null || { echo "CLI da Supabase não encontrada" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq não encontrado (sudo apt install jq)" >&2; exit 1; }

# Credenciais: a anon key passa o portão de JWT da Supabase (é pública), e o
# BACKFILL_SECRET é o que de fato autoriza. O secret vive no .env (fora do git)
# e no `supabase secrets` — nunca no código.
if [[ -z "${BACKFILL_SECRET:-}" && -f .env ]]; then
  BACKFILL_SECRET="$(grep -m1 '^BACKFILL_SECRET=' .env | cut -d= -f2-)"
fi
[[ -n "${BACKFILL_SECRET:-}" ]] || {
  echo "BACKFILL_SECRET ausente (defina no .env ou no ambiente)" >&2; exit 1; }

echo "Lendo credencial pública do projeto ${PROJECT_REF}…"
KEY="$(supabase projects api-keys --project-ref "$PROJECT_REF" -o json \
  | jq -r '.[] | select(.name == "anon") | .api_key')"
[[ -n "$KEY" && "$KEY" != "null" ]] || { echo "não consegui ler a anon key" >&2; exit 1; }

URL="https://${PROJECT_REF}.supabase.co/functions/v1/${FUNCAO}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "MODO SIMULAÇÃO — nada será gravado. Use --aplicar para valer."
else
  echo "MODO REAL — vai gravar em mensagens."
fi
echo "Janela: últimos ${DIAS} dias | lote: ${LOTE} clientes"
echo

offset=0
tot_enc=0
tot_ins=0
tot_pul=0
tot_err=0
pagina=1

while :; do
  resp="$(curl -sS -X POST "$URL" \
    -H "Authorization: Bearer ${KEY}" \
    -H "x-backfill-secret: ${BACKFILL_SECRET}" \
    -H "content-type: application/json" \
    -d "{\"dias\":${DIAS},\"limite_clientes\":${LOTE},\"offset\":${offset},\"dry_run\":${DRY_RUN}}")"

  if [[ "$(jq -r '.ok // false' <<<"$resp")" != "true" ]]; then
    echo "FALHOU na página ${pagina}:" >&2
    jq . <<<"$resp" >&2 || echo "$resp" >&2
    exit 1
  fi

  enc=$(jq -r '.encontradas'        <<<"$resp")
  ins=$(jq -r '.inseridas'          <<<"$resp")
  pul=$(jq -r '.puladas'            <<<"$resp")
  err=$(jq -r '.erros'              <<<"$resp")
  cli=$(jq -r '.clientes_analisados'<<<"$resp")
  tot=$(jq -r '.clientes_no_periodo'<<<"$resp")
  prox=$(jq -r '.proximo_offset'    <<<"$resp")
  mais=$(jq -r '.tem_mais'          <<<"$resp")

  printf 'página %-3s clientes %3s/%-4s  encontradas %-4s  a gravar %-4s  puladas %-4s  erros %s\n' \
    "$pagina" "$cli" "$tot" "$enc" "$ins" "$pul" "$err"

  jq -r '.detalhes[]? | select(.erro) | "   erro no cliente \(.client_id): \(.erro)"' <<<"$resp"

  tot_enc=$((tot_enc + enc)); tot_ins=$((tot_ins + ins))
  tot_pul=$((tot_pul + pul)); tot_err=$((tot_err + err))

  [[ "$mais" == "true" && "$cli" -gt 0 ]] || break
  offset="$prox"
  pagina=$((pagina + 1))
done

echo
echo "──────────────────────────────────────────"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "SIMULAÇÃO: ${tot_ins} mensagens seriam gravadas"
  echo "Para aplicar: scripts/backfill-mensagens-externas.sh --aplicar --dias ${DIAS}"
else
  echo "GRAVADAS: ${tot_ins} mensagens"
fi
echo "encontradas ${tot_enc} | puladas (já existiam) ${tot_pul} | erros ${tot_err}"
