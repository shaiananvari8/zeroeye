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
 * Token Refresh Architecture:
 * - Single-flight coordination deduplicates concurrent refresh calls.
 * - BroadcastChannel synchronizes token renewal and session revocation across browser tabs.
 */

import { get, post, del, put } from './api';

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
const AUTH_CHANNEL_NAME = 'tot_auth_channel';
const REFRESH_THRESHOLD = 60; // seconds before expiry to attempt refresh

let currentTokens: AuthTokens | null = null;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let authListeners: Array<(user: User | null) => void> = [];

// Single-flight in-flight refresh promise
let inFlightRefreshPromise: Promise<AuthTokens | null> | null = null;

// Cross-tab broadcast channel
let broadcastChannel: BroadcastChannel | null = null;

// ---------------------------------------------------------------------------
// CROSS-TAB COORDINATION
// ---------------------------------------------------------------------------

function initBroadcastChannel(): void {
  if (typeof window !== 'undefined' && 'BroadcastChannel' in window && !broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      broadcastChannel.onmessage = (event) => {
        const { type } = event.data || {};
        if (type === 'REFRESH_SUCCESS') {
          const tokens = loadStoredTokens();
          if (tokens) {
            currentTokens = tokens;
            scheduleTokenRefresh(tokens);
          }
        } else if (type === 'REFRESH_FAILURE' || type === 'LOGOUT') {
          clearStoredTokens();
          currentUser = null;
          notifyListeners(null);
        }
      };
    } catch {
      // BroadcastChannel unavailable in non-browser or sandboxed environments
    }
  }
}

initBroadcastChannel();

function broadcastAuthEvent(type: 'REFRESH_SUCCESS' | 'REFRESH_FAILURE' | 'LOGOUT'): void {
  if (broadcastChannel) {
    try {
      // Broadcast event notification without logging or transmitting sensitive raw tokens
      broadcastChannel.postMessage({ type, timestamp: Date.now() });
    } catch {
      // ignore
    }
  }
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

export function storeTokens(tokens: AuthTokens): void {
  currentTokens = tokens;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    // localStorage may be unavailable in some environments
  }
}

export function clearStoredTokens(): void {
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

  broadcastAuthEvent('LOGOUT');
  notifyListeners(null);
}

/**
 * Single-flight token refresh with cross-tab notification
 * Deduplicates overlapping refresh calls and clears in-flight state on completion/failure.
 */
export async function refreshTokens(): Promise<AuthTokens | null> {
  // 1. Single-flight: Return existing in-flight promise if a refresh is already underway
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }

  const tokens = currentTokens || loadStoredTokens();
  if (!tokens?.refreshToken) return null;

  inFlightRefreshPromise = (async () => {
    try {
      const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
        refreshToken: tokens.refreshToken,
      });

      storeTokens(response.data.tokens);
      scheduleTokenRefresh(response.data.tokens);
      broadcastAuthEvent('REFRESH_SUCCESS');

      return response.data.tokens;
    } catch {
      clearStoredTokens();
      currentUser = null;
      notifyListeners(null);
      broadcastAuthEvent('REFRESH_FAILURE');
      return null;
    } finally {
      // Clear in-flight promise so future refresh attempts can execute cleanly
      inFlightRefreshPromise = null;
    }
  })();

  return inFlightRefreshPromise;
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
