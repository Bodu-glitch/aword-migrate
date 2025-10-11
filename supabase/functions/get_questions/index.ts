// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { getUser } from "../_shared/get-user.ts";
import OpenAI from "jsr:@openai/openai";

console.log("Hello from Functions!");

Deno.serve(async (req) => {
  async function findProgressingRoot(
    userId: string,
    supabase: SupabaseClient<any, "public", "public", any, any>,
  ) {
    const { data, error } = await supabase
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
    const { data: existingRoots, error: existingRootsError } = await supabase
      .from("profile_root_progress")
      .select("root_id")
      .eq("profile_id", userId);

    if (existingRootsError) {
      throw existingRootsError;
    }

    const existingRootIds = existingRoots?.map((r) => r.root_id) || [];

    const { data: newRoots, error: newRootsError } = await supabase
      .rpc("get_random_root", {
        exclude_ids: existingRootIds,
      });

    if (newRootsError) {
      console.log("Error fetching new roots:", newRootsError);
      throw newRootsError;
    }

    if (newRoots && newRoots.length > 0) {
      const newRoot = newRoots[0];
      const { data: insertData, error: insertError } = await supabase
        .from("profile_root_progress")
        .insert({
          profile_id: userId,
          root_id: newRoot.id,
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
    const { data, error } = await supabase
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
    const { data: vocabData, error: vocabError } = await supabase
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
    const { data, error } = await supabase
      .from("profile_vocab_progress")
      .select(`
      proficiency,
      vocab:vocab_id (
        *,
        root:root_id (
          id,
          root_code,
          root_meaning
        )
      )
    `)
      .eq("profile_id", userId)
      .order("proficiency", { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    return data?.map((p) => p.vocab) || [];
  }

  if (req.method === "OPTIONS") {
    // Handle CORS preflight requests
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! },
      },
    },
  );

  try {
    const user = await getUser(supabaseClient, Deno, req);
    console.log({ user });

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    console.log({ progressingRoot });

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
        const { error } = await supabaseClient
          .from("profile_root_progress")
          .update({ is_learning: false })
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

    const allWords = [...(randomWords || []), ...(reviewWords || [])];

    const openai = new OpenAI({
      apiKey: apiKey,
    });

    const allSenses = allWords.flatMap((w) =>
      w.vocab_senses
        ? w.vocab_senses.map((s) => ({
          word: s.word,
          definition: s.definition,
        }))
        : []
    );

    const response = await openai.responses.create({
      model: "gpt-4o",
      prompt: {
        id: "pmpt_68537407f234819691ff9829e4209ea008585d5829f3b9db",
        version: "8",
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
        allWords,
        // allSenses,
        questions: JSON.parse(raw),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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
