// Verifies the booking-to-calendar mapping and the admin API client of the website appointment bridge.

import { describe, expect, it } from "vitest";
import { bookingToDraft, termineApi, termineConfig } from "../src/termine";

describe("website appointment bridge", () => {
  it("requires both settings and https", () => {
    expect(termineConfig({})).toBeUndefined();
    expect(termineConfig({ TERMINE_URL: "https://a.example.dev/x", TERMINE_ADMIN_TOKEN: "t" })).toEqual({ baseUrl: "https://a.example.dev", adminToken: "t", calendarName: "Termine extern" });
    expect(() => termineConfig({ TERMINE_URL: "http://a.example.dev", TERMINE_ADMIN_TOKEN: "t" })).toThrow();
  });

  it("maps a booking to a 90 minute Berlin event", () => {
    const start = Date.parse("2026-11-02T16:30:00+01:00");
    const draft = bookingToDraft({ id: "b1", label: "Mo, 02.11. 16:30 Uhr", start, startISO: "2026-11-02T16:30:00+01:00", email: "a@b.de", status: "new" });
    expect(draft).toMatchObject({ title: "Objektbegehung – a@b.de", start: "2026-11-02T16:30:00+01:00", end: "2026-11-02T17:00:00.000Z", timeZone: "Europe/Berlin" });
    expect(draft.description).toContain("b1");
  });

  it("sends the bearer token and reports failures without leaking it", async () => {
    let seen: Request | undefined;
    const ok = (async (input: RequestInfo | URL, init?: RequestInit) => { seen = new Request(input, init); return Response.json({ slots: [] }); }) as typeof fetch;
    const config = { baseUrl: "https://a.example.dev", adminToken: "secret", calendarName: "Termine extern" };
    expect(await termineApi(config, "GET", "/admin/slots", undefined, ok)).toEqual({ slots: [] });
    expect(seen?.headers.get("authorization")).toBe("Bearer secret");
    const bad = (async () => new Response("no", { status: 401 })) as typeof fetch;
    await expect(termineApi(config, "GET", "/admin/slots", undefined, bad)).rejects.toThrow("Status 401");
  });
});
