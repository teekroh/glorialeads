/**
 * Cal.com event configuration for Gloria’s 15-minute intro funnel.
 * Reference for event naming and BOOKING_LINK; /setup/cal redirects to the dashboard.
 *
 * Target event
 * - Name: Cabinet Project Intro Call
 * - Duration: 15 minutes
 * - URL slug: cabinet-project-intro → full path like https://cal.com/<your-team>/cabinet-project-intro
 * - Location: Google Meet (Connect Google Calendar in Cal.com → use Google Meet as location)
 * - Availability: Weekdays, e.g. 9:00–17:00 in your timezone
 * - Buffer after event: 5–10 minutes (Cal.com → Event type → Advanced → Buffer)
 * - Minimum booking notice: 4–8 hours
 *
 * Environment
 * - Set BOOKING_LINK to the public event URL, e.g.:
 *   BOOKING_LINK=https://cal.com/gloriacabinetry/cabinet-project-intro
 * - For client-side preview of links in the browser (optional): NEXT_PUBLIC_BOOKING_LINK with the same value
 *
 * Webhooks (production)
 * - Add a Cal.com webhook pointing to: https://<your-app>/api/webhooks/cal-booking
 * - Subscribe to booking.created (and optionally booking.rescheduled)
 * - Cal.com will POST a JSON body; we also accept a simplified / mock payload for dev (see calBookingService).
 */

export const CALCOM_EVENT_SLUG = "cabinet-project-intro";
export const CALCOM_EVENT_NAME = "Cabinet Project Intro Call";
export const CALCOM_EVENT_DURATION_MIN = 15;

/** Example BOOKING_LINK for docs only — override with env in production. */
export const CALCOM_BOOKING_LINK_EXAMPLE = "https://cal.com/gloriacabinetry/cabinet-project-intro";
