import { BroadcastChannel } from 'broadcast-channel';

let inFlightRefreshPromise: Promise<any> | null = null;
const refreshChannel = new BroadcastChannel('token-refresh');

async function refreshToken() {
    if (inFlightRefreshPromise) {
        return inFlightRefreshPromise;
    }

    inFlightRefreshPromise = new Promise(async (resolve, reject) => {
        try {
            const response = await fetch('/api/refresh-token');
            if (!response.ok) throw new Error('Failed to refresh token');
            const data = await response.json();
            // Update token in storage
            localStorage.setItem('token', data.token);
            // Notify other tabs
            refreshChannel.postMessage({ success: true, token: data.token });
            resolve(data.token);
        } catch (error) {
            // Notify other tabs of failure
            refreshChannel.postMessage({ success: false });
            reject(error);
        } finally {
            inFlightRefreshPromise = null;
        }
    });

    return inFlightRefreshPromise;
}

refreshChannel.onmessage = (message) => {
    if (message.success) {
        // Handle successful refresh in other tabs
        localStorage.setItem('token', message.token);
    } else {
        // Handle refresh failure in other tabs
        console.error('Token refresh failed in another tab');
    }
};

export { refreshToken };