insert into public.roots (id, root_code, root_meaning)
values
    (gen_random_uuid(), 'ad-, a-', 'hướng đến(ai), tác động vào(ai)'),
    (gen_random_uuid(), 'inter-, dia-, per-', 'khoảng giữa, thông qua'),
    (gen_random_uuid(), 'sur-, super-, trans', 'phía trên, vượt qua'),
    (gen_random_uuid(), 'pre-, pro-', 'phía trước'),
    (gen_random_uuid(), 'e(x)-, extr(a)-', 'ngoài, vượt qua'),
    (gen_random_uuid(), 'co-, con-, com-', 'cùng, hoàn toàn, đầy đủ'),
    (gen_random_uuid(), 'in-, en-, em-', 'bên trong, hoàn toàn, đầy đủ'),
    (gen_random_uuid(), 'in-, un-, a-', 'không'),
    (gen_random_uuid(), 'de-, sub-', 'bên dưới'),
    (gen_random_uuid(), 're-', 'lại, phía sau, một cách toàn diện'),
    (gen_random_uuid(), 'ab(ad)-, dis-', 'cách xa khỏi đâu, không'),
    (gen_random_uuid(), 'sacr-, saint-, sanct-', 'thần thánh'),
    (gen_random_uuid(), 'pri(m)-, pri(n)-', 'đầu tiên, phía trước, trước'),
    (gen_random_uuid(), 'alter-, ali-', 'khác biệt'),
    (gen_random_uuid(), 'amb', 'vùng xung quanh, hai phía'),
    (gen_random_uuid(), 'bene-, bono-', 'tốt'),
    (gen_random_uuid(), 'mag-, may-, maj-, max-', 'to'),
    (gen_random_uuid(), 'mal-', 'xấu'),
    (gen_random_uuid(), 'micro', 'nhỏ, vi mô'),
    (gen_random_uuid(), 'mater-, metro-', 'mẹ, vật chất'),
    (gen_random_uuid(), 'gli-, gla-, glo-', 'toả sáng'),
    (gen_random_uuid(), 'wr-, war-, wor-', 'vặn, uốn cong'),
    (gen_random_uuid(), 'ac(u)-, acer-, acro-', 'kim, sắc bén, cao chót vót'),
    (gen_random_uuid(), 'phil(e)-', 'yêu, thích');

with r1 as (
    select id as root_id from public.roots where root_code = 'ad-, a-' limit 1
)
insert into public.vocab (id, root_id, word, prefix, infix, postfix, prefix_meaning, infix_meaning, postfix_meaning, phonetic)
values
    (gen_random_uuid(), (select root_id from r1), 'administer', 'ad', 'minister', '', 'hướng đến', 'bộ trưởng', '', '/ədˈmɪn.ɪ.stər/'),
    (gen_random_uuid(), (select root_id from r1), 'adverb', 'ad', 'verb', '', 'hướng đến', 'động từ', '', '/ˈæd.vɜːb/'),
    (gen_random_uuid(), (select root_id from r1), 'amaze', 'a', 'maze', '', 'hướng đến', 'mê cung', '', '/əˈmeɪz/');

insert into public.vocab_senses (id, vocab_id, word, pos, definition,  sense_order)
values
    (gen_random_uuid(), (select id from public.vocab where word = 'administer' limit 1), 'administer', 'n',
    'Quản lí, chấp hành, phục vụ', 0),
    (gen_random_uuid(), (select id from public.vocab where word = 'administer' limit 1), 'administration', 'n',
    'Hành chính, quản lí, chủ quyền, chính quyền', 1),
    (gen_random_uuid(), (select id from public.vocab where word = 'administer' limit 1), 'administrative', 'adj',
    '(thuộc) hành chính, (thuộc) quản lí', 2),
    (gen_random_uuid(), (select id from public.vocab where word = 'adverb' limit 1), 'adverb', 'n',
    'Phó từ', 0),
    (gen_random_uuid(), (select id from public.vocab where word = 'amaze' limit 1), 'amaze', 'v',
    'Làm kinh ngạc', 0),
    (gen_random_uuid(), (select id from public.vocab where word = 'amaze' limit 1), 'amazing', 'adj',
    'Đáng ngạc nhiên, kì thú', 1),
    (gen_random_uuid(), (select id from public.vocab where word = 'amaze' limit 1), 'amazement', 'n',
    'Sự kinh ngạc, sự sửng sốt', 2);

insert into public.vocab_examples (id, vocab_id, example_en, example_vi, example_order)
values
    (gen_random_uuid(), (select id from public.vocab where word = 'administer' limit 1), 'The teacher administered corporal punishment.', 'Giáo viên đó đã thực hiện một hình phạt về thể xác.', 0);