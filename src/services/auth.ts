import { Google } from "arctic";
import { getAuthSession, upsertAuthSession, getAuthSessionByUserId, deleteAuthSession } from "../db/helpers-firestore.ts";
import { encodeHex } from "@std/encoding/hex";

// Initialize Google OAuth provider with Arctic
export const google = new Google(
  Deno.env.get("CLIENT_ID")!,
  Deno.env.get("CLIENT_SECRET")!,
  Deno.env.get("REDIRECT_URI") || "http://localhost:8080/auth/google/callback"
);

export type UserSession = {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expiry: string;
  created_at: string;
}

/**
 * Store or update OAuth session for a user
 */
export async function storeSession(
  userId: string,
  email: string | null,
  name: string | null,
  picture: string | null,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number
): Promise<string> {
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  
  // Encrypt tokens before storing (simple encryption with crypto)
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;
  
  const sessionId = crypto.randomUUID();
  
  // Upsert session
  await upsertAuthSession({
    id: sessionId,
    user_id: userId,
    email: email ?? undefined,
    name: name ?? undefined,
    picture: picture ?? undefined,
    access_token: encryptedAccessToken,
    refresh_token: encryptedRefreshToken ?? undefined,
    token_expiry: tokenExpiry,
  });
  
  return sessionId;
}

/**
 * Get session by session ID
 */
export async function getSessionById(sessionId: string): Promise<UserSession | null> {
  const session = await getAuthSession(sessionId);
  
  if (!session) return null;
  
  // Decrypt tokens
  const decryptedSession = {
    ...session,
    access_token: decryptToken(session.access_token),
    refresh_token: session.refresh_token ? decryptToken(session.refresh_token) : null,
  };
  
  return decryptedSession as UserSession;
}

/**
 * Get session by user ID
 */
export async function getSessionByUserId(userId: string): Promise<UserSession | null> {
  const session = await getAuthSessionByUserId(userId);
  
  if (!session) return null;
  
  // Decrypt tokens
  const decryptedSession = {
    ...session,
    access_token: decryptToken(session.access_token),
    refresh_token: session.refresh_token ? decryptToken(session.refresh_token) : null,
  };
  
  return decryptedSession as UserSession;
}

/**
 * Delete session by ID
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await deleteAuthSession(sessionId);
}

/**
 * Check if access token is expired
 */
export function isTokenExpired(session: UserSession): boolean {
  const expiry = new Date(session.token_expiry);
  // Add 5 minute buffer
  return expiry.getTime() - Date.now() < 5 * 60 * 1000;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("CLIENT_ID")!,
      client_secret: Deno.env.get("CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token, // Google may issue a new refresh token
  };
}

/**
 * Update session with refreshed tokens
 */
export async function updateSessionTokens(
  sessionId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number
): Promise<void> {
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : undefined;
  
  // Get existing session and update it
  const session = await getAuthSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  
  await upsertAuthSession({
    ...session,
    access_token: encryptedAccessToken,
    refresh_token: encryptedRefreshToken || session.refresh_token,
    token_expiry: tokenExpiry,
  });
}

/**
 * Simple encryption for tokens using crypto
 * In production, consider using a proper encryption library with key management
 */
function encryptToken(token: string): string {
  const key = Deno.env.get("ENCRYPTION_KEY") || "default-key-change-in-production";
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const keyData = encoder.encode(key);
  
  // Simple XOR encryption (for demo - use proper encryption in production)
  const encrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    encrypted[i] = data[i] ^ keyData[i % keyData.length];
  }
  
  return encodeHex(encrypted);
}

/**
 * Simple decryption for tokens
 */
function decryptToken(encryptedHex: string): string {
  const key = Deno.env.get("ENCRYPTION_KEY") || "default-key-change-in-production";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(key);
  
  // Decode hex
  const encrypted = new Uint8Array(encryptedHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  
  // Simple XOR decryption
  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyData[i % keyData.length];
  }
  
  return decoder.decode(decrypted);
}

/**
 * Parse JWT token to extract user info (basic implementation)
 */
export function parseIdToken(idToken: string): {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
} {
  // Simple JWT parsing (Arctic may provide this, but implementing manually)
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid ID token format");
  }
  
  const payload = parts[1];
  const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decoded);
}
