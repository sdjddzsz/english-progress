DO $$
DECLARE
  t text;
  -- 除 users（id=auth.uid()）与 words（公开读）外的 22 张 owner-only 表
  owner_tables text[] := ARRAY['books','book_words','study_plans','plan_rounds','hits','sessions','feedbacks','session_summaries','confusion_pairs','issues','pronunciation_logs','tts_provider_configs','ai_provider_configs','training_items','training_records','tier_snapshots','ability_snapshots','mock_exam_records','mock_unlock_rules','ai_proposals','plan_versions','tool_call_logs'];
BEGIN
  -- 22 张 owner-only：四类策略，两道门齐全
  FOREACH t IN ARRAY owner_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_select_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_insert_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_update_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (owner_id = auth.uid())', t || '_delete_own', t);
  END LOOP;
  -- users：行即本人（id = auth.uid()）
  EXECUTE 'DROP POLICY IF EXISTS users_select_own ON public.users';
  EXECUTE 'CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated USING (id = auth.uid())';
  EXECUTE 'DROP POLICY IF EXISTS users_insert_own ON public.users';
  EXECUTE 'CREATE POLICY users_insert_own ON public.users FOR INSERT TO authenticated WITH CHECK (id = auth.uid())';
  EXECUTE 'DROP POLICY IF EXISTS users_update_own ON public.users';
  EXECUTE 'CREATE POLICY users_update_own ON public.users FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid())';
  EXECUTE 'DROP POLICY IF EXISTS users_delete_own ON public.users';
  EXECUTE 'CREATE POLICY users_delete_own ON public.users FOR DELETE TO authenticated USING (id = auth.uid())';
  -- words：全局词库，公开读、登录写
  EXECUTE 'DROP POLICY IF EXISTS words_select_all ON public.words';
  EXECUTE 'CREATE POLICY words_select_all ON public.words FOR SELECT TO authenticated, anon USING (true)';
  EXECUTE 'DROP POLICY IF EXISTS words_insert_any ON public.words';
  EXECUTE 'CREATE POLICY words_insert_any ON public.words FOR INSERT TO authenticated WITH CHECK (true)';
  EXECUTE 'DROP POLICY IF EXISTS words_update_any ON public.words';
  EXECUTE 'CREATE POLICY words_update_any ON public.words FOR UPDATE TO authenticated USING (true) WITH CHECK (true)';
  EXECUTE 'DROP POLICY IF EXISTS words_delete_any ON public.words';
  EXECUTE 'CREATE POLICY words_delete_any ON public.words FOR DELETE TO authenticated USING (true)';
END $$;
