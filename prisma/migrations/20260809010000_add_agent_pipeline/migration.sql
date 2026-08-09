-- Pipeline de destino do agente: quando um agent de tema assume a conversa,
-- um card é criado no 1º estágio deste pipeline (auto-roteamento de lead novo).
-- Idempotente (IF NOT EXISTS) por segurança.
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "pipeline_id" TEXT;
CREATE INDEX IF NOT EXISTS "idx_ai_agent_pipeline" ON "ai_agents"("pipeline_id");

DO $$ BEGIN
  ALTER TABLE "ai_agents"
    ADD CONSTRAINT "ai_agents_pipeline_id_fkey"
    FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
