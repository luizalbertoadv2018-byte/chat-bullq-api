# Como trabalhar no Chat BullQ

Guia para mexer no app a partir de qualquer computador (casa ou escritório).

## Peças

| Peça | Repositório | Onde roda |
|---|---|---|
| API (NestJS + Prisma) | `github.com/luizalbertoadv2018-byte/chat-bullq-api` | https://api.albertomartinsadv.com.br |
| Web (Next.js) | `github.com/luizalbertoadv2018-byte/chat-bullq-web` | https://app.albertomartinsadv.com.br |
| WhatsApp | Evolution API v2.3.7 (contêiner `evolution-api` na VPS) | interno: `http://evolution-api:8080` |

VPS Hostinger `srv1880778.hstgr.cloud`, gerenciada pelo Coolify (painel na porta 8000).
A tag da imagem de cada contêiner é o SHA do commit publicado.

## Montar o computador (uma vez)

```bash
mkdir -p ~/chat-bullq && cd ~/chat-bullq
git clone https://github.com/luizalbertoadv2018-byte/chat-bullq-api.git
git clone https://github.com/luizalbertoadv2018-byte/chat-bullq-web.git
cd chat-bullq-api && corepack yarn install && cd ..
cd chat-bullq-web && corepack yarn install && cd ..
```

Crie `~/chat-bullq/.coolify.env` (FORA dos repositórios, nunca versionar):

```
COOLIFY_URL=http://srv1880778.hstgr.cloud:8000
COOLIFY_TOKEN=<token com permissão deploy, criado em Keys & Tokens>
COOLIFY_APP_API=<uuid do app chat-bullq-api>
COOLIFY_APP_WEB=<uuid do app chat-bullq-web>
```

Cada computador pode ter o seu token; revogar um não afeta o outro.

## Fluxo de cada alteração

1. **Atualizar antes de começar** (o outro computador pode ter publicado):
   ```bash
   git -C chat-bullq-api switch main && git -C chat-bullq-api pull --ff-only
   git -C chat-bullq-web switch main && git -C chat-bullq-web pull --ff-only
   ```
2. **Alterar** num ramo: `git switch -c feat/<nome>`.
3. **Conferir**:
   - API: `npx tsc --noEmit -p .` e `npx jest <arquivo.spec.ts>`
   - Web: `npx tsc --noEmit -p .` e `corepack yarn build`
4. **Cuidado com o `yarn.lock`**: o Yarn 1 deste fluxo reescreve o arquivo.
   Antes de commitar: `git checkout -- yarn.lock` (e `next-env.d.ts` no web).
5. **Enviar**: juntar na `main` e `git push origin main`.
6. **Publicar**: `bash chat-bullq-api/scripts/publicar.sh api` (ou `web`, ou `ambos`).
   Sempre a API antes do web quando os dois mudarem.

Push na `main` **não** publica sozinho: o passo 6 é obrigatório.

## Rodar localmente

A API precisa de Postgres, Redis e MinIO (veja `.env.example`). Sem Docker no
computador, não rode a API local; confira com `tsc`/testes e valide em produção
com um contato de teste. Nunca aponte uma API local para o banco de produção.

## Agentes de IA

Os roteiros (system prompt) ficam no banco, editados pela tela **Agentes de IA**.
A cópia de referência, versionada, fica em [`docs/agentes/`](agentes/). Ao mudar
um roteiro na tela, atualize o arquivo correspondente aqui também.

## Botão "Gerar contrato"

- Web: `src/features/inbox/components/contract-popover.tsx`.
- API: `POST /conversations/:id/ai/start-contract` e
  `GET /conversations/:id/ai/contract-templates` (`conversations.service.ts`).
- A ordem de fechar fica em `contact.metadata.fechamentoManual` e entra no
  ESTADO DO CASO (`runner/case-state.service.ts`), no prompt de sistema.
  Não mande instruções pelo turno do usuário: a camada de segurança trata como
  possível injeção do cliente.
