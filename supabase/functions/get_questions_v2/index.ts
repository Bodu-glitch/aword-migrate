// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient, SupabaseClient} from "npm:@supabase/supabase-js@2";
import {corsHeaders} from "../_shared/cors.ts";
import {getUser} from "../_shared/get-user.ts";
import OpenAI from "jsr:@openai/openai";
import "npm:tslib@2.6.0";

console.log("Hello from Functions!");

Deno.serve(async (req: Request) => {
    async function findProgressingRoot(
        userId: string,
        supabase: SupabaseClient<any, "public", "public", any, any>,
    ) {
        const {data, error} = await supabase
            .from("profile_root_progress").select("*")
            .eq("profile_id", userId)
            .eq("is_learning", true);

        if (error) {
            throw error;
        }

        return data;
    }

    async function addNewProgressingRoot(
        userId: string,
        supabase: SupabaseClient<any, "public", "public", any, any>,
    ) {
        // select random root from roots table not in profile_root_progress for this user
        console.log("Adding new progressing root for user:", userId);
        const {data: existingRoots, error: existingRootsError} = await supabase
            .from("profile_root_progress")
            .select("root_id")
            .eq("profile_id", userId);

        if (existingRootsError) {
            throw existingRootsError;
        }

        const existingRootIds = existingRoots?.map((r: any) => r.root_id) || [];

        const {data: newRoots, error: newRootsError} = await supabase
            .rpc("get_random_root", {
                exclude_ids: existingRootIds,
            });

        if (newRootsError) {
            console.log("Error fetching new roots:", newRootsError);
            throw newRootsError;
        }

        if (newRoots && newRoots.length > 0) {
            const newRoot = newRoots[0];
            const {data: insertData, error: insertError} = await supabase
                .from("profile_root_progress")
                .insert({
                    profile_id: userId,
                    root_id: newRoot.id,
                    is_learning: true,
                })
                .select("*")
                .single();

            if (insertError) {
                console.log("Error inserting new progressing root:", insertError);
                throw insertError;
            }

            return insertData;
        } else {
            return null; // No new roots available
        }
    }

    async function getRandomVocabByRoot(
        userId: string,
        rootIds: string[],
        supabase: SupabaseClient<any, "public", "public", any, any>
    ) {
        // 1️⃣ Lấy danh sách vocab user đã học (theo root)
        const { data: learned, error: learnedError } = await supabase
            .from("profile_vocab_progress")
            .select(`
      vocab:vocab_id (
        id,
        word,
        root:root_id (
          id,
          root_code,
          root_meaning
        )
      )
    `)
            .eq("profile_id", userId)
            .in("vocab.root_id", rootIds);

        if (learnedError) throw learnedError;
        const learnedVocabIds = (learned ?? []).map((p: any) => p.vocab.id);

        // 2️⃣ Gọi RPC get_random_vocab_by_roots
        const { data: vocabData, error: vocabError } = await supabase.rpc(
            "get_random_vocab_by_roots",
            {
                root_ids: rootIds,
                exclude_ids: learnedVocabIds,
                limit_count: 5,
            }
        );

        if (vocabError) throw vocabError;
        if (!vocabData || vocabData.length === 0) return vocabData;

        // 3️⃣ Lấy sub_roots của các vocab
        const vocabIds = vocabData.map((v: any) => v.id);
        const { data: subRoots, error: subRootError } = await supabase
            .from("vocab_sub_roots")
            .select("*")
            .in("vocab_id", vocabIds);

        if (subRootError) throw subRootError;

        // Nếu không có sub_root nào → trả luôn vocabData
        if (!subRoots || subRoots.length === 0) return vocabData;

        // 🔹 Chọn 1 vocab có sub_root (ví dụ vocab đầu tiên có sub_root)
        const vocabIdWithSubRoot = subRoots[0].vocab_id;

        // Lọc lại vocabData chỉ giữ 1 vocab này
        const parentVocab = vocabData.find((v: any) => v.id === vocabIdWithSubRoot);
        if (!parentVocab) return vocabData; // fallback an toàn

        // Lọc subRoots chỉ của vocab đó
        const subRootsOfVocab = subRoots.filter(
            (s: any) => s.vocab_id === vocabIdWithSubRoot
        );

        // 4️⃣ Lấy sub_vocab theo sub_root_id
        const subRootIds = subRootsOfVocab.map((s: any) => s.id);
        const { data: subVocabs, error: subVocabError } = await supabase
            .from("sub_vocab")
            .select("*, vocab_senses:sub_vocab_sense (*)")
            .in("sub_root_id", subRootIds);

        if (subVocabError) throw subVocabError;

        // 5️⃣ Gộp lại
        const combined: any[] = [];
        combined.push(parentVocab);

        for (const subRoot of subRootsOfVocab) {
            const subVocabsOfSubRoot =
                subVocabs?.filter((sv: any) => sv.sub_root_id === subRoot.id) ?? [];

            const enrichedSubVocabs = subVocabsOfSubRoot.map((sv: any) => ({
                ...sv,
                parent_vocab_id: parentVocab.id
            }));

            combined.push(...enrichedSubVocabs);
        }

        return combined;
    }

    async function getReviewWords(
        userId: string,
        supabase: SupabaseClient<any, "public", "public", any, any>,
        limit = 5,
    ) {
        // Lấy danh sách từ cần ôn từ 2 bảng: profile_vocab_progress và profile_sub_vocab_progress
        // Sau đó trộn theo độ thành thạo (proficiency) thấp nhất và lấy ra 'limit' mục

        const [vocabRes, subVocabRes] = await Promise.all([
            supabase
                .from("profile_vocab_progress")
                .select(`
                    proficiency,
                    vocab:vocab_id (
                        *,
                        root:root_id (
                            id,
                            root_code,
                            root_meaning
                        ),
                        vocab_senses (*)
                    )
                `)
                .eq("profile_id", userId)
                .order("proficiency", {ascending: true})
                .limit(Math.max(limit, 5)),
            supabase
                .from("profile_sub_vocab_progress")
                .select(`
                    proficiency,
                    subvocab:sub_vocab_id (
                        *,
                        vocab_senses:sub_vocab_sense (*),
                        sub_root:sub_root_id (
                            id,
                            vocab:vocab_id (
                                id,
                                root:root_id (
                                    id,
                                    root_code,
                                    root_meaning
                                )
                            )
                        )
                    )
                `)
                .eq("profile_id", userId)
                .order("proficiency", {ascending: true})
                .limit(Math.max(limit, 5)),
        ] as const);

        const vocabError = (vocabRes as any).error;
        const subVocabError = (subVocabRes as any).error;

        if (vocabError) throw vocabError;
        if (subVocabError) throw subVocabError;

        const vocabRows = (vocabRes as any).data ?? [];
        const subVocabRows = (subVocabRes as any).data ?? [];

        type RankedItem = { proficiency: number; item: any };

        const ranked: RankedItem[] = [];

        for (const r of vocabRows) {
            const p = typeof r.proficiency === "number" ? r.proficiency : 0;
            ranked.push({proficiency: p, item: r.vocab});
        }

        for (const r of subVocabRows) {
            const p = typeof r.proficiency === "number" ? r.proficiency : 0;
            // Chuẩn hoá một số trường để client xử lý thống nhất
            // Thêm trường root nếu có thể lấy được qua sub_root.vocab.root
            // if (r.subvocab?.sub_root?.vocab?.root) {
            //         r.subvocab.root = r.subvocab.sub_root.vocab.root;
            // }
            ranked.push({proficiency: p, item: r.subvocab});
        }

        ranked.sort((a, b) => (a.proficiency ?? 0) - (b.proficiency ?? 0));

        return ranked.slice(0, limit).map((x) => x.item);
    }

    // Check if the user has learned any new vocab today (UTC)
    async function hasLearnedNewVocabToday(
        userId: string,
        supabase: SupabaseClient<any, "public", "public", any, any>,
    ) {
        const now = new Date();
        const startOfTodayUTC = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            0,
            0,
            0,
            0,
        ));

        const {count, error} = await supabase
            .from("profile_vocab_progress")
            .select("vocab_id", {count: "exact", head: true})
            .eq("profile_id", userId)
            .gte("last_seen_at", startOfTodayUTC.toISOString());

        if (error) throw error;
        return (count ?? 0) > 0;
    }

    if (req.method === "OPTIONS") {
        // Handle CORS preflight requests
        return new Response("ok", {headers: corsHeaders});
    }

    const supabaseClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        {
            global: {
                headers: {Authorization: req.headers.get("Authorization")!},
            },
        },
    );

    try {
        const user = await getUser(supabaseClient, Deno, req);
        console.log({user});

        if (!user) {
            return new Response(JSON.stringify({error: "Unauthorized"}), {
                status: 401,
                headers: {...corsHeaders, "Content-Type": "application/json"},
            });
        }

        console.log("Fetching progressing root for user:", user.id);
        let progressingRoot = await findProgressingRoot(user.id, supabaseClient);
        let randomWords = [];
        let reviewWords = [];
        let newRoot = null;
        const apiKey = Deno.env.get("OPENAI_API_KEY");

        if (progressingRoot.length == 0) {
            newRoot = await addNewProgressingRoot(user.id, supabaseClient);
            if (newRoot) {
                progressingRoot.push(newRoot);
            }
        }

        console.log({progressingRoot});

        // kiểm tra nếu như trong ngày hôm đó người dùng đã học từ mới rồi thì không lấy từ mới nữa mà chỉ lấy từ 10 review
        const learnedToday = await hasLearnedNewVocabToday(user.id, supabaseClient);

        if (learnedToday) {
            randomWords = [];
            reviewWords = await getReviewWords(
                user.id,
                supabaseClient,
                10,
            );
        } else {
            if (progressingRoot.length > 0) {
                [randomWords, reviewWords] = await Promise.all([
                    getRandomVocabByRoot(
                        user.id,
                        progressingRoot.map((r: any) => r.root_id),
                        supabaseClient,
                    ),
                    getReviewWords(
                        user.id,
                        supabaseClient,
                    ),
                ]);

                // if no random words, mark this root as not learning
                if (randomWords && randomWords.length == 0) {
                    // all words for this root have been learned, mark this root as not learning
                    const {error} = await supabaseClient
                        .from("profile_root_progress")
                        .update({is_learning: false})
                        .eq("profile_id", user.id)
                        .eq("root_id", progressingRoot[0].root_id);

                    if (error) {
                        throw error;
                    }

                    progressingRoot = [];
                    randomWords = [];
                    reviewWords = await getReviewWords(
                        user.id,
                        supabaseClient,
                        10,
                    );
                }
            } else {
                reviewWords = await getReviewWords(
                    user.id,
                    supabaseClient,
                    10,
                );
            }
        }

        const allWords = [...(randomWords || []), ...(reviewWords || [])];

        const openai = new OpenAI({
            apiKey: apiKey,
        });

        const allSenses = allWords.flatMap((w: any) =>
            w.vocab_senses
                ? w.vocab_senses.map((s: any) => ({
                    vocab_id: w.id,
                    word: s.word,
                    definition: s.definition,
                }))
                : []
        );

        // const respTest = await test();
        // return new Response(JSON.stringify({
        //     ...respTest,
        //     // questions: JSON.parse(raw),
        //
        // }), {
        //     headers: {...corsHeaders, "Content-Type": "application/json"},
        // });

        // ========== TEMPORARY DISABLE AI QUESTION GENERATION ==========

        const response = await openai.responses.create({
            model: "gpt-4o",
            prompt: {
                id: "pmpt_68537407f234819691ff9829e4209ea008585d5829f3b9db",
                version: "11",
            },
            input: [
                {
                    role: "user",
                    content: JSON.stringify(allSenses),
                },
            ],
        });

        const raw = response.output_text.replace(/```json|```/g, "").trim();

        return new Response(
             JSON.stringify({
                 newRoot: newRoot,
                 newWords: randomWords,
                 reviewWords,
                 allWords,
                  // allSenses,
                questions: JSON.parse(raw),
             }),
             {
                 headers: {...corsHeaders, "Content-Type": "application/json"},
             },
         );
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({error: e}), {
            status: 400,
            headers: {...corsHeaders, "Content-Type": "application/json"},
        });
    }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/get_questions' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/


const test = async () => {
    const resp = {
        "newRoot": null,
        "newWords": [
            {
                "id": "4a50a59a-9415-42f9-9127-f019082aa846",
                "root_id": "8ecfe6b1-9d37-463b-a21a-12afe0f0790b",
                "word": "advocate",
                "prefix": "ad",
                "infix": "voc",
                "postfix": "ate",
                "prefix_meaning": "hướng đến",
                "infix_meaning": "âm thanh/tiếng nói",
                "postfix_meaning": "biến thành động từ",
                "phonetic": "/ˈæd.və.keɪt/",
                "created_at": "2025-10-22T13:35:10.931824+00:00",
                "vocab_senses": [
                    {
                        "id": "2472783f-a116-4661-9983-0d831ce7fc32",
                        "pos": "v",
                        "word": "advocate",
                        "definition": "ủng hộ, biện hộ"
                    },
                    {
                        "id": "f51b5d35-1d16-464c-b512-98b5d2699d40",
                        "pos": "n",
                        "word": "advocate",
                        "definition": "người biện hộ, người ủng hộ"
                    }
                ]
            },
            {
                "id": "7aba5189-33a2-435d-98bb-28e44695ec12",
                "sub_root_id": "fb3e2eda-8837-4fe2-9fca-748d712cc0e3",
                "word": "vocation",
                "prefix": "",
                "infix": "voc",
                "postfix": "tion",
                "prefix_meaning": "",
                "infix_meaning": "âm thanh/tiếng nói",
                "postfix_meaning": "danh từ",
                "phonetic": "/vəʊˈkeɪʃn/",
                "created_at": "2025-10-22T13:35:10.931824+00:00",
                "vocab_senses": [
                    {
                        "id": "4b7b2c37-7dd1-4f85-a624-9e27cb0f1514",
                        "pos": "n",
                        "word": "vocation",
                        "created_at": "2025-10-22T13:35:10.931824+00:00",
                        "definition": "nghề nghiệp; thiên hướng",
                        "sense_order": 0,
                        "sub_vocab_id": "7aba5189-33a2-435d-98bb-28e44695ec12"
                    }
                ],
                "parent_vocab_id": "4a50a59a-9415-42f9-9127-f019082aa846"
            }
        ],
        "reviewWords": [],
        "allWords": [
            {
                "id": "4a50a59a-9415-42f9-9127-f019082aa846",
                "root_id": "8ecfe6b1-9d37-463b-a21a-12afe0f0790b",
                "word": "advocate",
                "prefix": "ad",
                "infix": "voc",
                "postfix": "ate",
                "prefix_meaning": "hướng đến",
                "infix_meaning": "âm thanh/tiếng nói",
                "postfix_meaning": "biến thành động từ",
                "phonetic": "/ˈæd.və.keɪt/",
                "created_at": "2025-10-22T13:35:10.931824+00:00",
                "vocab_senses": [
                    {
                        "id": "2472783f-a116-4661-9983-0d831ce7fc32",
                        "pos": "v",
                        "word": "advocate",
                        "definition": "ủng hộ, biện hộ"
                    },
                    {
                        "id": "f51b5d35-1d16-464c-b512-98b5d2699d40",
                        "pos": "n",
                        "word": "advocate",
                        "definition": "người biện hộ, người ủng hộ"
                    }
                ]
            },
            {
                "id": "7aba5189-33a2-435d-98bb-28e44695ec12",
                "sub_root_id": "fb3e2eda-8837-4fe2-9fca-748d712cc0e3",
                "word": "vocation",
                "prefix": "",
                "infix": "voc",
                "postfix": "tion",
                "prefix_meaning": "",
                "infix_meaning": "âm thanh/tiếng nói",
                "postfix_meaning": "danh từ",
                "phonetic": "/vəʊˈkeɪʃn/",
                "created_at": "2025-10-22T13:35:10.931824+00:00",
                "vocab_senses": [
                    {
                        "id": "4b7b2c37-7dd1-4f85-a624-9e27cb0f1514",
                        "pos": "n",
                        "word": "vocation",
                        "created_at": "2025-10-22T13:35:10.931824+00:00",
                        "definition": "nghề nghiệp; thiên hướng",
                        "sense_order": 0,
                        "sub_vocab_id": "7aba5189-33a2-435d-98bb-28e44695ec12"
                    }
                ],
                "parent_vocab_id": "4a50a59a-9415-42f9-9127-f019082aa846"
            }
        ],
        "questions": [
            {
                "question": "Anh ấy thường xuyên !empty cho quyền động vật trên khắp thế giới.",
                "answer_blocks": [
                    "vocation",
                    "advocate",
                    "departure",
                    "deprive"
                ],
                "correct_answer": "advocate",
                "type": "fill_in_blank",
                "vocab_id": "4a50a59a-9415-42f9-9127-f019082aa846"
            },
            {
                "question": "Nghĩa nào sau đây là nghĩa của từ 'advocate'?",
                "answer_blocks": [
                    "ủng hộ, biện hộ",
                    "khởi hành",
                    "nghề nghiệp",
                    "cướp bóc"
                ],
                "correct_answer": "ủng hộ, biện hộ",
                "type": "multiple_choice",
                "vocab_id": "4a50a59a-9415-42f9-9127-f019082aa846"
            },
            {
                "question": "Cô ấy tìm thấy niềm đam mê thực sự của mình trong lĩnh vực y tế, đó chính là !empty.",
                "answer_blocks": [
                    "vocation",
                    "departure",
                    "advocate",
                    "deprive"
                ],
                "correct_answer": "vocation",
                "type": "fill_in_blank",
                "vocab_id": "7aba5189-33a2-435d-98bb-28e44695ec12"
            },
            {
                "question": "Nghĩa nào sau đây là nghĩa của từ 'vocation'?",
                "answer_blocks": [
                    "nghề nghiệp; thiên hướng",
                    "cướp bóc",
                    "khởi hành",
                    "ủng hộ, biện hộ"
                ],
                "correct_answer": "nghề nghiệp; thiên hướng",
                "type": "multiple_choice",
                "vocab_id": "7aba5189-33a2-435d-98bb-28e44695ec12"
            }
        ]
    }
    return resp
}