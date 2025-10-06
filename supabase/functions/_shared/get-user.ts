export const getUser = async (supabaseClient, Deno, req) => {
    try {

        const token = req.headers.get("Authorization").replace("Bearer ", "");

        console.log("Token:", token);
        const {
            data: {user},
        } = await supabaseClient.auth.getUser(token);

        return user
    } catch (error) {
        throw error;
    }
}