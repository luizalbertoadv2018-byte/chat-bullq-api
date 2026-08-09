-- Checklist de documentos por benefício (pipeline). A IA usa pra cobrar o que
-- falta; o "recebido" fica em contact.metadata.documentos. Idempotente.
CREATE TABLE IF NOT EXISTS "documentos_beneficio" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "documentos_beneficio_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_docbenef_org_pipeline"
    ON "documentos_beneficio"("organization_id", "pipeline_id");

DO $$ BEGIN
  ALTER TABLE "documentos_beneficio"
    ADD CONSTRAINT "documentos_beneficio_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "documentos_beneficio"
    ADD CONSTRAINT "documentos_beneficio_pipeline_id_fkey"
    FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
