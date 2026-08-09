-- Situação de negócio da conversa, configurável por organização (rótulo puro,
-- não interfere no status/FSM/IA). Gerenciada em Configurações → Situações.
-- IF NOT EXISTS por segurança (ambientes onde já veio via prisma db push).

CREATE TABLE IF NOT EXISTS "conversation_situacoes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_situacoes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_situacoes_organization_id_name_key"
    ON "conversation_situacoes"("organization_id", "name");
CREATE INDEX IF NOT EXISTS "idx_situacao_org"
    ON "conversation_situacoes"("organization_id");

DO $$ BEGIN
  ALTER TABLE "conversation_situacoes"
    ADD CONSTRAINT "conversation_situacoes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "situacao_id" TEXT;
CREATE INDEX IF NOT EXISTS "idx_conv_situacao" ON "conversations"("situacao_id");

DO $$ BEGIN
  ALTER TABLE "conversations"
    ADD CONSTRAINT "conversations_situacao_id_fkey"
    FOREIGN KEY ("situacao_id") REFERENCES "conversation_situacoes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
