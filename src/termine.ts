// Bridges the website appointment service (Cloudflare Worker) with the Apple calendar "Termine extern".

import { createEvent, listCalendars, type Credentials } from "./calendar";

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

const DURATION_MS = 90 * 60_000;

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
    title: `Objektbegehung – ${booking.email}`,
    start: booking.startISO,
    end: new Date(booking.start + DURATION_MS).toISOString(),
    timeZone: "Europe/Berlin",
    description: `Objektbegehung (Website-Buchung)\nE-Mail: ${booking.email}\nBuchungs-ID: ${booking.id}`,
  };
}

export async function syncBookings(
  credentials: Credentials,
  config: TermineConfig,
  baseFetch: typeof fetch = fetch,
): Promise<{ imported: Array<{ bookingId: string; label: string; email: string }>; failed: Array<{ bookingId: string; reason: string }> }> {
  const { bookings } = await termineApi<{ bookings: WebsiteBooking[] }>(config, "GET", "/admin/bookings?status=new", undefined, baseFetch);
  const imported: Array<{ bookingId: string; label: string; email: string }> = [];
  const failed: Array<{ bookingId: string; reason: string }> = [];
  if (bookings.length === 0) return { imported, failed };
  const calendars = await listCalendars(credentials);
  const target = calendars.find((calendar) => calendar.name.trim().toLowerCase() === config.calendarName.toLowerCase());
  if (!target) throw new Error(`Kalender "${config.calendarName}" wurde nicht gefunden.`);
  for (const booking of bookings) {
    try {
      await createEvent(credentials, target.id, bookingToDraft(booking));
      await termineApi(config, "POST", `/admin/bookings/${encodeURIComponent(booking.id)}/ack`, undefined, baseFetch);
      imported.push({ bookingId: booking.id, label: booking.label, email: booking.email });
    } catch (error) {
      failed.push({ bookingId: booking.id, reason: error instanceof Error ? error.message : "Unbekannter Fehler" });
    }
  }
  return { imported, failed };
}
