// Verifies the approval guard, password comparison, and user-facing OAuth consent content.

import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { approvalPage, authorizationGuard, clientHandoffPage, defaultHandler, secretsEqual, supportedAuthorizationScopes } from "../src/authorize";

describe("authorization guard", () => {
  it("fails closed without a configured guard", () => {
    expect(authorizationGuard({})).toBe("disabled");
  });

  it("recognizes built-in, external, and layered protection", () => {
    expect(authorizationGuard({ APPROVAL_PASSWORD: "secret" })).toBe("password");
    expect(authorizationGuard({ EXTERNAL_AUTHORIZATION: "true" })).toBe("external");
    expect(authorizationGuard({ EXTERNAL_AUTHORIZATION: "true", APPROVAL_PASSWORD: "secret" })).toBe("external-and-password");
  });
});

describe("approval password", () => {
  it("matches only the exact password", async () => {
    await expect(secretsEqual("correct horse", "correct horse")).resolves.toBe(true);
    await expect(secretsEqual("correct", "correct horse")).resolves.toBe(false);
  });
});

describe("approval page", () => {
  it("explains the permission and the client-owned completion step", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Codex <Desktop>", passwordRequired: true });
    const html = await response.text();

    expect(html).toContain("Codex &lt;Desktop&gt;");
    expect(html).toContain("cannot create, edit, or delete");
    expect(html).toContain("Share Apple Calendar with Codex &lt;Desktop&gt;?");
    expect(html).toContain("Returning…");
    expect(html).toContain("font:400 .9375rem/1.5");
    expect(html).not.toContain("Connection request");
    expect(html).not.toContain("Requesting client");
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain('name="password" type="password"');
    expect(html).toContain(":active{transform:scale(.975)}");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).not.toContain("127.0.0.1");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("omits the password field behind an external guard", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Claude", passwordRequired: false });
    expect(await response.text()).not.toContain('name="password"');
  });

  it("states the external effects of write access", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Claude", passwordRequired: false, writeRequested: true });
    const html = await response.text();
    expect(html).toContain("Read and edit calendars and events");
    expect(html).toContain("Invitations and responses may notify other people.");
  });
});

describe("client handoff", () => {
  it("ends the form navigation on this server before returning to the client", async () => {
    const destination = new URL("https://www.cursor.com/agents/mcp/oauth/callback");
    destination.searchParams.set("code", "one-time");
    destination.searchParams.set("state", `a<b>&"'`);
    const response = clientHandoffPage(destination, "Grok <Bot>");
    const html = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'nonce-");
    expect(policy).not.toContain("cursor.com");
    expect(html).toContain("Grok &lt;Bot&gt;");
    expect(html).toContain("https://www.cursor.com/agents/mcp/oauth/callback?code=one-time&amp;state=");
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("location.replace(");
    expect(html).toContain("\\u0026");
    expect(html).not.toContain("code=one-time&state");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("<b>");
  });

  it("allows a custom application scheme and refuses executable schemes", async () => {
    const custom = clientHandoffPage(new URL("cursor://anysphere.cursor-mcp/oauth/callback?code=1&state=2"));
    expect(custom.status).toBe(200);
    expect(await custom.text()).toContain("cursor://anysphere.cursor-mcp/oauth/callback?code=1&amp;state=2");

    const executable = clientHandoffPage(new URL("javascript:alert(1)"));
    expect(executable.status).toBe(400);
    expect(await executable.text()).not.toContain("javascript:");

    const credentialed = clientHandoffPage(new URL("https://user:secret@www.cursor.com/callback"));
    expect(credentialed.status).toBe(400);
    expect(await credentialed.text()).not.toContain("secret");
  });
});

describe("approval completion", () => {
  const redirectUri = "https://www.cursor.com/agents/mcp/oauth/callback";
  const redirectTo = `${redirectUri}?code=one-time-code&state=state-1`;

  function requestFor(method: "GET" | "POST", fields?: Record<string, string>): Request {
    if (method === "GET") return new Request("https://calendar.example/authorize?request=1");
    return new Request("https://calendar.example/authorize?request=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  async function authorize(request: Request, options: { password: string; failure?: AuthorizationError }) {
    const oauthRequest: AuthRequest = {
      responseType: "code",
      clientId: "client",
      redirectUri,
      scope: ["calendar:read"],
      state: "state-1",
    };
    const completeAuthorization = vi.fn(async () => ({ redirectTo }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchHandler = defaultHandler.fetch;
    if (!fetchHandler) throw new Error("missing fetch");
    try {
      const response = await fetchHandler(
        request as Parameters<typeof fetchHandler>[0],
        {
          APPROVAL_PASSWORD: options.password,
          OAUTH_PROVIDER: {
            parseAuthRequest: async () => {
              if (options.failure) throw options.failure;
              return oauthRequest;
            },
            lookupClient: async () => ({ clientId: "client", clientName: "Grok Bot", redirectUris: [redirectUri], tokenEndpointAuthMethod: "none" }),
            completeAuthorization,
          },
        } as unknown as Parameters<typeof fetchHandler>[1],
        {} as Parameters<typeof fetchHandler>[2],
      );
      return { response, completeAuthorization, logged: JSON.stringify(info.mock.calls) };
    } finally {
      info.mockRestore();
    }
  }

  it("keeps the approval form on this server", async () => {
    const { response, completeAuthorization } = await authorize(requestFor("GET"), { password: "correct horse" });
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("cursor.com");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('name="password"');
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("returns the authorization code without a form redirect after the correct password", async () => {
    const { response, completeAuthorization, logged } = await authorize(requestFor("POST", { decision: "allow", password: "correct horse" }), { password: "correct horse" });
    const html = await response.text();
    expect(completeAuthorization).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(html).toContain("Returning to Grok Bot");
    expect(html).toContain("https://www.cursor.com/agents/mcp/oauth/callback?code=one-time-code&amp;state=state-1");
    expect(html).not.toContain("correct horse");
    expect(logged).not.toContain("one-time-code");
  });

  it("does not authorize an incorrect password", async () => {
    const { response, completeAuthorization } = await authorize(requestFor("POST", { decision: "allow", password: "wrong" }), { password: "correct horse" });
    const html = await response.text();
    expect(response.status).toBe(401);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(html).toContain("That approval password is incorrect.");
    expect(html).not.toContain("one-time-code");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
  });

  it("returns a denial to the client without issuing a code", async () => {
    const { response, completeAuthorization } = await authorize(requestFor("POST", { decision: "deny" }), { password: "correct horse" });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(html).toContain("error=access_denied");
    expect(html).toContain("state=state-1");
    expect(html).not.toContain("one-time-code");
  });

  it("uses the handoff only when the failed request was a form post", async () => {
    const failure = new AuthorizationError("invalid_request", { description: "Missing response type.", redirectUri, state: "state-1" });
    const posted = await authorize(requestFor("POST", { decision: "allow", password: "correct horse" }), { password: "correct horse", failure });
    expect(posted.response.status).toBe(200);
    expect(posted.response.headers.get("location")).toBeNull();
    expect(await posted.response.text()).toContain("error=invalid_request");

    const fetched = await authorize(requestFor("GET"), { password: "correct horse", failure });
    expect(fetched.response.status).toBe(303);
    expect(fetched.response.headers.get("location")).toContain(`${redirectUri}?error=invalid_request`);
    expect(fetched.response.headers.get("location")).toContain("state=state-1");
  });
});

describe("authorization scopes", () => {
  it("grants supported read and write scopes without reflecting unknown scopes", () => {
    expect(supportedAuthorizationScopes(["calendar:read", "admin", "calendar:write"])).toEqual(["calendar:read", "calendar:write"]);
  });
});
