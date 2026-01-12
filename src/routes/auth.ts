import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { google, storeSession, deleteSession, parseIdToken, UserSession } from "../services/auth.ts";

const auth = new Hono<{ Variables: { session: UserSession | null } }>();

/**
 * GET /auth/google
 * Initiates Google OAuth flow
 */
auth.get("/google", async (c) => {
  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID();

  // Required scopes for Google Photos Picker API
  const scopes = ["openid", "profile", "email", "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"];

  const url = await google.createAuthorizationURL(state, codeVerifier, {
    scopes: scopes,
  });

  // Store state and code verifier in httpOnly cookies for security
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: Deno.env.get("DENO_ENV") === "production",
    maxAge: 600, // 10 minutes
    sameSite: "Lax",
    path: "/",
  });

  setCookie(c, "code_verifier", codeVerifier, {
    httpOnly: true,
    secure: Deno.env.get("DENO_ENV") === "production",
    maxAge: 600, // 10 minutes
    sameSite: "Lax",
    path: "/",
  });

  return c.redirect(url.toString());
});

/**
 * GET /auth/google/callback
 * Handles OAuth callback from Google
 */
auth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error:", error);
    return c.html(`<html><body><h1>Authentication Error</h1><p>${error}</p><a href="/">Go Home</a></body></html>`, 400);
  }

  const storedState = getCookie(c, "oauth_state");
  const codeVerifier = getCookie(c, "code_verifier");

  // Validate state to prevent CSRF attacks
  if (!code || !state || state !== storedState || !codeVerifier) {
    return c.html(`<html><body><h1>Invalid Request</h1><p>OAuth state mismatch or missing code</p><a href="/">Go Home</a></body></html>`, 400);
  }

  try {
    // Exchange authorization code for tokens
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);

    // Parse ID token to get user information
    const userInfo = parseIdToken(tokens.idToken);

    // Calculate expires_in from accessTokenExpiresAt
    const expiresIn = Math.floor((tokens.accessTokenExpiresAt.getTime() - Date.now()) / 1000);

    // Store session in database
    const sessionId = storeSession(
      userInfo.sub, // Google user ID
      userInfo.email || null,
      userInfo.name || null,
      userInfo.picture || null,
      tokens.accessToken,
      tokens.refreshToken || null,
      expiresIn
    );

    // Create session cookie
    setCookie(c, "session_id", sessionId, {
      httpOnly: true,
      secure: Deno.env.get("DENO_ENV") === "production",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      sameSite: "Lax",
      path: "/",
    });

    // Clear temporary OAuth cookies
    setCookie(c, "oauth_state", "", { maxAge: 0, path: "/" });
    setCookie(c, "code_verifier", "", { maxAge: 0, path: "/" });

    console.log(`✅ User authenticated: ${userInfo.email || userInfo.sub}`);

    // Redirect to photos picker page
    return c.redirect("/ui/photos-picker");
  } catch (error) {
    console.error("OAuth token exchange error:", error);
    return c.html(`<html><body><h1>Authentication Failed</h1><p>${error instanceof Error ? error.message : "Unknown error"}</p><a href="/">Go Home</a></body></html>`, 500);
  }
});

/**
 * GET /auth/logout
 * Logs out the user and clears session
 */
auth.get("/logout", (c) => {
  const sessionId = getCookie(c, "session_id");

  if (sessionId) {
    deleteSession(sessionId);
  }

  // Clear session cookie
  setCookie(c, "session_id", "", { maxAge: 0, path: "/" });

  return c.redirect("/");
});

/**
 * GET /auth/status
 * Check authentication status (for client-side checks)
 */
auth.get("/status", (c) => {
  const sessionId = getCookie(c, "session_id");

  if (!sessionId) {
    return c.json({ authenticated: false });
  }

  // Session validation happens in middleware
  const session = c.get("session");

  if (!session) {
    return c.json({ authenticated: false });
  }

  return c.json({
    authenticated: true,
    user: {
      email: session.email,
      name: session.name,
      picture: session.picture,
    },
  });
});

export default auth;
