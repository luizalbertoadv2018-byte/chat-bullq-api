-- CPF do contato (só dígitos). Capturado automaticamente quando o cliente
-- manda o número na conversa, ou preenchido à mão. Serve de chave EXATA para
-- casar o contato com o cliente no Tramitação Inteligente (sem duplicar).
-- Idempotente (IF NOT EXISTS): em ambientes onde a coluna já veio via
-- `prisma db push`, o migrate deploy não quebra.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "cpf" TEXT;
CREATE INDEX IF NOT EXISTS "idx_contact_org_cpf" ON "contacts" ("organization_id", "cpf");
