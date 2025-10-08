export const getUser = async (supabaseClient, Deno, req) => {
    try {

        const token = req.headers.get("Authorization").replace("Bearer ", "");

        console.log({token});
        const {
            data: {user},
        } = await supabaseClient.auth.getUser(token);

        console.log({user});
        return user
    } catch (error) {
        return null;
    }
}