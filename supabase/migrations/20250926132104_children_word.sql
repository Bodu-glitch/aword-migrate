-- =========================
-- N-N: Người ↔ Từ (trạng thái hiện tại)
-- =========================
create table if not exists public.profile_vocab_progress (
    profile_id         uuid not null references public.profiles(id) on delete cascade,
    vocab_id        uuid not null references public.vocab(id) on delete cascade,

--     status          text not null default 'learning',  -- learning|review|mastered (tùy bạn)
    proficiency     numeric(4,2) default 0.00,         -- thời gian học càng ít, trả lời đúng càng nhiều thì càng cao (0.00..1.00)
    last_seen_at    timestamptz,
--     next_review_at  timestamptz,
    first_learned_at timestamptz default now(),

    primary key (profile_id, vocab_id)
    );

create index if not exists idx_uvp_profile on public.profile_vocab_progress(profile_id);
create index if not exists idx_uvp_vocab on public.profile_vocab_progress(vocab_id);
-- create index if not exists idx_uvp_next_review on public.profile_vocab_progress(next_review_at);

-- =========================
-- Lịch sử: Người ↔ Từ (mỗi lượt ôn/làm bài)
-- =========================
-- create table if not exists public.profile_vocab_reviews (
--                                                          id              uuid primary key default gen_random_uuid(),
--     profile_id         uuid not null references public.profiles(id) on delete cascade,
--     vocab_id        uuid not null references public.vocab(id) on delete cascade,
--
--     reviewed_at     timestamptz not null default now(),
--     result          smallint,           -- 0..3 (Again/Hard/Good/Easy) hoặc 0/1 đúng-sai
--     latency_ms      integer,            -- thời gian trả lời
--     note            text
--     );
--
-- create index if not exists idx_uvr_profile_vocab_time
--     on public.profile_vocab_reviews(profile_id, vocab_id, reviewed_at desc);

-- =========================
-- N-N: Người ↔ Gốc (trạng thái hiện tại)
-- =========================
create table if not exists public.profile_root_progress (
    profile_id         uuid not null references public.profiles(id) on delete cascade,
    root_id         uuid not null references public.roots(id) on delete cascade,

    started_at      timestamptz not null default now(),
--     last_seen_at    timestamptz,
--     mastered_ratio  numeric(5,2) default 0.00,    -- % từ của gốc đã mastered
    is_learning     boolean not null default true,            -- còn học gốc này không

    primary key (profile_id, root_id)
    );

create index if not exists idx_urp_profile on public.profile_root_progress(profile_id);
create index if not exists idx_urp_root on public.profile_root_progress(root_id);


-- =========================
-- Child Root of Vocab (Gốc từ con của vocab)
-- =========================
create table if not exists public.vocab_sub_roots (
    id uuid primary key default gen_random_uuid(),
    vocab_id uuid not null unique references public.vocab(id) on delete cascade,
    token text not null, -- gốc con
    defination text, -- nghĩa gốc con
    created_at timestamptz not null default now()
);

create index if not exists idx_vchildroot_vocab on public.vocab_sub_roots(vocab_id);

-- =========================
-- Sub Vocab (Từ con của gốc từ con)
-- =========================
create table if not exists public.sub_vocab (
    id uuid primary key default gen_random_uuid(),
    sub_root_id uuid not null references public.vocab_sub_roots(id) on delete cascade,
    word text not null unique,
    prefix text,
    infix text,
    postfix text,
    prefix_meaning text,
    infix_meaning text,
    postfix_meaning text,
    phonetic text,
    created_at timestamptz not null default now()
);

create index if not exists idx_subvocab_subroot on public.sub_vocab(sub_root_id);

-- =========================
-- N-N: Người ↔ Gốc từ con (trạng thái hiện tại)
-- =========================
create table if not exists public.profile_sub_vocab_progress (
    profile_id uuid not null references public.profiles(id) on delete cascade,
    sub_vocab_id uuid not null references public.sub_vocab(id) on delete cascade,
    started_at timestamptz not null default now(),
    proficiency     numeric(4,2) default 0.00,         -- thời gian học càng ít, trả lời đúng càng nhiều thì càng cao (0.00..1.00)
    last_seen_at    timestamptz,
--     next_review_at  timestamptz,
    first_learned_at timestamptz default now(),
    primary key (profile_id, sub_vocab_id)
    );


-- =========================
-- Sub Vocab Senses (nghĩa theo loại từ của sub_vocab)
-- =========================
create table if not exists public.sub_vocab_sense (
    id uuid primary key default gen_random_uuid(),
    sub_vocab_id uuid not null references public.sub_vocab(id) on delete cascade,
    word text not null,
    pos pos_type not null,
    definition text not null,
    sense_order smallint default 1,
    created_at timestamptz not null default now(),
    unique (sub_vocab_id, word, pos)
);

create index if not exists idx_subvocabsense_subvocab on public.sub_vocab_sense(sub_vocab_id);

-- =========================
-- Sub Vocab Examples (ví dụ của sub_vocab)
-- =========================
create table if not exists public.sub_vocab_example (
    id uuid primary key default gen_random_uuid(),
    sub_vocab_id uuid not null references public.sub_vocab(id) on delete cascade,
    example_en text not null,
    example_vi text,
    example_order smallint default 1,
    created_at timestamptz not null default now()
);

create index if not exists idx_subvocabexample_subvocab on public.sub_vocab_example(sub_vocab_id);


create table if not exists public.profile_sub_root_progress (
    profile_id         uuid not null references public.profiles(id) on delete cascade,
    sub_root_id         uuid not null references public.vocab_sub_roots(id) on delete cascade,

    started_at      timestamptz not null default now(),
    --     last_seen_at    timestamptz,
--     mastered_ratio  numeric(5,2) default 0.00,    -- % từ của gốc đã mastered
    is_learning     boolean not null default true,            -- còn học gốc này không

    primary key (profile_id, sub_root_id)
    );

create index if not exists idx_urp_profile_sub on public.profile_sub_root_progress(profile_id);
create index if not exists idx_urp_root_sub on public.profile_sub_root_progress(sub_root_id);