do $$
begin
  if not exists (select 1 from pg_type where typname = 'question_type') then
create type question_type as enum ('meaning', 'fill_the_gap');
end if;
end $$;

-- =========================
-- Bảng questions
-- =========================
create table if not exists public.questions (
                                                id              uuid primary key default gen_random_uuid(),
    vocab_id        uuid not null references public.vocab(id) on delete cascade,
    question_type   question_type not null,      -- loại câu hỏi: nghĩa | fill the gap
    question_text   text not null,              -- nội dung câu hỏi
    options         text[] not null,            -- danh sách 4 đáp án
    correct_answer  smallint not null check (correct_answer between 1 and 4), -- chỉ số đáp án đúng (1-4)
    created_at      timestamptz not null default now()
    );