DO $$
DECLARE
  t text;
BEGIN
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    email text, phone text, timezone text, settings jsonb,
    "createdAt" timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS books (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, name text, source text,
    "wordCount" integer, "tierCount" integer, "listSize" integer,
    status text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS words (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    lemma text, ipa text, pos text,
    senses jsonb, examples jsonb,
    frequency numeric, tags jsonb,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS book_words (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "bookId" text, "wordId" text,
    "listNo" integer, "orderInList" integer,
    tier integer, "tierUpdatedAt" text, status text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS study_plans (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "bookId" text, "userId" text,
    "tierRounds" jsonb, "planMode" text,
    "startDate" text, "deadlineDate" text, "sprintStartDate" text,
    "dailyBudgetMin" integer, "avgHitSec" numeric, "gapMinDays" numeric,
    "modalRatio" jsonb, "masteryDecayEnabled" boolean,
    "tierRoundDays" jsonb,
    version integer, status text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS plan_rounds (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "planId" text, tier integer, "roundNo" integer,
    "startDate" text, "endDate" text,
    "coverageTarget" numeric, "coveredCount" integer, status text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS hits (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "planId" text, "wordId" text, "userId" text,
    tier integer, "roundNo" integer, "listNo" integer,
    "scheduledDate" text, modality text, status text,
    "completedAt" text, explain jsonb,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, type text,
    "startedAt" timestamptz, "endedAt" timestamptz,
    device text, "hitCount" integer,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS feedbacks (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "hitId" text UNIQUE, "sessionId" text, "wordId" text, "userId" text,
    "l1State" text, "reactionMs" numeric,
    "l2Tags" jsonb, "confusionWordId" text, "l3Actions" jsonb,
    note text, modality text, "roundNo" integer, tier integer, device text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS session_summaries (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "sessionId" text UNIQUE, "hitCount" integer,
    "l1Distribution" jsonb, "l2Top" jsonb,
    "newConfusionPairs" integer, "newIssues" integer,
    "avgReactionMs" numeric, "modalityDistribution" jsonb,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS confusion_pairs (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "wordA" text, "wordB" text,
    count integer, "lastAt" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS issues (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "wordId" text, type text, note text, status text,
    "createdAt" timestamptz DEFAULT now(), "resolvedAt" text
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS pronunciation_logs (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "wordId" text, engine text, success boolean, "fallbackUsed" boolean,
    error text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS tts_provider_configs (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, provider text, endpoint text, "apiKeyRef" text,
    voice text, "ssmlPhonemeEnabled" boolean, status text,
    "fallbackEngine" text, "lastTestAt" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS ai_provider_configs (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "providerType" text, "baseUrl" text, model text,
    "apiKeyRef" text, "isDefault" boolean, "lastTestAt" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS training_items (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    type text, source text, content jsonb,
    "targetWords" jsonb, "createdBy" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS training_records (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "sessionId" text, "itemId" text, "userId" text,
    "userOutput" jsonb, "wordHits" jsonb,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS tier_snapshots (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "sampledWordIds" jsonb, responses jsonb,
    "computedTiers" jsonb, "calibratedAt" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS ability_snapshots (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "weekStart" text,
    "wordStatesSummary" jsonb, "weakPoints" jsonb,
    "modalityGap" jsonb, "tierPassRates" jsonb,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS mock_exam_records (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "paperRef" text, "takenAt" text,
    "unlockRuleId" text, "diagReport" jsonb,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS mock_unlock_rules (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "userId" text, "ruleJson" jsonb, status text,
    "createdBy" text, reason text, "approvedAt" text,
    created_at timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS ai_proposals (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "planId" text, proposer text, changes jsonb, reason text,
    "riskLevel" text, status text,
    "createdAt" timestamptz DEFAULT now(), "decidedAt" text
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS plan_versions (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    "planId" text, "versionNo" integer, snapshot jsonb,
    "changedBy" text, reason text, "diffSummary" text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  EXECUTE $Q$CREATE TABLE IF NOT EXISTS tool_call_logs (
    id text PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    actor text, "toolName" text, input jsonb, output jsonb,
    applied boolean, "proposalId" text,
    "createdAt" timestamptz DEFAULT now()
  )$Q$;
  -- 关键索引（单用户规模，仅覆盖核心查询路径）
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_hits_plan_date ON hits ("planId", "scheduledDate")$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_hits_user_date ON hits ("userId", "scheduledDate")$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_hits_status ON hits (status)$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_book_words_book ON book_words ("bookId", "listNo")$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_book_words_tier ON book_words ("bookId", tier)$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_feedbacks_word ON feedbacks ("wordId")$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_words_lemma ON words (lemma)$Q$;
  EXECUTE $Q$CREATE INDEX IF NOT EXISTS idx_plan_versions_plan ON plan_versions ("planId", "versionNo" DESC)$Q$;
END $$;
