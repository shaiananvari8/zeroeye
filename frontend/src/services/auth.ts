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
 * Token refresh is coordinated with an in-tab single-flight promise plus a
 * short-lived localStorage lock for other tabs. Completion is announced through
 * BroadcastChannel when available and a storage-event fallback; raw tokens are
 * never included in cross-tab messages.
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
const REFRESH_CHANNEL_NAME = 'tot_auth_refresh';
const REFRESH_LOCK_KEY = 'tot_auth_refresh_lock';
const REFRESH_EVENT_KEY = 'tot_auth_refresh_event';
const REFRESH_THRESHOLD = 60; // seconds before expiry to attempt refresh
const REFRESH_LOCK_TTL_MS = 15000;
const REFRESH_EVENT_TTL_MS = 30000;

let currentTokens: AuthTokens | null = null;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let authListeners: Array<(user: User | null) => void> = [];
let refreshInFlight: Promise<AuthTokens | null> | null = null;
let refreshChannel: BroadcastChannel | null | undefined;
let refreshCoordinationReady = false;
let refreshWaiters: Array<(tokens: AuthTokens | null) => void> = [];

const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type RefreshEventType = 'refresh-success' | 'refresh-failure';

interface RefreshLock {
  owner: string;
  expiresAt: number;
}

interface RefreshEvent {
  type: RefreshEventType;
  eventId: string;
  owner: string;
  timestamp: number;
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

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function getRefreshChannel(): BroadcastChannel | null {
  if (refreshChannel !== undefined) return refreshChannel;
  if (typeof BroadcastChannel === 'undefined') {
    refreshChannel = null;
    return refreshChannel;
  }
  try {
    refreshChannel = new BroadcastChannel(REFRESH_CHANNEL_NAME);
  } catch {
    refreshChannel = null;
  }
  return refreshChannel;
}

function resolveRefreshWaiters(tokens: AuthTokens | null): void {
  const waiters = refreshWaiters;
  refreshWaiters = [];
  for (const resolve of waiters) {
    resolve(tokens);
  }
}

function handleRefreshEvent(event: RefreshEvent): void {
  if (!event || event.owner === TAB_ID) return;
  if (Date.now() - event.timestamp > REFRESH_EVENT_TTL_MS) return;

  if (event.type === 'refresh-success') {
    const tokens = loadStoredTokens();
    if (tokens) {
      scheduleTokenRefresh(tokens);
    }
    resolveRefreshWaiters(tokens);
    return;
  }

  clearStoredTokens();
  currentUser = null;
  notifyListeners(null);
  resolveRefreshWaiters(null);
}

function setupRefreshCoordination(): void {
  if (refreshCoordinationReady) return;
  refreshCoordinationReady = true;

  const channel = getRefreshChannel();
  if (channel) {
    channel.onmessage = (event: MessageEvent<RefreshEvent>) => {
      handleRefreshEvent(event.data);
    };
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== REFRESH_EVENT_KEY) return;
      const refreshEvent = parseJson<RefreshEvent>(event.newValue);
      if (refreshEvent) {
        handleRefreshEvent(refreshEvent);
      }
    });
  }
}

function readRefreshLock(): RefreshLock | null {
  try {
    return parseJson<RefreshLock>(localStorage.getItem(REFRESH_LOCK_KEY));
  } catch {
    return null;
  }
}

function acquireRefreshLock(): boolean {
  const expiresAt = Date.now() + REFRESH_LOCK_TTL_MS;
  try {
    const existing = readRefreshLock();
    if (existing && existing.owner !== TAB_ID && existing.expiresAt > Date.now()) {
      return false;
    }

    localStorage.setItem(REFRESH_LOCK_KEY, JSON.stringify({ owner: TAB_ID, expiresAt }));
    return readRefreshLock()?.owner === TAB_ID;
  } catch {
    // If storage is unavailable, keep same-tab single-flight behavior.
    return true;
  }
}

function releaseRefreshLock(): void {
  try {
    const existing = readRefreshLock();
    if (!existing || existing.owner === TAB_ID) {
      localStorage.removeItem(REFRESH_LOCK_KEY);
    }
  } catch {
    // ignore storage cleanup failures
  }
}

function publishRefreshEvent(type: RefreshEventType): void {
  const event: RefreshEvent = {
    type,
    eventId: `${TAB_ID}-${Date.now().toString(36)}`,
    owner: TAB_ID,
    timestamp: Date.now(),
  };

  const channel = getRefreshChannel();
  if (channel) {
    try {
      channel.postMessage(event);
    } catch {
      // storage event fallback below still applies
    }
  }

  try {
    localStorage.setItem(REFRESH_EVENT_KEY, JSON.stringify(event));
  } catch {
    // ignore storage fallback failures
  }
}

function waitForCoordinatedRefresh(): Promise<AuthTokens | null> {
  setupRefreshCoordination();

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      refreshWaiters = refreshWaiters.filter(waiter => waiter !== finish);
      resolve(loadStoredTokens());
    }, REFRESH_LOCK_TTL_MS);

    const finish = (tokens: AuthTokens | null) => {
      clearTimeout(timeoutId);
      resolve(tokens);
    };

    refreshWaiters.push(finish);
  });
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

export async function refreshTokens(): Promise<AuthTokens | null> {
  setupRefreshCoordination();

  if (refreshInFlight) {
    return refreshInFlight;
  }

  const tokens = currentTokens || loadStoredTokens();
  if (!tokens?.refreshToken) return null;

  if (!acquireRefreshLock()) {
    return waitForCoordinatedRefresh();
  }

  refreshInFlight = (async () => {
    try {
      const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
        refreshToken: tokens.refreshToken,
      });

      storeTokens(response.data.tokens);
      scheduleTokenRefresh(response.data.tokens);
      publishRefreshEvent('refresh-success');

      return response.data.tokens;
    } catch {
      clearStoredTokens();
      currentUser = null;
      notifyListeners(null);
      publishRefreshEvent('refresh-failure');
      return null;
    } finally {
      releaseRefreshLock();
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
