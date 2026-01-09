import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  getSessionById,
  isTokenExpired,
  refreshAccessToken,
  updateSessionTokens,
  UserSession,
} from "../services/auth.ts";

/**
 * Middleware to require authentication for protected routes
 * Redirects to login if not authenticated
 */
export async function requireAuth(c: Context, next: Next) {
  const sessionId = getCookie(c, "session_id");

  if (!sessionId) {
    console.log("🔒 No session - redirecting to login");
    return c.redirect("/auth/google");
  }

  const session = getSessionById(sessionId);

  if (!session) {
    console.log("🔒 Invalid session - redirecting to login");
    return c.redirect("/auth/google");
  }

  // Check if token is expired and refresh if needed
  if (isTokenExpired(session)) {
    if (session.refresh_token) {
      try {
        console.log("🔄 Refreshing expired access token");
        const refreshed = await refreshAccessToken(session.refresh_token);

        // Update session with new tokens
        updateSessionTokens(
          session.id,
          refreshed.accessToken,
          refreshed.refreshToken || null,
          refreshed.expiresIn
        );

        // Update session object with new token
        session.access_token = refreshed.accessToken;
        if (refreshed.refreshToken) {
          session.refresh_token = refreshed.refreshToken;
        }

        console.log("✅ Token refreshed successfully");
      } catch (error) {
        console.error("❌ Token refresh failed:", error);
        return c.redirect("/auth/google");
      }
    } else {
      console.log("🔒 Token expired and no refresh token - redirecting to login");
      return c.redirect("/auth/google");
    }
  }

  // Attach session to context for use in route handlers
  c.set("session", session);
  c.set("accessToken", session.access_token);
  c.set("userId", session.user_id);

  await next();
}

/**
 * Middleware to optionally check authentication without requiring it
 * Does not redirect, just attaches session if available
 */
export async function optionalAuth(c: Context, next: Next) {
  const sessionId = getCookie(c, "session_id");

  if (sessionId) {
    const session = getSessionById(sessionId);

    if (session && !isTokenExpired(session)) {
      c.set("session", session);
      c.set("accessToken", session.access_token);
      c.set("userId", session.user_id);
    }
  }

  await next();
}

/**
 * Helper to get current session from context
 */
export function getSession(c: Context): UserSession | null {
  return c.get("session") || null;
}

/**
 * Helper to get access token from context
 */
export function getAccessToken(c: Context): string | null {
  return c.get("accessToken") || null;
}

/**
 * Helper to get user ID from context
 */
export function getUserId(c: Context): string | null {
  return c.get("userId") || null;
}
