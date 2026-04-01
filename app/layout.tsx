import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  /* Use "|" not "-" — unquoted minus in injected metadata has been seen to parse as subtraction, breaking the next word (e.g. "'ashboard"). */
  title: "Gloria Custom Cabinetry | Dashboard",
  description: "Lead qualification, outreach automation, and booking pipeline."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
