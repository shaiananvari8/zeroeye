// @ts-nocheck - TODO: Fix types for v2. See V2-619.
/**
 * Authentication service for Tent of Trials.
 * Handles login, logout, token management, MFA, and session tracking.
 *
 * The auth flow supports multiple providers:
 * - Email/password with optional MFA (TOTP, SMS, backup codes)
 * - OAuth2 (Google, GitHub, Microsoft)
 * - SSO (SAML, OpenID Connect)
 * - API key authentication for machine-to-machine
 *
 * Single-flight token refresh coordination is implemented:
 * - Concurrent in-tab calls coalesce onto a single in-flight Promise.
 * - Cross-tab calls synchronize via BroadcastChannel and localStorage events.
 * - In-flight markers are deterministically cleared on both success and failure.
 */

import { get, post, del } from './api';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: UserRole;
  permissions: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  language: string;
  timezone: string;
  notifications: NotificationPreferences;
  dashboardLayout?: string;
  marketPreferences?: MarketPreferences;
}

export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  inApp: boolean;
  tradeConfirmations: boolean;
  priceAlerts: boolean;
  accountUpdates: boolean;
  marketing: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

export interface MarketPreferences {
  defaultView: 'chart' | 'orderbook' | 'trades';
  defaultInterval: string;
  favoriteInstruments: string[];
  chartPreferences: ChartPreferences;
}

export interface ChartPreferences {
  theme: 'light' | 'dark';
  indicators: string[];
  timeframe: string;
  chartType: 'candlestick' | 'line' | 'area' | 'bar';
  showVolume: boolean;
  showGrid: boolean;
  studies: string[];
}

export type UserRole = 'admin' | 'trader' | 'analyst' | 'viewer' | 'api_only';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  mfaCode?: string;
  rememberMe?: boolean;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  acceptTerms: boolean;
  acceptPrivacy: boolean;
  referralCode?: string;
}

export interface MFASetupResponse {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface Session {
  id: string;
  deviceName: string;
  deviceType: string;
  ipAddress: string;
  location?: string;
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'tot_auth_tokens';
const USER_KEY = 'tot_user_data';
const REFRESH_THRESHOLD = 60; // seconds before expiry to attempt refresh

let currentTokens: AuthTokens | null = null;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let authListeners: Array<(user: User | null) => void> = [];

// ---------------------------------------------------------------------------
// SINGLE-FLIGHT & CROSS-TAB COORDINATION
// ---------------------------------------------------------------------------

const REFRESH_IN_FLIGHT_KEY = 'tot_auth_refresh_in_flight';
const REFRESH_BROADCAST_CHANNEL = 'tot_auth_refresh';
const REFRESH_IN_FLIGHT_TTL_MS = 30_000;

type RefreshBroadcastMessage = {
  type: 'refresh-complete' | 'refresh-failed';
  refreshId: string;
};

let refreshInFlight: Promise<AuthTokens | null> | null = null;
let refreshChannel: BroadcastChannel | null = null;

function getRefreshChannel(): BroadcastChannel | null {
  if (refreshChannel) return refreshChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    refreshChannel = new BroadcastChannel(REFRESH_BROADCAST_CHANNEL);
    return refreshChannel;
  } catch {
    return null;
  }
}

function createRefreshId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readRefreshMarker(): { refreshId: string; expiresAt: number } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(REFRESH_IN_FLIGHT_KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw) as { refreshId: string; expiresAt: number };
    if (!marker.refreshId || Date.now() >= marker.expiresAt) {
      localStorage.removeItem(REFRESH_IN_FLIGHT_KEY);
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

function writeRefreshMarker(refreshId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(REFRESH_IN_FLIGHT_KEY, JSON.stringify({
      refreshId,
      expiresAt: Date.now() + REFRESH_IN_FLIGHT_TTL_MS,
    }));
  } catch {
    // localStorage coordination is best effort; same-tab single-flight still applies
  }
}

function clearRefreshMarker(refreshId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const marker = readRefreshMarker();
    if (!marker || marker.refreshId === refreshId) {
      localStorage.removeItem(REFRESH_IN_FLIGHT_KEY);
    }
  } catch {
    // ignore cleanup errors
  }
}

function broadcastRefresh(message: RefreshBroadcastMessage): void {
  try {
    getRefreshChannel()?.postMessage(message);
  } catch {
    // BroadcastChannel may be unavailable or closed. The storage event fallback below still fires.
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${REFRESH_BROADCAST_CHANNEL}:last`, JSON.stringify({
        ...message,
        notifiedAt: Date.now(),
      }));
    }
  } catch {
    // ignore fallback notification errors
  }
}

function waitForCrossTabRefresh(refreshId: string): Promise<AuthTokens | null> {
  return new Promise(resolve => {
    let settled = false;
    let timeoutId: number | null = null;

    const settle = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null && typeof window !== 'undefined') window.clearTimeout(timeoutId);
      if (typeof window !== 'undefined') {
        getRefreshChannel()?.removeEventListener('message', onBroadcast);
        window.removeEventListener('storage', onStorage);
      }
      resolve(failed ? null : loadStoredTokens());
    };

    const onMessage = (message: RefreshBroadcastMessage): void => {
      if (message.refreshId !== refreshId) return;
      settle(message.type === 'refresh-failed');
    };

    const onBroadcast = (event: MessageEvent<RefreshBroadcastMessage>): void => {
      onMessage(event.data);
    };

    const onStorage = (event: StorageEvent): void => {
      if (event.key !== `${REFRESH_BROADCAST_CHANNEL}:last` || !event.newValue) return;
      try {
        onMessage(JSON.parse(event.newValue) as RefreshBroadcastMessage);
      } catch {
        // ignore unrelated storage values
      }
    };

    if (typeof window !== 'undefined') {
      getRefreshChannel()?.addEventListener('message', onBroadcast);
      window.addEventListener('storage', onStorage);
      timeoutId = window.setTimeout(() => settle(false), REFRESH_IN_FLIGHT_TTL_MS);
    } else {
      settle(false);
    }
  });
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

function getTokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp;
  } catch {
    return 0;
  }
}

function storeTokens(tokens: AuthTokens): void {
  currentTokens = tokens;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearStoredTokens(): void {
  currentTokens = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

function loadStoredTokens(): AuthTokens | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      const tokens = JSON.parse(stored) as AuthTokens;
      if (!isTokenExpired(tokens.accessToken)) {
        currentTokens = tokens;
        return tokens;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function notifyListeners(user: User | null): void {
  for (const listener of authListeners) {
    try {
      listener(user);
    } catch {
      // ignore listener errors
    }
  }
}

function scheduleTokenRefresh(tokens: AuthTokens): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const expiresIn = tokens.expiresIn;
  const refreshIn = Math.max((expiresIn - REFRESH_THRESHOLD) * 1000, 0);

  refreshTimer = window.setTimeout(async () => {
    try {
      const newTokens = await refreshTokens();
      if (newTokens) {
        scheduleTokenRefresh(newTokens);
      }
    } catch {
      // Refresh failed, will retry on next API call
    }
  }, refreshIn);
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export async function login(request: LoginRequest): Promise<AuthTokens> {
  const response = await post<{ tokens: AuthTokens; user: User }>('/auth/login', request);

  storeTokens(response.data.tokens);
  currentUser = response.data.user;

  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
  } catch {
    // ignore
  }

  scheduleTokenRefresh(response.data.tokens);
  notifyListeners(response.data.user);

  return response.data.tokens;
}

export async function register(request: RegisterRequest): Promise<AuthTokens> {
  const response = await post<{ tokens: AuthTokens; user: User }>('/auth/register', request);

  storeTokens(response.data.tokens);
  currentUser = response.data.user;

  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
  } catch {
    // ignore
  }

  scheduleTokenRefresh(response.data.tokens);
  notifyListeners(response.data.user);

  return response.data.tokens;
}

export async function logout(): Promise<void> {
  try {
    await del('/auth/logout');
  } catch {
    // Silently ignore logout errors - we clear local state regardless
  }

  clearStoredTokens();
  currentUser = null;

  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  notifyListeners(null);
}

/**
 * Refreshes auth tokens using a single-flight execution pattern.
 *
 * Concurrent callers in the same tab share the single in-flight Promise (`refreshInFlight`).
 * Concurrent callers across tabs observe the cross-tab in-flight marker in localStorage
 * and wait for notification via BroadcastChannel or storage event without initiating duplicate
 * refresh requests. In-flight state and markers are guaranteed to be cleaned up in a `finally`
 * block on both success and failure, allowing subsequent retries. Raw tokens are never logged
 * or transmitted over broadcast events.
 */
export async function refreshTokens(): Promise<AuthTokens | null> {
  const tokens = currentTokens || loadStoredTokens();
  if (!tokens?.refreshToken) return null;

  // Single-flight coordination: same-tab callers reuse refreshInFlight, while
  // other tabs wait for a token-free BroadcastChannel/storage completion signal.
  if (refreshInFlight) return refreshInFlight;

  const existingMarker = readRefreshMarker();
  if (existingMarker) {
    return waitForCrossTabRefresh(existingMarker.refreshId);
  }

  const refreshId = createRefreshId();
  writeRefreshMarker(refreshId);

  refreshInFlight = (async () => {
    try {
      const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
        refreshToken: tokens.refreshToken,
      });

      storeTokens(response.data.tokens);
      scheduleTokenRefresh(response.data.tokens);
      broadcastRefresh({ type: 'refresh-complete', refreshId });

      return response.data.tokens;
    } catch {
      clearStoredTokens();
      currentUser = null;
      notifyListeners(null);
      broadcastRefresh({ type: 'refresh-failed', refreshId });
      return null;
    } finally {
      clearRefreshMarker(refreshId);
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function getCurrentUser(): Promise<User | null> {
  if (currentUser) return currentUser;

  // Try to load from local storage
  try {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      currentUser = JSON.parse(stored);
      return currentUser;
    }
  } catch {
    // ignore
  }

  // Try to restore session from stored tokens
  const tokens = loadStoredTokens();
  if (tokens && !isTokenExpired(tokens.accessToken)) {
    try {
      const response = await get<User>('/auth/me');
      currentUser = response.data;
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(response.data));
      } catch {
        // ignore
      }
      return response.data;
    } catch {
      // Token might be expired or invalid
      const refreshed = await refreshTokens();
      if (refreshed) {
        const response = await get<User>('/auth/me');
        currentUser = response.data;
        return response.data;
      }
    }
  }

  return null;
}

export async function setupMFA(): Promise<MFASetupResponse> {
  const response = await post<MFASetupResponse>('/auth/mfa/setup');
  return response.data;
}

export async function verifyMFA(code: string): Promise<boolean> {
  const response = await post<{ verified: boolean }>('/auth/mfa/verify', { code });
  return response.data.verified;
}

export async function disableMFA(password: string): Promise<void> {
  await del('/auth/mfa/disable', { password });
}

export async function getBackupCodes(): Promise<string[]> {
  const response = await get<{ codes: string[] }>('/auth/mfa/backup-codes');
  return response.data.codes;
}

export async function regenerateBackupCodes(): Promise<string[]> {
  const response = await post<{ codes: string[] }>('/auth/mfa/backup-codes/regenerate');
  return response.data.codes;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await post('/auth/change-password', {
    currentPassword,
    newPassword,
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await post('/auth/reset-password', { email });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await post('/auth/reset-password/confirm', { token, newPassword });
}

export async function verifyEmail(token: string): Promise<void> {
  await post('/auth/verify-email', { token });
}

export async function resendVerificationEmail(): Promise<void> {
  await post('/auth/verify-email/resend');
}

export async function getSessions(): Promise<Session[]> {
  const response = await get<{ sessions: Session[] }>('/auth/sessions');
  return response.data.sessions;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await del(`/auth/sessions/${sessionId}`);
}

export async function revokeAllOtherSessions(): Promise<void> {
  await del('/auth/sessions/others');
}

export async function updateProfile(data: Partial<Pick<User, 'name' | 'avatarUrl'>>): Promise<User> {
  const response = await put<User>('/auth/profile', data);
  currentUser = response.data;
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data));
  } catch {
    // ignore
  }
  notifyListeners(response.data);
  return response.data;
}

export async function updatePreferences(preferences: Partial<UserPreferences>): Promise<UserPreferences> {
  const response = await put<UserPreferences>('/auth/preferences', preferences);
  if (currentUser) {
    currentUser.preferences = { ...currentUser.preferences, ...response.data };
  }
  return response.data;
}

export function getAccessToken(): string | null {
  return currentTokens?.accessToken || null;
}

export function isAuthenticated(): boolean {
  const tokens = currentTokens || loadStoredTokens();
  return tokens !== null && !isTokenExpired(tokens.accessToken);
}

export function onAuthChange(listener: (user: User | null) => void): () => void {
  authListeners.push(listener);
  return () => {
    authListeners = authListeners.filter(l => l !== listener);
  };
}

export function getPermissions(): string[] {
  return currentUser?.permissions || [];
}

export function hasPermission(permission: string): boolean {
  return getPermissions().includes(permission) || currentUser?.role === 'admin';
}

export function hasRole(role: UserRole | UserRole[]): boolean {
  if (!currentUser) return false;
  if (Array.isArray(role)) {
    return role.includes(currentUser.role);
  }
  return currentUser.role === role;
}
