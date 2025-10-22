-- Move leaderboard objects from schema `leaderboard` into `leaderboard`
-- - Recreate all tables/views/functions/triggers under leaderboard
-- - Copy data from leaderboard.* if it exists
-- - Drop old leaderboard schema

BEGIN;

-- Ensure target schema exists
CREATE SCHEMA IF NOT EXISTS leaderboard;

GRANT USAGE ON SCHEMA leaderboard TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA leaderboard TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA leaderboard TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA leaderboard TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA leaderboard GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA leaderboard GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA leaderboard GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- 1) Weeks table in leaderboard
CREATE TABLE IF NOT EXISTS leaderboard.weeks (
                                            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start TIMESTAMPTZ NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

-- View: weeks_with_end (computed end of week)
-- CREATE OR REPLACE VIEW leaderboard.weeks_with_end AS
-- SELECT
--     id,
--     week_start,
--     (week_start + INTERVAL '7 days') AS week_end,
--     status,
--     created_at
-- FROM leaderboard.weeks;

CREATE INDEX IF NOT EXISTS idx_leaderboard_weeks_status ON leaderboard.weeks(status);

-- 2) Leagues in leaderboard
CREATE TABLE IF NOT EXISTS leaderboard.leagues (
                                              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    rank INT NOT NULL UNIQUE,
    min_cohort_size INT NOT NULL DEFAULT 25 CHECK (min_cohort_size > 0),
    max_cohort_size INT NOT NULL DEFAULT 30 CHECK (max_cohort_size >= min_cohort_size),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

INSERT INTO leaderboard.leagues (code, name, rank, min_cohort_size, max_cohort_size)
VALUES
    ('bronze',   'Bronze',   1, 25, 30),
    ('silver',   'Silver',   2, 25, 30),
    ('gold',     'Gold',     3, 25, 30),
    ('sapphire', 'Sapphire', 4, 25, 30),
    ('ruby',     'Ruby',     5, 25, 30),
    ('emerald',  'Emerald',  6, 25, 30),
    ('amethyst', 'Amethyst', 7, 25, 30),
    ('pearl',    'Pearl',    8, 25, 30),
    ('obsidian', 'Obsidian', 9, 25, 30),
    ('diamond',  'Diamond', 10, 25, 30)
    ON CONFLICT (code) DO NOTHING;

-- 3) Cohorts
CREATE TABLE IF NOT EXISTS leaderboard.cohorts (
                                              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_id UUID NOT NULL REFERENCES leaderboard.weeks(id) ON DELETE CASCADE,
    league_id UUID NOT NULL REFERENCES leaderboard.leagues(id),
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (week_id, id)
    );

CREATE INDEX IF NOT EXISTS idx_leaderboard_cohorts_week_league ON leaderboard.cohorts(week_id, league_id);

-- 4) Optional per-user tz profile (distinct from public.profiles)
-- CREATE TABLE IF NOT EXISTS leaderboard.user_profile (
--                                                    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
--     timezone TEXT NOT NULL DEFAULT 'UTC',
--     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
--     );

-- 5) Cohort members
CREATE TABLE IF NOT EXISTS leaderboard.cohort_members (
                                                     cohort_id UUID NOT NULL,
                                                     week_id UUID NOT NULL,
                                                     user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cohort_id, user_id),
    FOREIGN KEY (week_id, cohort_id) REFERENCES leaderboard.cohorts(week_id, id) ON DELETE CASCADE
    );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_cohort_members_user_week ON leaderboard.cohort_members(user_id, week_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_cohort_members_week_cohort ON leaderboard.cohort_members(week_id, cohort_id);

-- 6) XP events stored in leaderboard
CREATE TABLE IF NOT EXISTS leaderboard.xp_events (
                                                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    points INT NOT NULL CHECK (points >= 0),
    source TEXT NOT NULL,
    week_id UUID NOT NULL REFERENCES leaderboard.weeks(id) ON DELETE RESTRICT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

CREATE INDEX IF NOT EXISTS idx_leaderboard_xp_events_user_week ON leaderboard.xp_events(user_id, week_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_xp_events_week_time ON leaderboard.xp_events(week_id, occurred_at DESC);

-- 7) Rollups & leaderboard view (leaderboard)
-- CREATE OR REPLACE VIEW leaderboard.weekly_user_points AS
-- SELECT
--     e.user_id,
--     e.week_id,
--     SUM(e.points)::INT AS points,
--     MAX(e.occurred_at) AS last_event_at
-- FROM leaderboard.xp_events e
-- GROUP BY e.user_id, e.week_id;

-- CREATE OR REPLACE VIEW leaderboard.cohort_leaderboard AS
-- SELECT
--     cm.cohort_id,
--     cm.week_id,
--     cm.user_id,
--     COALESCE(w.points, 0) AS points,
--     w.last_event_at,
--     RANK() OVER (
--     PARTITION BY cm.cohort_id
--     ORDER BY COALESCE(w.points, 0) DESC, w.last_event_at ASC NULLS LAST
--   ) AS rank
-- FROM leaderboard.cohort_members cm
--          LEFT JOIN leaderboard.weekly_user_points w
--                    ON w.user_id = cm.user_id AND w.week_id = cm.week_id;

-- 8) Final results snapshot
CREATE TABLE IF NOT EXISTS leaderboard.user_week_results (
                                                        week_id UUID NOT NULL REFERENCES leaderboard.weeks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    league_id UUID NOT NULL REFERENCES leaderboard.leagues(id),
    cohort_id UUID NOT NULL REFERENCES leaderboard.cohorts(id) ON DELETE CASCADE,
    final_rank INT NOT NULL CHECK (final_rank > 0),
    points_total INT NOT NULL DEFAULT 0 CHECK (points_total >= 0),
    to_league_id UUID NULL REFERENCES leaderboard.leagues(id),
    transition TEXT NULL CHECK (transition IN ('promote','stay','relegate')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (week_id, user_id)
    );

CREATE INDEX IF NOT EXISTS idx_leaderboard_results_cohort ON leaderboard.user_week_results(week_id, cohort_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_results_league ON leaderboard.user_week_results(week_id, league_id);

-- 9) Utility functions and trigger in leaderboard
CREATE OR REPLACE FUNCTION leaderboard.ensure_week(ts TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
start_ts TIMESTAMPTZ;
  new_id UUID;
BEGIN
  start_ts := date_trunc('week', ts);
INSERT INTO leaderboard.weeks (week_start)
VALUES (start_ts)
    ON CONFLICT (week_start) DO NOTHING;

SELECT id INTO new_id FROM leaderboard.weeks WHERE week_start = start_ts;
RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION leaderboard.ensure_week_and_join(p_user_id UUID, ts TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_week_id UUID;
  bronze_league_id UUID;
  bronze_cohort_id UUID;
BEGIN
  -- 1️⃣ Đảm bảo tuần tồn tại
  v_week_id := leaderboard.ensure_week(ts);

  -- 2️⃣ Lấy ID của league 'bronze'
  SELECT id INTO bronze_league_id
  FROM leaderboard.leagues
  WHERE code = 'bronze'
  LIMIT 1;

  IF bronze_league_id IS NULL THEN
    RAISE EXCEPTION 'League "bronze" not found in leaderboard.leagues';
  END IF;

  -- 3️⃣ Tìm cohort “bronze” của tuần này
  SELECT id INTO bronze_cohort_id
  FROM leaderboard.cohorts c
  WHERE c.week_id = v_week_id AND c.league_id = bronze_league_id
  LIMIT 1;

  -- 4️⃣ Nếu chưa có thì tạo cohort mới
  IF bronze_cohort_id IS NULL THEN
    INSERT INTO leaderboard.cohorts (week_id, league_id, title)
    VALUES (v_week_id, bronze_league_id, 'Bronze Cohort')
    RETURNING id INTO bronze_cohort_id;
  END IF;

  -- 5️⃣ Thêm user vào cohort (nếu chưa có trong tuần)
  INSERT INTO leaderboard.cohort_members (cohort_id, week_id, user_id)
  VALUES (bronze_cohort_id, v_week_id, p_user_id)
  ON CONFLICT (user_id, week_id) DO NOTHING;

  RETURN v_week_id;
END;
$$;


CREATE OR REPLACE FUNCTION leaderboard.set_xp_event_week_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  computed_week UUID;
BEGIN
  -- 1️⃣ Đảm bảo tuần tồn tại + thêm user vào cohort nếu cần
  computed_week := leaderboard.ensure_week_and_join(NEW.user_id, NEW.occurred_at);

  -- 2️⃣ Nếu week_id khác → cập nhật lại
  IF NEW.week_id IS DISTINCT FROM computed_week THEN
    NEW.week_id := computed_week;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop any existing matching triggers on leaderboard.xp_events, then create ours
DO $$
DECLARE r RECORD;
BEGIN
FOR r IN
SELECT tgname
FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'leaderboard'
  AND c.relname = 'xp_events'
  AND NOT t.tgisinternal
  AND tgname LIKE 'trg_set_xp_%'
    LOOP
    EXECUTE format('DROP TRIGGER %I ON leaderboard.xp_events', r.tgname);
END LOOP;
END $$;

CREATE TRIGGER trg_set_xp_event_week_id
    BEFORE INSERT OR UPDATE OF occurred_at, week_id ON leaderboard.xp_events
    FOR EACH ROW
    EXECUTE FUNCTION leaderboard.set_xp_event_week_id();

-- 10) Optional data copy from schema leaderboard -> leaderboard, if exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'leaderboard') THEN
    -- weeks
    BEGIN
      INSERT INTO leaderboard.weeks (id, week_start, status, created_at)
      SELECT id, week_start, status, created_at FROM leaderboard.weeks
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- leagues
    BEGIN
      INSERT INTO leaderboard.leagues (id, code, name, rank, min_cohort_size, max_cohort_size, created_at)
      SELECT id, code, name, rank, min_cohort_size, max_cohort_size, created_at FROM leaderboard.leagues
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- cohorts
    BEGIN
      INSERT INTO leaderboard.cohorts (id, week_id, league_id, title, created_at)
      SELECT id, week_id, league_id, title, created_at FROM leaderboard.cohorts
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- user_profile
    BEGIN
      INSERT INTO leaderboard.user_profile (user_id, timezone, created_at, updated_at)
      SELECT user_id, timezone, created_at, updated_at FROM leaderboard.user_profile
      ON CONFLICT (user_id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- cohort_members
    BEGIN
      INSERT INTO leaderboard.cohort_members (cohort_id, week_id, user_id, joined_at)
      SELECT cohort_id, week_id, user_id, joined_at FROM leaderboard.cohort_members
      ON CONFLICT (cohort_id, user_id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- xp_events
    BEGIN
      INSERT INTO leaderboard.xp_events (id, user_id, occurred_at, points, source, week_id, metadata, created_at)
      SELECT id, user_id, occurred_at, points, source, week_id, metadata, created_at FROM leaderboard.xp_events
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;

    -- user_week_results
    BEGIN
      INSERT INTO leaderboard.user_week_results (week_id, user_id, league_id, cohort_id, final_rank, points_total, to_league_id, transition, created_at)
      SELECT week_id, user_id, league_id, cohort_id, final_rank, points_total, to_league_id, transition, created_at FROM leaderboard.user_week_results
      ON CONFLICT (week_id, user_id) DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL; END;
  END IF;
END $$;

-- 11) Drop old schema if it exists (and everything inside it)
-- DROP SCHEMA IF EXISTS leaderboard CASCADE;

COMMIT;


-- =========================
-- update weekly user points 
-- =========================

CREATE OR REPLACE FUNCTION leaderboard.update_weekly_user_points(target_week UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Xoá dữ liệu cũ nếu có
  DELETE FROM leaderboard.user_week_results WHERE week_id = target_week;

  -- Tính tổng điểm
  INSERT INTO leaderboard.user_week_results (week_id, user_id, league_id, cohort_id, final_rank, points_total)
  SELECT
    cm.week_id,
    cm.user_id,
    c.league_id,
    cm.cohort_id,
    RANK() OVER (PARTITION BY cm.cohort_id ORDER BY SUM(e.points) DESC) AS final_rank,
    COALESCE(SUM(e.points), 0)::INT AS points_total
  FROM leaderboard.cohort_members cm
  JOIN leaderboard.cohorts c ON c.id = cm.cohort_id
  LEFT JOIN leaderboard.xp_events e ON e.user_id = cm.user_id AND e.week_id = cm.week_id
  WHERE cm.week_id = target_week
  GROUP BY cm.week_id, cm.user_id, c.league_id, cm.cohort_id;

END;
$$;
-- =========================


-- =========================
-- create next week cohorts
CREATE OR REPLACE FUNCTION leaderboard.create_next_week_cohorts(prev_week UUID, next_week UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  l RECORD;
  members UUID[];
  cohort_id UUID;
  size INT := 0;
BEGIN
  FOR l IN SELECT * FROM leaderboard.leagues ORDER BY rank LOOP
    -- Lấy danh sách user sẽ vào league này tuần sau
    SELECT ARRAY_AGG(user_id) INTO members
    FROM leaderboard.user_week_results
    WHERE week_id = prev_week AND to_league_id = l.id;

    size := 0;
    IF members IS NOT NULL THEN
      FOR i IN 1..array_length(members, 1) LOOP
        IF size = 0 OR size >= l.max_cohort_size THEN
          INSERT INTO leaderboard.cohorts (week_id, league_id, title)
          VALUES (next_week, l.id, l.name || ' Cohort ' || floor(random()*1000)) RETURNING id INTO cohort_id;
          size := 0;
        END IF;
        INSERT INTO leaderboard.cohort_members (cohort_id, week_id, user_id)
        VALUES (cohort_id, next_week, members[i]);
        size := size + 1;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;
-- =========================
CREATE OR REPLACE FUNCTION leaderboard.close_week(target_week UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  next_week_id UUID;
BEGIN
  -- Cập nhật tuần hiện tại thành closed
  UPDATE leaderboard.weeks SET status = 'closed' WHERE id = target_week;

  -- Cập nhật điểm & thứ hạng
  PERFORM leaderboard.update_weekly_user_points(target_week);

  -- Xác định league tiếp theo (promote/relegate) và đảm bảo to_league_id không NULL
  UPDATE leaderboard.user_week_results r
  SET
    to_league_id = CASE
      WHEN r.final_rank <= 5 THEN COALESCE(lup.id, r.league_id)
      WHEN r.final_rank >= 21 THEN COALESCE(ldn.id, r.league_id)
      ELSE r.league_id
    END,
    transition = CASE
      WHEN r.final_rank <= 5 AND lup.id IS NOT NULL THEN 'promote'
      WHEN r.final_rank >= 21 AND ldn.id IS NOT NULL THEN 'relegate'
      ELSE 'stay'
    END
  FROM leaderboard.leagues l1
  LEFT JOIN leaderboard.leagues lup ON lup.rank = l1.rank + 1
  LEFT JOIN leaderboard.leagues ldn ON ldn.rank = l1.rank - 1
  WHERE l1.id = r.league_id
    AND r.week_id = target_week;

  -- Tạo tuần kế tiếp
  INSERT INTO leaderboard.weeks (week_start, status)
  VALUES (date_trunc('week', now() + interval '7 days'), 'open')
  RETURNING id INTO next_week_id;

  -- Tạo cohort mới theo league mới (dựa trên to_league_id đã được set ở trên)
  PERFORM leaderboard.create_next_week_cohorts(target_week, next_week_id);
END;
$$;

-- =========================
-- close current week
CREATE OR REPLACE FUNCTION leaderboard.close_current_week()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  current_week_id UUID;
BEGIN
  SELECT id INTO current_week_id
  FROM leaderboard.weeks
  WHERE status = 'open'
  ORDER BY week_start DESC
  LIMIT 1;

  IF current_week_id IS NULL THEN
    RAISE NOTICE 'No open week found to close.';
    RETURN;
  END IF;

  PERFORM leaderboard.close_week(current_week_id);
END;
$$;
