-- AlterTable: roteamento determinístico por palavra-chave no agent
ALTER TABLE "ai_agents"
  ADD COLUMN "trigger_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
