import Link from "next/link";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import { cleanInterests } from "@/lib/interests";
import InterestsPicker from "../interests-picker";

export default async function Settings() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  const { data } = user ? await supabase.from("profiles").select("interests").eq("id", user.id).maybeSingle() : { data: null };
  return (
    <main className="connect">
      <Link href="/" className="small">&larr; Back to your main page</Link>
      <h1>Settings</h1>
      <section className="pcard">
        <h2>Your areas</h2>
        <p>The main page leads with what moves these areas. They only order your own page: they never feed the shared model.</p>
        <InterestsPicker initial={cleanInterests(data?.interests)} action="Save" />
      </section>
    </main>
  );
}
