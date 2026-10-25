// Bridges the website appointment service (Cloudflare Worker) with the Apple calendar "Termine extern".

import { addEventWithUid, openCalendarByName, type Credentials } from "./calendar";

export interface TermineConfig {
  baseUrl: string;
  adminToken: string;
  calendarName: string;
}

export interface WebsiteBooking {
  id: string;
  label: string;
  start: number;
  startISO: string;
  email: string;
  status: string;
}

// Eintrag im Kalender: beginnt zur gebuchten Berliner Uhrzeit, dauert 2 Stunden, plus 1 Stunde Wegzeit (Apple-Fahrtzeit).
const APPOINTMENT_MS = 120 * 60_000;
const TRAVEL_MINUTES = 60;
const MAX_PER_RUN = 5;

export function termineConfig(env: { TERMINE_URL?: string; TERMINE_ADMIN_TOKEN?: string; TERMINE_CALENDAR_NAME?: string }): TermineConfig | undefined {
  if (!env.TERMINE_URL || !env.TERMINE_ADMIN_TOKEN) return undefined;
  const url = new URL(env.TERMINE_URL);
  if (url.protocol !== "https:") throw new Error("TERMINE_URL must use https.");
  return { baseUrl: url.origin, adminToken: env.TERMINE_ADMIN_TOKEN, calendarName: env.TERMINE_CALENDAR_NAME?.trim() || "Termine extern" };
}

export async function termineApi<T>(config: TermineConfig, method: string, path: string, body?: unknown, baseFetch: typeof fetch = fetch): Promise<T> {
  const response = await baseFetch(`${config.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${config.adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Terminservice antwortete mit Status ${response.status}.`);
  return (await response.json()) as T;
}

export function bookingToDraft(booking: WebsiteBooking) {
  return {
    title: "Objektbegehung",
    start: booking.startISO,
    end: new Date(booking.start + APPOINTMENT_MS).toISOString(),
    timeZone: "Europe/Berlin",
    reminders: [{ minutesBefore: 2 * 24 * 60 }, { minutesBefore: 120 }],
    travelMinutes: TRAVEL_MINUTES,
    description: `Objektbegehung für ${booking.email}. Eingetragen durch Balou.\nGebucht: ${booking.label}\nBuchungs-ID: ${booking.id}`,
  };
}

export async function syncBookings(
  credentials: Credentials,
  config: TermineConfig,
  baseFetch: typeof fetch = fetch,
): Promise<{ imported: Array<{ bookingId: string; label: string; email: string }>; failed: Array<{ bookingId: string; reason: string }>; remaining: number }> {
  const { bookings } = await termineApi<{ bookings: WebsiteBooking[] }>(config, "GET", "/admin/bookings?status=new", undefined, baseFetch);
  const imported: Array<{ bookingId: string; label: string; email: string }> = [];
  const failed: Array<{ bookingId: string; reason: string }> = [];
  if (bookings.length === 0) return { imported, failed, remaining: 0 };
  const batch = bookings.slice(0, MAX_PER_RUN);
  const opened = await openCalendarByName(credentials, config.calendarName);
  for (const booking of batch) {
    try {
      // Feste UID = Buchungs-ID: ein wiederholter Lauf legt keinen zweiten Eintrag an.
      await addEventWithUid(credentials, opened, bookingToDraft(booking), booking.id);
      await termineApi(config, "POST", `/admin/bookings/${encodeURIComponent(booking.id)}/ack`, undefined, baseFetch);
      imported.push({ bookingId: booking.id, label: booking.label, email: booking.email });
    } catch (error) {
      failed.push({ bookingId: booking.id, reason: error instanceof Error ? error.message : "Unbekannter Fehler" });
    }
  }
  return { imported, failed, remaining: bookings.length - batch.length };
}
