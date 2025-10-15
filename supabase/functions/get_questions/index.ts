// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient, SupabaseClient} from "npm:@supabase/supabase-js@2";
import {corsHeaders} from "../_shared/cors.ts";
import {getUser} from "../_shared/get-user.ts";
import OpenAI from "jsr:@openai/openai";

console.log("Hello from Functions!");

Deno.serve(async (req) => {
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

        const existingRootIds = existingRoots?.map((r) => r.root_id) || [];

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
        supabase: SupabaseClient<any, "public", "public", any, any>,
    ) {
        // get words already learned by user
        const {data, error} = await supabase
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

        if (error) {
            throw error;
        }
        const learnedVocabIds = data?.map((p) => p.vocab.id) || [];

        // call the get_random_vocab_by_roots rpc function
        const {data: vocabData, error: vocabError} = await supabase
            .rpc("get_random_vocab_by_roots", {
                root_ids: rootIds,
                exclude_ids: learnedVocabIds,
                limit_count: 5,
            });

        if (vocabError) {
            throw vocabError;
        }

        console.log("Learned vocab IDs:", vocabData);

        return vocabData;
    }

    async function getReviewWords(
        userId: string,
        supabase: SupabaseClient<any, "public", "public", any, any>,
        limit = 5,
    ) {
        // get words due for review by user
        const {data, error} = await supabase
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
            .limit(limit);

        if (error) {
            throw error;
        }

        return data?.map((p) => p.vocab) || [];
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
                        progressingRoot.map((r) => r.root_id),
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

        const allSenses = allWords.flatMap((w) =>
            w.vocab_senses
                ? w.vocab_senses.map((s) => ({
                    vocab_id: w.id,
                    word: s.word,
                    definition: s.definition,
                }))
                : []
        );

        const respTest = await test();
        return new Response(JSON.stringify({
            ...respTest,
            // questions: JSON.parse(raw),

        }), {
            headers: {...corsHeaders, "Content-Type": "application/json"},
        });

        // ========== TEMPORARY DISABLE AI QUESTION GENERATION ==========

        // const response = await openai.responses.create({
        //     model: "gpt-4o",
        //     prompt: {
        //         id: "pmpt_68537407f234819691ff9829e4209ea008585d5829f3b9db",
        //         version: "11",
        //     },
        //     input: [
        //         {
        //             role: "user",
        //             content: JSON.stringify(allSenses),
        //         },
        //     ],
        // });
        //
        // const raw = response.output_text.replace(/```json|```/g, "").trim();

        // return new Response(
        //     JSON.stringify({
        //         newRoot: newRoot,
        //         newWords: randomWords,
        //         reviewWords,
        //         allWords,
        //         // allSenses,
        //         questions: JSON.parse(raw),
        //     }),
        //     {
        //         headers: {...corsHeaders, "Content-Type": "application/json"},
        //     },
        // );
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
        "newWords": [],
        "reviewWords": [
            {
                "id": "f65327c1-037d-47fd-9835-3261e4be278b",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "depart",
                "infix": "part",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈpɑːt/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "b9a7e605-9897-4fa2-9c41-9e55e31c8d4b",
                        "pos": "v",
                        "word": "depart",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "khởi hành",
                        "sense_order": 0
                    },
                    {
                        "id": "bd034464-ba8e-4e59-9c58-950c4c8dfd82",
                        "pos": "n",
                        "word": "departure",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "việc khởi hành",
                        "sense_order": 1
                    },
                    {
                        "id": "db902b75-a7f3-4d43-8818-f11b6c2f67db",
                        "pos": "n",
                        "word": "department",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "bộ môn, sở,cục,khoa",
                        "sense_order": 2
                    }
                ],
                "infix_meaning": "chia tách",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "submarine",
                "infix": "marine",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbməˈriːn/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "0f21c7ab-86c2-4182-abf3-c390cf88bbcd",
                        "pos": "n",
                        "word": "submarine",
                        "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tàu ngầm",
                        "sense_order": 0
                    },
                    {
                        "id": "fa2da6c9-7d8d-478a-8265-cd1bd984f24f",
                        "pos": "adj",
                        "word": "submarine",
                        "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dưới đáy biển",
                        "sense_order": 1
                    }
                ],
                "infix_meaning": "biển",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "d0783726-9437-4161-9594-e58d40a46eef",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "declare",
                "infix": "clare",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈkleə(r)/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "4189d559-c61a-40fb-ba92-e0e0a629b5de",
                        "pos": "v",
                        "word": "declare",
                        "vocab_id": "d0783726-9437-4161-9594-e58d40a46eef",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tuyên bố, khai báo",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "rõ ràng",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subcommittee",
                "infix": "committee",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˈsʌbkəˌmɪti/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "2e7919ee-e79b-4e44-a9f9-4c647a4e2fa3",
                        "pos": "n",
                        "word": "subcommittee",
                        "vocab_id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tiểu ban",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "ủy ban",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subnormal",
                "infix": "normal",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbˈnɔːməl/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e9a5cfc0-379c-44cc-80c5-84b6a8caf812",
                        "pos": "adj",
                        "word": "subnormal",
                        "vocab_id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dưới mức tiêu chuẩn",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "tiêu chuẩn",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "sustain",
                "infix": "tain",
                "prefix": "sus",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/səˈsteɪn/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "90bc297f-0d9e-46c3-8354-97f000566b40",
                        "pos": "v",
                        "word": "sustain",
                        "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "đỡ, duy trì, chịu đựng, gìn giữ",
                        "sense_order": 0
                    },
                    {
                        "id": "3813103d-1942-4a5e-a587-cd941bdde85b",
                        "pos": "n",
                        "word": "sustenance",
                        "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "thực phẩm, phương tiện sự sống, duy trì sự sống",
                        "sense_order": 1
                    }
                ],
                "infix_meaning": "giữ/bảo vệ",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "substitute",
                "infix": "stitute",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˈsʌbstɪtjuːt/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e5933921-bcfa-45fd-bc2f-c524d6fe8c0f",
                        "pos": "adj",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "có tính thay thế",
                        "sense_order": 0
                    },
                    {
                        "id": "d9b3ea16-9cce-4b7d-baae-322b008b6c78",
                        "pos": "v",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dùng thay thế",
                        "sense_order": 1
                    },
                    {
                        "id": "2d8d47ac-9e2e-4cde-b168-52795f35a783",
                        "pos": "n",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "vật thay thế, bổ sung",
                        "sense_order": 2
                    }
                ],
                "infix_meaning": "đứng",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "4c91be81-abb0-4dff-b10d-0580f55f62fa",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "suburban",
                "infix": "urban",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/səˈbɜːbən/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "0e9c82c1-a809-4462-b744-ff34311a0b4a",
                        "pos": "adj",
                        "word": "suburban",
                        "vocab_id": "4c91be81-abb0-4dff-b10d-0580f55f62fa",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "(thuộc) khu ngoại ô",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "đô thị",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "6021d8d5-5f72-4caf-8d62-d436407974c2",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "degrade",
                "infix": "grade",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈɡreɪd/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "ff0be9fe-6db2-4400-b732-6040425fa7df",
                        "pos": "v",
                        "word": "degrade",
                        "vocab_id": "6021d8d5-5f72-4caf-8d62-d436407974c2",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "hạ thấp địa vị, giáng chức",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "giai đoạn/ mức độ",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subtropical",
                "infix": "tropical",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbˈtrɒpɪkəl/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e60cd0fa-524f-48b0-8858-995d760fe46a",
                        "pos": "adj",
                        "word": "subtropical",
                        "vocab_id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "cận nhiệt đới",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "nhiệt đới",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            }
        ],
        "allWords": [
            {
                "id": "f65327c1-037d-47fd-9835-3261e4be278b",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "depart",
                "infix": "part",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈpɑːt/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "b9a7e605-9897-4fa2-9c41-9e55e31c8d4b",
                        "pos": "v",
                        "word": "depart",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "khởi hành",
                        "sense_order": 0
                    },
                    {
                        "id": "bd034464-ba8e-4e59-9c58-950c4c8dfd82",
                        "pos": "n",
                        "word": "departure",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "việc khởi hành",
                        "sense_order": 1
                    },
                    {
                        "id": "db902b75-a7f3-4d43-8818-f11b6c2f67db",
                        "pos": "n",
                        "word": "department",
                        "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "bộ môn, sở,cục,khoa",
                        "sense_order": 2
                    }
                ],
                "infix_meaning": "chia tách",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "submarine",
                "infix": "marine",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbməˈriːn/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "0f21c7ab-86c2-4182-abf3-c390cf88bbcd",
                        "pos": "n",
                        "word": "submarine",
                        "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tàu ngầm",
                        "sense_order": 0
                    },
                    {
                        "id": "fa2da6c9-7d8d-478a-8265-cd1bd984f24f",
                        "pos": "adj",
                        "word": "submarine",
                        "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dưới đáy biển",
                        "sense_order": 1
                    }
                ],
                "infix_meaning": "biển",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "d0783726-9437-4161-9594-e58d40a46eef",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "declare",
                "infix": "clare",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈkleə(r)/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "4189d559-c61a-40fb-ba92-e0e0a629b5de",
                        "pos": "v",
                        "word": "declare",
                        "vocab_id": "d0783726-9437-4161-9594-e58d40a46eef",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tuyên bố, khai báo",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "rõ ràng",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subcommittee",
                "infix": "committee",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˈsʌbkəˌmɪti/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "2e7919ee-e79b-4e44-a9f9-4c647a4e2fa3",
                        "pos": "n",
                        "word": "subcommittee",
                        "vocab_id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "tiểu ban",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "ủy ban",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subnormal",
                "infix": "normal",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbˈnɔːməl/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e9a5cfc0-379c-44cc-80c5-84b6a8caf812",
                        "pos": "adj",
                        "word": "subnormal",
                        "vocab_id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dưới mức tiêu chuẩn",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "tiêu chuẩn",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "sustain",
                "infix": "tain",
                "prefix": "sus",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/səˈsteɪn/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "90bc297f-0d9e-46c3-8354-97f000566b40",
                        "pos": "v",
                        "word": "sustain",
                        "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "đỡ, duy trì, chịu đựng, gìn giữ",
                        "sense_order": 0
                    },
                    {
                        "id": "3813103d-1942-4a5e-a587-cd941bdde85b",
                        "pos": "n",
                        "word": "sustenance",
                        "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "thực phẩm, phương tiện sự sống, duy trì sự sống",
                        "sense_order": 1
                    }
                ],
                "infix_meaning": "giữ/bảo vệ",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "substitute",
                "infix": "stitute",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˈsʌbstɪtjuːt/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e5933921-bcfa-45fd-bc2f-c524d6fe8c0f",
                        "pos": "adj",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "có tính thay thế",
                        "sense_order": 0
                    },
                    {
                        "id": "d9b3ea16-9cce-4b7d-baae-322b008b6c78",
                        "pos": "v",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "dùng thay thế",
                        "sense_order": 1
                    },
                    {
                        "id": "2d8d47ac-9e2e-4cde-b168-52795f35a783",
                        "pos": "n",
                        "word": "substitute",
                        "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "vật thay thế, bổ sung",
                        "sense_order": 2
                    }
                ],
                "infix_meaning": "đứng",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "4c91be81-abb0-4dff-b10d-0580f55f62fa",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "suburban",
                "infix": "urban",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/səˈbɜːbən/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "0e9c82c1-a809-4462-b744-ff34311a0b4a",
                        "pos": "adj",
                        "word": "suburban",
                        "vocab_id": "4c91be81-abb0-4dff-b10d-0580f55f62fa",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "(thuộc) khu ngoại ô",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "đô thị",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "6021d8d5-5f72-4caf-8d62-d436407974c2",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "degrade",
                "infix": "grade",
                "prefix": "de",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/dɪˈɡreɪd/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "ff0be9fe-6db2-4400-b732-6040425fa7df",
                        "pos": "v",
                        "word": "degrade",
                        "vocab_id": "6021d8d5-5f72-4caf-8d62-d436407974c2",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "hạ thấp địa vị, giáng chức",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "giai đoạn/ mức độ",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            },
            {
                "id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9",
                "root": {
                    "id": "bba8d988-3528-4298-a743-3f73815000e7",
                    "root_code": "de-, sub-",
                    "root_meaning": "bên dưới"
                },
                "word": "subtropical",
                "infix": "tropical",
                "prefix": "sub",
                "postfix": "",
                "root_id": "bba8d988-3528-4298-a743-3f73815000e7",
                "phonetic": "/ˌsʌbˈtrɒpɪkəl/",
                "created_at": "2025-10-14T21:57:12.444378+00:00",
                "vocab_senses": [
                    {
                        "id": "e60cd0fa-524f-48b0-8858-995d760fe46a",
                        "pos": "adj",
                        "word": "subtropical",
                        "vocab_id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9",
                        "created_at": "2025-10-14T21:57:12.444378+00:00",
                        "definition": "cận nhiệt đới",
                        "sense_order": 0
                    }
                ],
                "infix_meaning": "nhiệt đới",
                "prefix_meaning": "bên dưới",
                "postfix_meaning": ""
            }
        ],
        "allSenses": [
            {
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                "word": "depart",
                "definition": "khởi hành"
            },
            {
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                "word": "departure",
                "definition": "việc khởi hành"
            },
            {
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b",
                "word": "department",
                "definition": "bộ môn, sở,cục,khoa"
            },
            {
                "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                "word": "submarine",
                "definition": "tàu ngầm"
            },
            {
                "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099",
                "word": "submarine",
                "definition": "dưới đáy biển"
            },
            {
                "vocab_id": "d0783726-9437-4161-9594-e58d40a46eef",
                "word": "declare",
                "definition": "tuyên bố, khai báo"
            },
            {
                "vocab_id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc",
                "word": "subcommittee",
                "definition": "tiểu ban"
            },
            {
                "vocab_id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5",
                "word": "subnormal",
                "definition": "dưới mức tiêu chuẩn"
            },
            {
                "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                "word": "sustain",
                "definition": "đỡ, duy trì, chịu đựng, gìn giữ"
            },
            {
                "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d",
                "word": "sustenance",
                "definition": "thực phẩm, phương tiện sự sống, duy trì sự sống"
            },
            {
                "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                "word": "substitute",
                "definition": "có tính thay thế"
            },
            {
                "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                "word": "substitute",
                "definition": "dùng thay thế"
            },
            {
                "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f",
                "word": "substitute",
                "definition": "vật thay thế, bổ sung"
            },
            {
                "vocab_id": "4c91be81-abb0-4dff-b10d-0580f55f62fa",
                "word": "suburban",
                "definition": "(thuộc) khu ngoại ô"
            },
            {
                "vocab_id": "6021d8d5-5f72-4caf-8d62-d436407974c2",
                "word": "degrade",
                "definition": "hạ thấp địa vị, giáng chức"
            },
            {
                "vocab_id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9",
                "word": "subtropical",
                "definition": "cận nhiệt đới"
            }
        ],
        "questions": [
            {
                "question": "The team will !empty the meeting at noon.",
                "answer_blocks": [
                    "depart",
                    "departed",
                    "departing",
                    "departures"
                ],
                "correct_answer": "depart",
                "type": "fill_in_blank",
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b"
            },
            {
                "question": "What is the meaning of the word 'departure'?",
                "answer_blocks": [
                    "tiểu ban",
                    "bộ môn, sở,cục,khoa",
                    "việc khởi hành",
                    "dưới mức tiêu chuẩn"
                ],
                "correct_answer": "việc khởi hành",
                "type": "multiple_choice",
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b"
            },
            {
                "question": "The new !empty will focus on sustainable development.",
                "answer_blocks": [
                    "suburban",
                    "degrade",
                    "department",
                    "subtropical"
                ],
                "correct_answer": "department",
                "type": "fill_in_blank",
                "vocab_id": "f65327c1-037d-47fd-9835-3261e4be278b"
            },
            {
                "question": "What is the definition of the word 'submarine'?",
                "answer_blocks": [
                    "tàu ngầm",
                    "bộ môn, sở,cục,khoa",
                    "dưới mức tiêu chuẩn",
                    "thuộc khu ngoại ô"
                ],
                "correct_answer": "tàu ngầm",
                "type": "multiple_choice",
                "vocab_id": "c6fee8d6-e72a-4897-b28e-0a03fde65099"
            },
            {
                "question": "The document was !empty for further analysis.",
                "answer_blocks": [
                    "declare",
                    "declared",
                    "declaring",
                    "declaration"
                ],
                "correct_answer": "declared",
                "type": "fill_in_blank",
                "vocab_id": "d0783726-9437-4161-9594-e58d40a46eef"
            },
            {
                "question": "What does the word 'subtropical' refer to?",
                "answer_blocks": [
                    "cận nhiệt đới",
                    "dưới đáy biển",
                    "bộ môn, sở,cục,khoa",
                    "thực phẩm, phương tiện sự sống"
                ],
                "correct_answer": "cận nhiệt đới",
                "type": "multiple_choice",
                "vocab_id": "97edf217-2e2c-46a7-8862-2eb2eff0c9d9"
            },
            {
                "question": "The committee formed a !empty to address specific issues.",
                "answer_blocks": [
                    "subtropical",
                    "subcommittee",
                    "suburban",
                    "submarine"
                ],
                "correct_answer": "subcommittee",
                "type": "fill_in_blank",
                "vocab_id": "b8a73356-e816-4e68-85ff-5ddc1f9015dc"
            },
            {
                "question": "Choose the correct meaning of 'sustenance'.",
                "answer_blocks": [
                    "hạ thấp địa vị, giáng chức",
                    "cận nhiệt đới",
                    "thực phẩm, phương tiện sự sống, duy trì sự sống",
                    "tiểu ban"
                ],
                "correct_answer": "thực phẩm, phương tiện sự sống, duy trì sự sống",
                "type": "multiple_choice",
                "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d"
            },
            {
                "question": "The report aims to !empty the issues discussed.",
                "answer_blocks": [
                    "sustain",
                    "sustenance",
                    "sustaining",
                    "sustained"
                ],
                "correct_answer": "sustain",
                "type": "fill_in_blank",
                "vocab_id": "384f6582-6cdb-4784-9a13-70c5e5e1447d"
            },
            {
                "question": "What is the meaning of the word 'subnormal'?",
                "answer_blocks": [
                    "dưới mức tiêu chuẩn",
                    "bộ môn, sở,cục,khoa",
                    "việc khởi hành",
                    "tiểu ban"
                ],
                "correct_answer": "dưới mức tiêu chuẩn",
                "type": "multiple_choice",
                "vocab_id": "9f72d58c-5c57-4a44-ac2d-5bb764b5fdb5"
            },
            {
                "question": "We need to find a !empty teacher for the class.",
                "answer_blocks": [
                    "subsequent",
                    "subcommittee",
                    "substitute",
                    "submarine"
                ],
                "correct_answer": "substitute",
                "type": "fill_in_blank",
                "vocab_id": "478e16d2-d6d5-4a92-8fc8-3311f995933f"
            },
            {
                "question": "Select the correct definition for 'suburban'.",
                "answer_blocks": [
                    "(thuộc) khu ngoại ô",
                    "dưới đáy biển",
                    "dưới mức tiêu chuẩn",
                    "cận nhiệt đới"
                ],
                "correct_answer": "(thuộc) khu ngoại ô",
                "type": "multiple_choice",
                "vocab_id": "4c91be81-abb0-4dff-b10d-0580f55f62fa"
            },
            {
                "question": "The company's policies !empty employees of their rights.",
                "answer_blocks": [
                    "degrade",
                    "degraded",
                    "degrading",
                    "degrades"
                ],
                "correct_answer": "degrade",
                "type": "fill_in_blank",
                "vocab_id": "6021d8d5-5f72-4caf-8d62-d436407974c2"
            },
            {
                "question": "What does 'declare' mean?",
                "answer_blocks": [
                    "tuyên bố, khai báo",
                    "bộ môn, sở,cục,khoa",
                    "tiểu ban",
                    "dưới mức tiêu chuẩn"
                ],
                "correct_answer": "tuyên bố, khai báo",
                "type": "multiple_choice",
                "vocab_id": "d0783726-9437-4161-9594-e58d40a46eef"
            }
        ]
    }
    return resp
}