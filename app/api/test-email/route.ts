import { NextResponse } from "next/server";
import { Resend } from "resend";
import { withOutreachSignature } from "@/services/outreachSendService";
import { blockInProductionUnlessEnabled, requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { getEffectiveOutreachDryRun } from "@/services/outreachDryRunService";

const TEST_TO = "timothyjkroh@gmail.com";
const SUBJECT = "Gloria test email";
const BODY = "This is a direct Resend integration test.";

export async function GET(request: Request) {
  const blocked = blockInProductionUnlessEnabled("ALLOW_TEST_EMAIL_ROUTE");
  if (blocked) return blocked;
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;
  const resendApiKey = process.env.RESEND_API_KEY ?? "";
  const fromEmail = process.env.OUTREACH_FROM_EMAIL ?? "";
  const replyToEmail = process.env.OUTREACH_REPLY_TO_EMAIL ?? "";
  const dryRun = await getEffectiveOutreachDryRun();

  console.log("[test-email] RESEND_API_KEY present:", Boolean(resendApiKey && resendApiKey.length > 0));
  console.log("[test-email] RESEND_API_KEY prefix:", resendApiKey ? `${resendApiKey.slice(0, 4)}…` : "(empty)");
  console.log("[test-email] effective dry run:", dryRun);
  console.log("[test-email] OUTREACH_FROM_EMAIL:", fromEmail || "(empty)");
  console.log("[test-email] OUTREACH_REPLY_TO_EMAIL:", replyToEmail || "(empty)");

  if (dryRun) {
    return NextResponse.json({
      skipped: true,
      reason: "Effective dry run is on (DRY_RUN env and/or dashboard override) — send skipped.",
      debug: {
        resendApiKeyPresent: Boolean(resendApiKey),
        dryRun,
        fromEmail: fromEmail || null,
        replyToEmail: replyToEmail || null
      }
    });
  }

  if (!resendApiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "RESEND_API_KEY is missing or empty.",
        debug: { resendApiKeyPresent: false, dryRun, fromEmail: fromEmail || null }
      },
      { status: 400 }
    );
  }

  const resend = new Resend(resendApiKey);

  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to: TEST_TO,
      replyTo: replyToEmail,
      subject: SUBJECT,
      text: withOutreachSignature(BODY)
    });

    console.log("[test-email] Resend result:", JSON.stringify(result, null, 2));

    const resendError = result && typeof result === "object" && "error" in result ? result.error : null;
    if (resendError) {
      const status =
        typeof resendError === "object" && resendError !== null && "statusCode" in resendError
          ? Number((resendError as { statusCode?: number }).statusCode) || 502
          : 502;
      return NextResponse.json(
        {
          ok: false,
          resend: result,
          message: "Resend returned an error (see resend.error). Common fix: use a valid API key from Resend dashboard — keys start with re_.",
          debug: {
            resendApiKeyPresent: true,
            dryRun,
            fromEmail: fromEmail || null,
            replyToEmail: replyToEmail || null,
            to: TEST_TO
          }
        },
        { status }
      );
    }

    return NextResponse.json({
      ok: true,
      resend: result,
      debug: {
        resendApiKeyPresent: true,
        dryRun,
        fromEmail: fromEmail || null,
        replyToEmail: replyToEmail || null,
        to: TEST_TO
      }
    });
  } catch (err) {
    const base =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack ?? null }
        : { message: String(err) };
    let extra: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      try {
        extra = JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
      } catch {
        extra = { stringifyFailed: true };
      }
    }
    const serialized = { ...base, ...extra };

    console.error("[test-email] Send failed:", serialized);

    return NextResponse.json(
      {
        ok: false,
        error: serialized,
        debug: {
          resendApiKeyPresent: true,
          dryRun,
          fromEmail: fromEmail || null,
          replyToEmail: replyToEmail || null
        }
      },
      { status: 500 }
    );
  }
}
