// Auth service with single-flight token refresh handling

type TokenData = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type RefreshMessage = {
  type: 'REFRESH_STARTED'| 'REFRESH_SUCCESS' | 'REFRESH_FAILED';
  token?: TokenData;
  error?: string;
};

const CHANNEL_NAME = 'auth-refresh-channel';
const TOKEN_KEY = 'auth_tokens';

let inFlightRefresh: Promise<TokenData> | null = null;
let broadcastChannel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
  }
  return broadcastChannel;
}

function getStoredTokens(): TokenData | null {
  const data = localStorage.getItem(TOKEN_KEY);
  return data ? JSON.parse(data) : null;
}

function setStoredTokens(tokens: TokenData): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

async function performRefresh(refreshToken: string): Promise<TokenData> {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error('Refresh failed');
  return res.json();
}

export async function refreshToken(): Promise<TokenData> {
  if (inFlightRefresh) return inFlightRefresh;

  const channel = getChannel();
  const tokens = getStoredTokens();
  if (!tokens) throw new Error('No tokens');

  inFlightRefresh = new Promise((resolve, reject) => {
    channel?.postMessage({ type: 'REFRESH_STARTED' } as RefreshMessage);

    performRefresh(tokens.refreshToken)
      .then((newTokens) => {
        setStoredTokens(newTokens);
        channel?.postMessage({ type: 'REFRESH_SUCCESS', token: newTokens });
        resolve(newTokens);
      })
      .catch((err) => {
        channel?.postMessage({ type: 'REFRESH_FAILED', error: err.message });
        reject(err);
      })
      .finally(() => { inFlightRefresh = null; });
  });

  return inFlightRefresh;
}

export function subscribeToRefresh(
  onSuccess: (t: TokenData) => void,
  onFailure: (e: string) => void
): () => void {
  const channel = getChannel();
  if (!channel) return () => {};

  const handler = (ev: MessageEvent<RefreshMessage>) => {
    if (ev.data.type === 'REFRESH_SUCCESS' && ev.data.token) {
      setStoredTokens(ev.data.token);
      onSuccess(ev.data.token);
    } else if (ev.data.type === 'REFRESH_FAILED') {
      onFailure(ev.data.error || 'Refresh failed');
    }
  };

  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}