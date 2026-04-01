import { redirect } from "next/navigation";

/** Cal is configured via env (`BOOKING_LINK`). Old sidebar link redirects here — send operators to the dashboard. */
export default function CalSetupPage() {
  redirect("/dashboard");
}
