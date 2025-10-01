-- =========================
-- N-N: Người ↔ Từ (trạng thái hiện tại)
-- =========================
create table if not exists public.user_vocab_progress (
    user_id         uuid not null references public.users(id) on delete cascade,
    vocab_id        uuid not null references public.vocab(id) on delete cascade,

--     status          text not null default 'learning',  -- learning|review|mastered (tùy bạn)
    proficiency     numeric(4,2) default 0.00,         -- thời gian học càng ít, trả lời đúng càng nhiều thì càng cao (0.00..1.00)
    last_seen_at    timestamptz,
--     next_review_at  timestamptz,
    first_learned_at timestamptz default now(),

    unique (user_id, vocab_id)
    );

create index if not exists idx_uvp_user on public.user_vocab_progress(user_id);
create index if not exists idx_uvp_vocab on public.user_vocab_progress(vocab_id);
-- create index if not exists idx_uvp_next_review on public.user_vocab_progress(next_review_at);

-- =========================
-- Lịch sử: Người ↔ Từ (mỗi lượt ôn/làm bài)
-- =========================
-- create table if not exists public.user_vocab_reviews (
--                                                          id              uuid primary key default gen_random_uuid(),
--     user_id         uuid not null references public.users(id) on delete cascade,
--     vocab_id        uuid not null references public.vocab(id) on delete cascade,
--
--     reviewed_at     timestamptz not null default now(),
--     result          smallint,           -- 0..3 (Again/Hard/Good/Easy) hoặc 0/1 đúng-sai
--     latency_ms      integer,            -- thời gian trả lời
--     note            text
--     );
--
-- create index if not exists idx_uvr_user_vocab_time
--     on public.user_vocab_reviews(user_id, vocab_id, reviewed_at desc);

-- =========================
-- N-N: Người ↔ Gốc (trạng thái hiện tại)
-- =========================
create table if not exists public.user_root_progress (
    user_id         uuid not null references public.users(id) on delete cascade,
    root_id         uuid not null references public.roots(id) on delete cascade,

    started_at      timestamptz not null default now(),
--     last_seen_at    timestamptz,
    mastered_ratio  numeric(5,2) default 0.00,    -- % từ của gốc đã mastered
    is_learning     boolean not null default true,            -- còn học gốc này không

    unique (user_id, root_id)
    );

create index if not exists idx_urp_user on public.user_root_progress(user_id);
create index if not exists idx_urp_root on public.user_root_progress(root_id);


-- create table if not exists public.vocab_children (
--                                                      id                uuid primary key default gen_random_uuid(),
--     parent_vocab_id   uuid not null references public.vocab(id) on delete cascade,
--     token             text not null,         -- từ con
--     phonetic          text,                  -- phiên âm (IPA)
--     created_at        timestamptz not null default now(),
--
--     unique (parent_vocab_id, token)
--     );
--
-- create index if not exists idx_vchild_parent on public.vocab_children(parent_vocab_id);
--
-- -- Nghĩa theo POS cho từ con (y như vocab_senses nhưng dành cho child)
-- create table if not exists public.vocab_child_senses (
--                                                          id            uuid primary key default gen_random_uuid(),
--     child_id      uuid not null references public.vocab_children(id) on delete cascade,
--     pos           pos_type not null,     -- noun | verb | adjective
--     definition    text not null,
--     examples      text[],
--     sense_order   smallint default 1,
--     created_at    timestamptz not null default now()
--     );
--
-- create index if not exists idx_vchild_sense_child on public.vocab_child_senses(child_id);
-- create index if not exists idx_vchild_sense_pos on public.vocab_child_senses(pos);
