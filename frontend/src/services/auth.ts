import axios from 'axios';

// Constants for cross-tab sync
const AUTH_CHANNEL_NAME = 'auth_refresh_channel';
const REFRESH_TIMEOUT_MS = 10000;

class AuthService {
  private refreshTokenPromise: Promise<string> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      this.broadcastChannel.onmessage = (event) => {
        if (event.data?.type === 'REFRESH_SUCCESS') {
          // Reset local in-flight promise if another tab succeeded
          this.refreshTokenPromise = null;
        } else if (event.data?.type === 'REFRESH_FAILURE') {
          this.refreshTokenPromise = null;
        }
      };
    }
  }

  /**
   * Refreshes the authentication token using a single-flight pattern.
   * Concurrent callers share the same active promise, and multiple tabs
   * are synchronized via BroadcastChannel.
   */
  public async refreshToken(): Promise<string> {
    // If a refresh is already in-flight, return the shared promise
    if (this.refreshTokenPromise) {
      return this.refreshTokenPromise;
    }

    this.refreshTokenPromise = (async () => {
      try {
        // Timeout guard to prevent hanging promises
        const response = await axios.post('/api/auth/refresh', {},
          { timeout: REFRESH_TIMEOUT_MS }
        );
        
        const newToken = response.data.token;
        
        // Notify other tabs of success
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({ type: 'REFRESH_SUCCESS' });
        }

        return newToken;
      } catch (error) {
        // Notify other tabs of failure
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({ type: 'REFRESH_FAILURE' });
        }
        throw error;
      } finally {
        // Clean up the in-flight lock whether successful or failed
        this.refreshTokenPromise = null;
      }
    })();

    return this.refreshTokenPromise;
  }
}

export const authService = new AuthService();
export default authService;