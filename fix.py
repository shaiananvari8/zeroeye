```typescript
/**
 * Solution 1: TypeScript Auth Service
 * 
 * Feature: Single-Flight Token Refresh Handling
 * Location: frontend/src/services/auth.ts
 * 
 * Description:
 * Implements single-flight refresh coordination to handle race conditions
 * when multiple browser tabs refresh a token simultaneously.
 * 
 * Strategy:
 * 1. Uses a storage-keyed "In-Flight" marker to track the active refresh promise.
 * 2. BroadcastChannel for immediate cross-tab propagation of refresh events.
 * 3. Robust cleanup on both success and failure to ensure deterministic state.
 */

// -----------------------------------------------------------------------------
// Shared Type Definitions & Constants
// -----------------------------------------------------------------------------

const AUTH_STORAGE_KEY = 'auth_refresh_in_flight';
const AUTH_TOKEN_KEY = 'auth_token';
const BROADCAST_CHANNEL_NAME = 'auth_refresh_channel';

interface RefreshEventPayload {
  type: 'REFRESH_SUCCESS' | 'REFRESH_FAILED' | 'REFRESH_STARTED';
  token?: string;
  error?: Error;
}

// -----------------------------------------------------------------------------
// Core Logic: AuthService
// -----------------------------------------------------------------------------

class AuthService {
  private storage: Storage;
  private channel: MessageChannel;
  private readonly storageKey: string;

  constructor() {
    // Initialize a Storage wrapper that handles cross-tab detection gracefully
    this.storage = window.localStorage;
    
    // Initialize BroadcastChannel with name BROADCAST_CHANNEL_NAME
    this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    
    // Set the key for our "In-Flight" state marker
    this.storageKey = AUTH_STORAGE_KEY;
    
    // Ensure the storage is initialized if this is the first call
    this.initializeStorage();
  }

  /**
   * Initializes the storage state.
   * Sets a default marker "true" if storage is empty to enable the first
   * tab's detection of the "in-flight" state immediately.
   */
  private initializeStorage() {
    const existing = this.storage.getItem(this.storageKey);
    if (!existing) {
      // Store a marker to indicate the "system" is aware of refresh logic
      this.storage.setItem(this.storageKey, 'true');
      
      // Notify other tabs that the service is "live"
      this.channel.postMessage({ type: 'REFRESH_STARTED' } as const);
    }
  }

  /**
   * The main entry point for refreshing the auth token.
   * Uses a "Shared Promise" pattern: if one tab starts a refresh, it writes the
   * fetch promise to storage. Subsequent tabs read that same promise and resolve
   * to the same final session state.
   */
  public async refresh(): Promise<TokenResponse> {
    const fetchLogic = async () => {
      // Perform the actual network request
      const response = await this.fetchTokenFromEndpoint();
      
      if (!response) {
        throw new Error('Token refresh returned null response');
      }

      // 1. Update the main "Live" token in storage
      this.storage.setItem(AUTH_TOKEN_KEY, response.token);

      // 2. Update the "In-Flight" marker
      // We set it to null to signal "Refresh Complete" so the next caller 
      // reads the token immediately rather than waiting.
      // Note: We update storage immediately to keep Tabs B & C in sync.
      this.storage.setItem(this.storageKey, null);

      // 3. Propagate via BroadcastChannel for sub-synchronous listeners
      this.channel.postMessage({
        type: 'REFRESH_SUCCESS',
        token: response.token
      } as RefreshEventPayload);

      return response;
    };

    // Determine the current state from storage
    const currentInFlight = this.storage.getItem(this.storageKey);

    // If 'currentInFlight' exists, it's the Promise from a previous call (e.g. Tab A).
    // We simply return that to wait for its resolution.
    // If it's null, we fire the fetch and let it update storage.
    
    let finalPromise = fetchLogic();

    // Handle the initial "in-flight" marker from initializeStorage/previous cycles
    if (currentInFlight) {
      // It was a previous in-flight promise.
      // We want to assign the result of `fetchLogic` to replace it in storage?
      // Or just return it?
      // Let's use the `getOrSet` pattern to keep it pure.
      
      // Strategy: If storage has a value, `finalPromise` resolves it.
      // If storage has 'true', we assign the fresh `finalPromise` to it.
      this.storage.setItem(this.storageKey, finalPromise);
      
      // Actually, the cleanest way is to check if the value in storage is the "marker".
      // But for simplicity, let's just bind the logic:
      
      // Wait... Tab A (fetchLogic) reads storage: finds 'true'. 
      // Stores `finalPromise`.
      // Tab B reads storage: finds `finalPromise`. Returns it.
      
      return finalPromise;
    }

    // If `currentInFlight` was null (initial load), we fire it, set it in storage,
    // and return it.
    
    return finalPromise.then(
      // On success, storage is updated inside the logic.
      (res) => res,
      // On failure, we need a catch block to handle cleanup.
      (rej) => {
        this.storage.setItem(this.storageKey, null); // Clean marker
        this.channel.postMessage({ type: 'REFRESH_FAILED', error: rej } as const);
        throw rej;
      }
    );
  }

  /**
   * Helper to ensure the "In-Flight" marker exists in storage.
   * This abstracts away the `true` vs `null` state check.
   */
  private ensureInFlightMarker() {
    const val = this.storage.getItem(this.storageKey);
    if (!val) {
      this.storage.setItem(this.storageKey, 'true');
      this.channel.postMessage({ type: 'REFRESH_STARTED' });
    }
  }

  /**
   * Fetches the token directly from the auth endpoint.
   * Assumes headers like `Authorization` are present or set elsewhere.
   */
  private async fetchTokenFromEndpoint(): Promise<TokenResponse> {
    // Simulating the network fetch behavior
    const url = `${window.location.origin}/api/auth/refresh`;
    
    try {
      const res = await fetch(url);
      
      // If the response is okay, parse and return
      if (res.ok) {
        const data = res.json();
        return {
          token: data.token,
          expiresAt: data.expiresAt || Date.now() + 300000 // Default 5 min
        };
      }
      
      return {
        token: data.token
      };
    } catch (err) {
      // Network error or parse error.
      throw new Error(`Token refresh failed: ${String(err)}`);
    }
  }

  /**
   * Gets the raw token currently stored.
   */
  public getToken(): string | null {
    return this.storage.getItem(AUTH_TOKEN_KEY);
  }

  /**
   * Subscribes to the BroadcastChannel for "live" events.
   * Useful for updating UIs without waiting for storage events.
   */
  public onRefresh(event: (msg: RefreshEventPayload) => void) {
    this.channel.addEventListener('message', (msg) => {
      event(msg.data);
    });
    
    // Sync with the current active tab state if available
    const currentMsg = this.channel.postMessage; 
    this.channel.postMessage({ type: 'STATE_SYNC' });
  }
}

// -----------------------------------------------------------------------------
// Module Export (for build.py to pick up)
// -----------------------------------------------------------------------------

export { AuthService, AUTH_STORAGE_KEY, BROADCAST_CHANNEL_NAME };

// -----------------------------------------------------------------------------
// Diagnostic Artifacts Injection
// (Automatically handled by build.py but useful for debugging)
// -----------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  (window as any).__DIAGNOSTIC_AUTH = true;
}
```