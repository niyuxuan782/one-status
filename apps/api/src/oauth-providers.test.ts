import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeOAuthCode,
  executeProviderAction,
  type ProviderFetch,
  ProviderRequestError,
  refreshOAuthCredential,
  revokeOAuthCredential,
} from "./oauth-providers.js";

const config = { clientId: "client-id", clientSecret: "client-secret" };
const redirectUri = "https://os.example.test/oauth/callback";

describe("OAuth provider protocols", () => {
  it("builds provider-specific authorization URLs", () => {
    const google = new URL(
      buildAuthorizationUrl({
        codeChallenge: "challenge",
        config,
        provider: "google",
        redirectUri,
        state: "state",
      }),
    );
    expect(google.origin + google.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("code_challenge")).toBe("challenge");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("prompt")).toBe("consent");

    const github = new URL(
      buildAuthorizationUrl({
        codeChallenge: "unused-challenge",
        config,
        provider: "github",
        redirectUri,
        state: "state",
      }),
    );
    expect(github.origin + github.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(github.searchParams.has("code_challenge")).toBe(false);
    expect(github.searchParams.has("code_challenge_method")).toBe(false);
    expect(github.searchParams.get("scope")?.split(" ")).toContain("repo");

    const slack = new URL(
      buildAuthorizationUrl({
        codeChallenge: "unused-challenge",
        config,
        provider: "slack",
        redirectUri,
        state: "state",
      }),
    );
    expect(slack.origin + slack.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(slack.searchParams.get("scope")).toBe("");
    expect(slack.searchParams.get("user_scope")).toBe(
      "channels:read,groups:read",
    );
    expect(slack.searchParams.get("code_challenge")).toBe(
      "unused-challenge",
    );
    expect(slack.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a Google code with PKCE and reads the OpenID profile", async () => {
    let call = 0;
    const fetch_: ProviderFetch = async (input, init) => {
      call += 1;
      if (call === 1) {
        expect(requestUrl(input)).toBe("https://oauth2.googleapis.com/token");
        expect(init?.method).toBe("POST");
        expect(formBody(init).get("code_verifier")).toBe("verifier");
        return json({
          access_token: "google-access",
          expires_in: 3600,
          refresh_token: "google-refresh",
          scope:
            "openid email profile https://www.googleapis.com/auth/calendar.readonly",
          token_type: "Bearer",
        });
      }
      expect(requestUrl(input)).toBe(
        "https://openidconnect.googleapis.com/v1/userinfo",
      );
      expect(requestHeaders(init).get("authorization")).toBe(
        "Bearer google-access",
      );
      return json({ sub: "google-user", email: "ryan@example.test" });
    };

    const result = await exchangeOAuthCode({
      code: "authorization-code",
      codeVerifier: "verifier",
      config,
      fetch: fetch_,
      provider: "google",
      redirectUri,
    });

    expect(result).toMatchObject({
      accountId: "google-user",
      credential: {
        accessToken: "google-access",
        refreshToken: "google-refresh",
      },
      label: "ryan@example.test",
    });
    expect(result.expiresAt).not.toBeNull();
  });

  it("uses GitHub's documented web flow without PKCE parameters", async () => {
    let call = 0;
    const fetch_: ProviderFetch = async (input, init) => {
      call += 1;
      if (call === 1) {
        expect(requestUrl(input)).toBe(
          "https://github.com/login/oauth/access_token",
        );
        const body = formBody(init);
        expect(body.get("code")).toBe("authorization-code");
        expect(body.has("code_verifier")).toBe(false);
        return json({
          access_token: "github-access",
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      }
      expect(requestUrl(input)).toBe("https://api.github.com/user");
      expect(requestHeaders(init).get("x-github-api-version")).toBe(
        "2022-11-28",
      );
      return json({
        avatar_url: "https://avatars.example.test/1",
        html_url: "https://github.com/ryan",
        id: 42,
        login: "ryan",
        name: "Ryan",
      });
    };

    const result = await exchangeOAuthCode({
      code: "authorization-code",
      codeVerifier: "unused-verifier",
      config,
      fetch: fetch_,
      provider: "github",
      redirectUri,
    });

    expect(result).toMatchObject({
      accountId: "42",
      credential: { accessToken: "github-access" },
      expiresAt: null,
      label: "ryan",
      scopes: ["read:user", "user:email"],
    });
  });

  it("exchanges Slack public-client PKCE codes for rotating user tokens", async () => {
    const fetch_: ProviderFetch = async (_input, init) => {
      expect(formBody(init).get("client_secret")).toBeNull();
      expect(formBody(init).get("code_verifier")).toBe("public-verifier");
      return json({
        authed_user: {
          access_token: "slack-user-access",
          expires_in: 43_200,
          id: "U123",
          refresh_token: "slack-user-refresh",
          scope: "channels:read,groups:read",
          token_type: "user",
        },
        enterprise: { id: "E123", name: "Acme Enterprise" },
        ok: true,
        team: null,
      });
    };

    const result = await exchangeOAuthCode({
      code: "authorization-code",
      codeVerifier: "public-verifier",
      config: { clientId: "client-id" },
      fetch: fetch_,
      provider: "slack",
      redirectUri,
    });

    expect(result).toMatchObject({
      accountId: "E123:U123",
      credential: {
        accessToken: "slack-user-access",
        refreshToken: "slack-user-refresh",
        tokenType: "user",
      },
      label: "Acme Enterprise",
      scopes: ["channels:read", "groups:read"],
    });
  });

  it("preserves Google's refresh token and rotates Slack's refresh token", async () => {
    const google = await refreshOAuthCredential({
      config,
      credential: {
        accessToken: "old-google-access",
        refreshToken: "old-google-refresh",
        tokenType: "Bearer",
      },
      fetch: async (_input, init) => {
        expect(formBody(init).get("refresh_token")).toBe(
          "old-google-refresh",
        );
        return json({ access_token: "new-google-access", expires_in: 3600 });
      },
      provider: "google",
    });
    expect(google.credential).toEqual({
      accessToken: "new-google-access",
      refreshToken: "old-google-refresh",
      tokenType: "Bearer",
    });

    const slack = await refreshOAuthCredential({
      config: { clientId: "client-id" },
      credential: {
        accessToken: "old-slack-access",
        refreshToken: "single-use-refresh",
      },
      fetch: async (input, init) => {
        expect(requestUrl(input)).toBe("https://slack.com/api/oauth.v2.access");
        expect(formBody(init).get("grant_type")).toBe("refresh_token");
        expect(formBody(init).get("client_secret")).toBeNull();
        expect(formBody(init).get("code_verifier")).toBeNull();
        return json({
          authed_user: {
            access_token: "new-slack-access",
            expires_in: 43_200,
            refresh_token: "rotated-refresh",
            scope: "channels:read,groups:read",
            token_type: "user",
          },
          ok: true,
        });
      },
      provider: "slack",
    });
    expect(slack.credential).toEqual({
      accessToken: "new-slack-access",
      refreshToken: "rotated-refresh",
      tokenType: "user",
    });
    expect(slack.scopes).toEqual(["channels:read", "groups:read"]);
  });

  it("refreshes expiring GitHub credentials when the provider issued them", async () => {
    const refreshed = await refreshOAuthCredential({
      config,
      credential: {
        accessToken: "old-github-access",
        refreshToken: "old-github-refresh",
      },
      fetch: async (input, init) => {
        expect(requestUrl(input)).toBe(
          "https://github.com/login/oauth/access_token",
        );
        expect(formBody(init).get("grant_type")).toBe("refresh_token");
        return json({
          access_token: "new-github-access",
          expires_in: 28_800,
          refresh_token: "new-github-refresh",
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      },
      provider: "github",
    });

    expect(refreshed.credential).toEqual({
      accessToken: "new-github-access",
      refreshToken: "new-github-refresh",
      tokenType: "bearer",
    });
    expect(refreshed.scopes).toEqual(["read:user", "user:email"]);
  });

  it("rejects failed rotation and omits provider-controlled details from messages", async () => {
    const error = await refreshOAuthCredential({
      config,
      credential: {
        accessToken: "old-access",
        refreshToken: "secret-refresh-token",
      },
      fetch: async () =>
        json({ ok: false, error: "invalid_refresh_token secret-refresh-token" }),
      provider: "slack",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).message).not.toContain(
      "secret-refresh-token",
    );
    expect((error as ProviderRequestError).code.length).toBeLessThanOrEqual(80);
  });

  it("revokes Google, GitHub, and Slack credentials with their native APIs", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const fetch_: ProviderFetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push({ init, url });
      return url.includes("slack.com") ? json({ ok: true }) : new Response(null);
    };

    await revokeOAuthCredential({
      config,
      credential: { accessToken: "google-access", refreshToken: "google-refresh" },
      fetch: fetch_,
      provider: "google",
    });
    await revokeOAuthCredential({
      config,
      credential: { accessToken: "github-access" },
      fetch: fetch_,
      provider: "github",
    });
    await revokeOAuthCredential({
      config,
      credential: { accessToken: "slack-access" },
      fetch: fetch_,
      provider: "slack",
    });

    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(formBody(requests[0]?.init).get("token")).toBe("google-refresh");
    expect(requests[1]?.url).toBe(
      "https://api.github.com/applications/client-id/token",
    );
    expect(requests[1]?.init?.method).toBe("DELETE");
    expect(requestHeaders(requests[1]?.init).get("authorization")).toMatch(
      /^Basic /,
    );
    expect(requests[2]?.url).toBe("https://slack.com/api/auth.revoke");
    expect(requestHeaders(requests[2]?.init).get("authorization")).toBe(
      "Bearer slack-access",
    );
  });

  it("normalizes provider actions and preserves request IDs", async () => {
    const calendar = await executeProviderAction({
      action: "calendar.events.list",
      arguments: {
        calendarId: "team/calendar",
        maxResults: 5,
        pageToken: "page-2",
        timeMax: "2026-08-11T00:00:00.000Z",
        timeMin: "2026-08-10T00:00:00.000Z",
      },
      credential: { accessToken: "google-access" },
      fetch: async (input, init) => {
        const url = new URL(requestUrl(input));
        expect(url.pathname).toContain("team%2Fcalendar/events");
        expect(url.searchParams.get("pageToken")).toBe("page-2");
        expect(url.searchParams.get("singleEvents")).toBe("true");
        expect(requestHeaders(init).get("authorization")).toBe(
          "Bearer google-access",
        );
        return json(
          {
            items: [
              {
                end: { dateTime: "2026-08-10T10:00:00Z" },
                id: "event-1",
                start: { dateTime: "2026-08-10T09:00:00Z" },
                summary: "Planning",
              },
            ],
            summary: "Primary",
            timeZone: "Asia/Shanghai",
          },
          200,
          { "x-request-id": "google-request-1" },
        );
      },
      provider: "google",
    });
    expect(calendar).toMatchObject({
      data: { items: [{ id: "event-1", summary: "Planning" }] },
      providerRequestId: "google-request-1",
    });

    const slack = await executeProviderAction({
      action: "slack.channels.list",
      arguments: { limit: 10 },
      credential: { accessToken: "slack-access" },
      fetch: async () =>
        json({
          channels: [
            { id: "C1", is_member: true, name: "general", topic: { value: "News" } },
          ],
          ok: true,
          response_metadata: { next_cursor: "next" },
        }),
      provider: "slack",
    });
    expect(slack.data).toEqual({
      items: [{ id: "C1", isMember: true, name: "general", topic: "News" }],
      nextCursor: "next",
    });
  });

  it("rejects oversized provider responses before parsing JSON", async () => {
    await expect(
      executeProviderAction({
        action: "slack.channels.list",
        arguments: {},
        credential: { accessToken: "slack-access" },
        fetch: async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-length": String(1024 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        provider: "slack",
      }),
    ).rejects.toMatchObject({
      code: "provider_response_too_large",
      name: "ProviderRequestError",
    });
  });
});

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function requestHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function formBody(init?: RequestInit): URLSearchParams {
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  return init?.body as URLSearchParams;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
