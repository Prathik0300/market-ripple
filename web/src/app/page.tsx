import { redirect } from "next/navigation";

// Signed-in, two-factor-verified users land on the desks (the middleware has already checked both).
export default function Home() {
  redirect("/desk");
}
