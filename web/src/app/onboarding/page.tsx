import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { cleanInterests } from "@/lib/interests";
import InterestsPicker from "../interests-picker";

// Asked once, right after two-factor setup: which areas the main page should lead with.
export default async function Onboarding() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  const { data } = user ? await supabase.from("profiles").select("interests").eq("id", user.id).maybeSingle() : { data: null };
  return (
    <main className="connect">
      <h1>What are you into?</h1>
      <p className="lead">Pick the areas you follow. Your main page then shows the world events, model signals and fresh facts that move
        those areas first, with the rest of the market below. It is a research feed, not buy or sell advice. You can change this any time in Settings.</p>
      <section className="pcard">
        <InterestsPicker initial={cleanInterests(data?.interests)} next="/" action="Continue" />
      </section>
    </main>
  );
}
