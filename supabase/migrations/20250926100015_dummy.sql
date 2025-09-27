-- ============ Users ============
insert into public.users (id, displayname, name, avatar_path)
values
    (gen_random_uuid(), 'johnny', 'John Doe', '/avatars/john.png'),
    (gen_random_uuid(), 'anna', 'Anna Smith', '/avatars/anna.png');

-- ============ Roots ============
insert into public.roots (id, root_code, root_meaning)
values
    (gen_random_uuid(), 'scrib/script', 'to write'),
    (gen_random_uuid(), 'dict', 'to say, speak');

-- ============ Vocab ============
-- Lấy id root cho tiện: giả sử root_code là unique
with r1 as (
    select id as root_id from public.roots where root_code = 'scrib/script' limit 1
    ),
    r2 as (
select id as root_id from public.roots where root_code = 'dict' limit 1
    )
insert into public.vocab (id, root_id, token, prefix, origin, suffix, prefix_meaning, origin_meaning, suffix_meaning, phonetic)
values
    (gen_random_uuid(), (select root_id from r1), 'inscription', 'in', 'script', 'ion', 'in = into', 'script = write', 'ion = action', '/ɪnˈskrɪpʃən/'),
    (gen_random_uuid(), (select root_id from r1), 'describe', 'de', 'scribe', null, 'de = down', 'scribe = write', null, '/dɪˈskraɪb/'),
    (gen_random_uuid(), (select root_id from r2), 'dictate', null, 'dict', 'ate', null, 'dict = say', 'ate = make/do', '/ˈdɪkteɪt/');

-- ============ Vocab senses ============
-- Tạo nghĩa cho từng từ, ví dụ lấy id vocab qua token
insert into public.vocab_senses (id, vocab_id, pos, definition, examples, sense_order)
values
    (gen_random_uuid(), (select id from public.vocab where token = 'inscription' limit 1), 'noun',
    'Words that are written or carved, especially on a monument or in a book.',
    array['The inscription on the tomb was in Latin.'], 1),

  (gen_random_uuid(), (select id from public.vocab where token = 'describe' limit 1), 'verb',
    'To give an account of something in words, including details.',
    array['She tried to describe the accident clearly.'], 1),

  (gen_random_uuid(), (select id from public.vocab where token = 'dictate' limit 1), 'verb',
    'To say or read aloud words to be written down by another.',
    array['He dictated a letter to his secretary.'], 1),

  (gen_random_uuid(), (select id from public.vocab where token = 'dictate' limit 1), 'noun',
    'An order or principle that must be obeyed.',
    array['The manager’s dictates must be followed.'], 2);
