/**
 * Single-Flight Token Refresh Coordinator
 * Implements concurrent request coalescing and safe cross-tab BroadcastChannel sync
 * Solution for Bounty: shaiananvari8/zeroeye#1 ($35)
 */

export interface TokenSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type RefreshFn = () => Promise<TokenSession>;

export class SingleFlightAuthManager {
  private inFlightPromise: Promise<TokenSession> | null = null;
  private currentSession: TokenSession | null = null;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(channelName: string = 'auth_token_sync') {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel(channelName);
      this.broadcastChannel.onmessage = (event) => {
        if (event.data?.type === 'TOKEN_REFRESH_SUCCESS') {
          // Cross-tab sync without logging sensitive tokens in debug logs
          this.currentSession = event.data.session;
        } else if (event.data?.type === 'TOKEN_REFRESH_FAILURE') {
          this.inFlightPromise = null;
        }
      };
    }
  }

  public getSession(): TokenSession | null {
    return this.currentSession;
  }

  public setSession(session: TokenSession): void {
    this.currentSession = session;
  }

  /**
   * Coalesces concurrent refresh calls into a single in-flight operation
   */
  public async refreshToken(refreshFn: RefreshFn): Promise<TokenSession> {
    // If a refresh is already in flight, share the same promise
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const newSession = await refreshFn();
        this.currentSession = newSession;

        // Propagate across tabs
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'TOKEN_REFRESH_SUCCESS',
            session: newSession
          });
        }

        return newSession;
      } catch (error) {
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'TOKEN_REFRESH_FAILURE'
          });
        }
        throw error;
      } finally {
        // Clear in-flight marker so subsequent calls can retry normally
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  public cleanup(): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
  }
}
