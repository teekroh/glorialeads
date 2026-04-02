import { NextResponse } from "next/server";

/**
 * Google **Custom Search JSON API** (not Search Console — that API is for property analytics).
 * Set GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX in .env for inline results; otherwise returns a search-URL fallback.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ ok: false, error: "missing q" }, { status: 400 });

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=50`;
  const key = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_CX?.trim();

  if (!key || !cx) {
    return NextResponse.json({
      ok: true,
      mode: "fallback",
      query: q,
      searchUrl,
      hint: "Add GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX for programmatic results (Custom Search API)."
    });
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("num", "8");

  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  const data = (await res.json()) as { items?: { title?: string; link?: string; snippet?: string }[]; error?: { message?: string } };
  if (!res.ok) {
    return NextResponse.json({
      ok: true,
      mode: "fallback",
      query: q,
      searchUrl,
      apiError: data.error?.message ?? res.statusText
    });
  }

  const items =
    data.items?.map((it) => ({
      title: it.title ?? "",
      link: it.link ?? "",
      snippet: it.snippet ?? ""
    })) ?? [];

  return NextResponse.json({ ok: true, mode: "cse", query: q, searchUrl, items });
}
