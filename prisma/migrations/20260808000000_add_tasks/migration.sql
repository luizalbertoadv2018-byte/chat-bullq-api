-- Setor de Tarefas do escritório (gestão de tarefas + vínculo opcional a
-- contato/conversa/responsável). DDL idempotente (IF NOT EXISTS / DO blocks)
-- porque a prod às vezes já foi sincronizada via `prisma db push`.

DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'DOING', 'DONE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "tasks" (
  "id"                 TEXT NOT NULL,
  "organization_id"    TEXT NOT NULL,
  "title"              TEXT NOT NULL,
  "description"        TEXT,
  "status"             "TaskStatus" NOT NULL DEFAULT 'TODO',
  "priority"           "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
  "category"           TEXT,
  "due_at"             TIMESTAMP(3),
  "completed_at"       TIMESTAMP(3),
  "contact_id"         TEXT,
  "conversation_id"    TEXT,
  "assigned_to_id"     TEXT,
  "created_by_id"      TEXT,
  "calendar_event_id"  TEXT,
  "calendar_html_link" TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  "deleted_at"         TIMESTAMP(3),
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_task_org_status_due" ON "tasks"("organization_id", "status", "due_at");
CREATE INDEX IF NOT EXISTS "idx_task_org_due" ON "tasks"("organization_id", "due_at");

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_id_fkey"
    FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
