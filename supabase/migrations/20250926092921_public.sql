-- =========================
-- Tiện ích UUID
-- =========================
create extension if not exists pgcrypto;

-- =========================
-- Enum: loại từ (chỉ 3 giá trị)
-- =========================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pos_type') then
create type pos_type as enum ('noun', 'verb', 'adjective');
end if;
end $$;

-- =========================
-- 1) Bảng users
-- =========================
create table if not exists public.users (
                                            id           uuid primary key default gen_random_uuid(),
    displayname  text not null,
    name         text,
    created_at   timestamptz not null default now(),
    avatar_path  text
    );

-- =========================
-- 2) Bảng roots (gốc từ)
-- =========================
create table if not exists public.roots (
                                            id            uuid primary key default gen_random_uuid(),
    root_code     text not null unique,          -- ví dụ: "scrib/script"
    root_meaning  text,
    created_at    timestamptz not null default now()
    );

-- =========================
-- 3) Bảng vocab (từ vựng)
-- =========================
create table if not exists public.vocab (
                                            id               uuid primary key default gen_random_uuid(),
    root_id          uuid not null references public.roots(id) on delete restrict,
    token            text not null,              -- từ đầy đủ
-- cấu phần từ
    prefix           text,
    origin           text,
    suffix           text,
    prefix_meaning   text,
    origin_meaning   text,
    suffix_meaning   text,
    phonetic         text,                       -- phiên âm (IPA)
    created_at       timestamptz not null default now(),
    unique (root_id, token)
    );

create index if not exists idx_vocab_root_id on public.vocab(root_id);
create index if not exists idx_vocab_token on public.vocab(token);

-- =========================
-- 4) Vocab senses (nghĩa theo loại từ)
-- =========================
create table if not exists public.vocab_senses (
                                                   id           uuid primary key default gen_random_uuid(),
    vocab_id     uuid not null references public.vocab(id) on delete cascade,
    pos          pos_type not null,          -- noun | verb | adjective
    definition   text not null,              -- nghĩa của từ ở POS này
    examples     text[],                     -- ví dụ câu (tùy chọn)
    sense_order  smallint default 1,         -- để sắp xếp các sense (1,2,3…)
    created_at   timestamptz not null default now()
    );

-- Nếu bạn muốn mỗi POS chỉ 1 nghĩa duy nhất cho 1 từ:
-- alter table public.vocab_senses add constraint uq_vocab_pos unique (vocab_id, pos);

create index if not exists idx_sense_vocab on public.vocab_senses(vocab_id);
create index if not exists idx_sense_pos on public.vocab_senses(pos);
