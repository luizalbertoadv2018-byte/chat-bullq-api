-- Bloqueio de contato: quando `blocked` = true, o inbound é descartado
-- (sem conversa/mensagem/IA). `blocked_at` guarda quando foi bloqueado.
-- Idempotente (IF NOT EXISTS) por segurança: em ambientes onde as colunas
-- já foram aplicadas via `prisma db push`, o migrate deploy não quebra.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "blocked_at" TIMESTAMP(3);
