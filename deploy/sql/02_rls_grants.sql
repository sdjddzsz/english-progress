DO $$
DECLARE
  t text;
  tables_all text[] := ARRAY['users','books','words','book_words','study_plans','plan_rounds','hits','sessions','feedbacks','session_summaries','confusion_pairs','issues','pronunciation_logs','tts_provider_configs','ai_provider_configs','training_items','training_records','tier_snapshots','ability_snapshots','mock_exam_records','mock_unlock_rules','ai_proposals','plan_versions','tool_call_logs'];
BEGIN
  FOREACH t IN ARRAY tables_all LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, anon', t);
  END LOOP;
END $$;
