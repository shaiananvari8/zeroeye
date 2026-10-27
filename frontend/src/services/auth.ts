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
 * Refresh callers share one in-flight promise per tab. Web Locks serialize
 * refreshes across tabs; waiters reload the stored result instead of rotating
 * the same credential twice. BroadcastChannel sends only completion/failure
 * notifications; token values remain in the existing token store.
 * Without Web Locks, in-tab deduplication and storage-event synchronization
 * still work, but simultaneous cross-tab requests cannot be serialized.
 * If storage is disabled, coordination is limited to the current tab.
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
const REFRESH_LOCK = 'tot_auth_refresh';
const REFRESH_THRESHOLD = 60; // seconds before expiry to attempt refresh

let currentTokens: AuthTokens | null = null;
let tokensPersisted = false;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let refreshInFlight: Promise<AuthTokens | null> | null = null;
let sessionVersion = 0;
let refreshChannel: BroadcastChannel | null = null;
let authListeners: Array<(user: User | null) => void> = [];

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
  tokensPersisted = false;
  sessionVersion++;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    tokensPersisted = true;
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearStoredTokens(): void {
  currentTokens = null;
  tokensPersisted = false;
  sessionVersion++;
  stopRefreshTimer();
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

function readStoredTokens(): { available: boolean; tokens: AuthTokens | null } {
  try {
    const value = localStorage.getItem(TOKEN_KEY);
    const tokens = value ? JSON.parse(value) : null;
    return { available: true, tokens: tokens &&
      typeof tokens.accessToken === 'string' && typeof tokens.refreshToken === 'string' &&
      Number.isFinite(tokens.expiresIn) && tokens.expiresIn > 0 ? tokens : null };
  } catch {
    return { available: false, tokens: null };
  }
}

function loadStoredTokens(): AuthTokens | null {
  const { tokens } = readStoredTokens();
  if (tokens && !isTokenExpired(tokens.accessToken)) {
    currentTokens = tokens;
    tokensPersisted = true;
    return tokens;
  }
  return null;
}

function stopRefreshTimer(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function sameTokens(a: AuthTokens | null, b: AuthTokens | null): boolean {
  return a?.accessToken === b?.accessToken && a?.refreshToken === b?.refreshToken;
}

function synchronizeStoredSession(): void {
  const stored = readStoredTokens();
  if (!stored.available || sameTokens(currentTokens, stored.tokens)) return;
  currentTokens = stored.tokens;
  tokensPersisted = stored.tokens !== null;
  sessionVersion++;
  stopRefreshTimer();
  currentUser = null;
  if (stored.tokens) {
    try { currentUser = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { /* unavailable */ }
    scheduleTokenRefresh(stored.tokens);
  }
  notifyListeners(currentUser);
}

function publishRefresh(type: 'refresh:success' | 'refresh:failure'): void {
  // Never broadcast credentials, error bodies or a replacement session.
  try { refreshChannel?.postMessage({ type }); } catch { /* storage events remain the fallback */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === TOKEN_KEY || event.key === null) synchronizeStoredSession();
  });
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      refreshChannel = new BroadcastChannel(REFRESH_LOCK);
      refreshChannel.onmessage = event => {
        if (event.data?.type === 'refresh:success' || event.data?.type === 'refresh:failure') {
          // Re-read authoritative storage: delayed or forged messages cannot
          // overwrite a newer login, nor can their payload supply credentials.
          synchronizeStoredSession();
        }
      };
    }
  } catch { /* storage events work when BroadcastChannel is unavailable */ }
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
  // Invalidate pending refreshes before awaiting the network logout.
  clearStoredTokens();
  currentUser = null;
  notifyListeners(null);
  try {
    await del('/auth/logout');
  } catch {
    // Local logout succeeds even when the server cannot be reached.
  }
}

export function refreshTokens(): Promise<AuthTokens | null> {
  if (refreshInFlight) return refreshInFlight;
  const stored = readStoredTokens();
  // A storage event may still be queued after another tab logged out. Only
  // trust absence as invalidation if this tab previously persisted its tokens;
  // failed writes (e.g. quota errors) must retain the memory-only fallback.
  if (tokensPersisted && stored.available && !sameTokens(currentTokens, stored.tokens)) {
    synchronizeStoredSession();
    return Promise.resolve(currentTokens);
  }
  // An expired access token can still carry a usable refresh credential.
  const tokens = currentTokens || readStoredTokens().tokens;
  if (!tokens?.refreshToken) return Promise.resolve(null);
  const version = sessionVersion;
  const persisted = readStoredTokens();

  const superseded = (): boolean => {
    if (sessionVersion !== version) return true;
    const latest = readStoredTokens();
    if (persisted.available && latest.available &&
        (!sameTokens(persisted.tokens, latest.tokens) ||
         (tokensPersisted && latest.tokens !== null && !sameTokens(tokens, latest.tokens)))) {
      // A lock holder or a new login already changed the session, even if
      // the asynchronous storage notification has not reached this tab yet.
      synchronizeStoredSession();
      return true;
    }
    return false;
  };

  const renew = async (): Promise<AuthTokens | null> => {
    if (superseded()) return currentTokens;
    try {
      const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
        refreshToken: tokens.refreshToken,
      });
      if (superseded()) return currentTokens;
      storeTokens(response.data.tokens);
      scheduleTokenRefresh(response.data.tokens);
      publishRefresh('refresh:success');
      return response.data.tokens;
    } catch {
      // Do not clear a new login or restore a session after logout.
      if (superseded()) return currentTokens;
      clearStoredTokens();
      currentUser = null;
      notifyListeners(null);
      publishRefresh('refresh:failure');
      return null;
    }
  };

  const operation = Promise.resolve().then(() => {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(REFRESH_LOCK, renew);
    }
    return renew();
  });
  const pending = operation.finally(() => {
    if (refreshInFlight === pending) refreshInFlight = null;
  });
  refreshInFlight = pending;
  return pending;
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
