
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import {
  getDeviceId,
  getDeviceSecret,
  setDeviceCredentials,
  clearDeviceCredentials,
  setToken,
} from "../services/auth.js";
import { registerDevice, verifyDevice } from "../services/api.js";

type Phase = "loading" | "pending" | "token-fallback";

export function LoginView() {
  const phase = useSignal<Phase>("loading");
  const deviceName = useSignal<string>("");
  const tokenInput = useSignal("");
  const tokenError = useSignal("");
  const showFallback = useSignal(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Run initial auth flow on mount
  useEffect(() => {
    (async () => {
      const id = getDeviceId();
      const secret = getDeviceSecret();

      if (id && secret) {
        // Have stored credentials — verify them
        try {
          const result = await verifyDevice(id, secret);
          if (result.status === "trusted") {
            location.reload();
            return;
          }
          if (result.status === "pending") {
            phase.value = "pending";
            deviceName.value = id;
            startPolling(id, secret);
            return;
          }
          // revoked or unknown — clear and re-register
          clearDeviceCredentials();
        } catch {
          // Server unreachable — clear and let them try again
          clearDeviceCredentials();
        }
      }

      // No credentials or cleared — register new device
      try {
        const result = await registerDevice(navigator.userAgent);
        setDeviceCredentials(result.deviceId, result.secret);
        if (result.status === "trusted") {
          location.reload();
          return;
        }
        // pending
        phase.value = "pending";
        deviceName.value = result.deviceId;
        startPolling(result.deviceId, result.secret);
      } catch {
        // Server unreachable — show fallback
        phase.value = "token-fallback";
        showFallback.value = true;
      }
    })();
  }, []);

  function startPolling(id: string, secret: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const result = await verifyDevice(id, secret);
        if (result.status === "trusted") {
          if (pollRef.current) clearInterval(pollRef.current);
          location.reload();
        } else if (result.status === "revoked" || result.status === "unknown") {
          if (pollRef.current) clearInterval(pollRef.current);
          clearDeviceCredentials();
          location.reload();
        }
      } catch {
        // Network error — keep polling
      }
    }, 3000);
  }

  const handleTokenSubmit = (e: Event) => {
    e.preventDefault();
    const trimmed = tokenInput.value.trim();
    if (!trimmed) {
      tokenError.value = "Token is required";
      return;
    }
    tokenError.value = "";
    setToken(trimmed);
    location.reload();
  };

  if (phase.value === "loading") {
    return (
      <div class="login-view">
        <div class="login-card">
          <h1>Vakka</h1>
          <div style="text-align: center; color: var(--text-muted); padding: 20px 0;">
            Connecting...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="login-view">
      <div class="login-card">
        <h1>Vakka</h1>

        {phase.value === "pending" && (
          <div style="text-align: center; padding: 12px 0;">
            <div style="margin-bottom: 12px; font-size: 15px; color: var(--text-muted);">
              Waiting for approval...
            </div>
            <div style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
              Open Vakka on a trusted device to approve this connection.
            </div>
            <div
              style="margin-top: 16px; width: 24px; height: 24px; border: 2px solid var(--text-muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block;"
            />
          </div>
        )}

        {!showFallback.value && (
          <div style="text-align: center; margin-top: 16px;">
            <button
              type="button"
              class="btn"
              style="font-size: 12px; color: var(--text-muted); background: none; border: none; cursor: pointer; text-decoration: underline;"
              onClick={() => (showFallback.value = true)}
            >
              Use bearer token instead
            </button>
          </div>
        )}

        {showFallback.value && (
          <form onSubmit={handleTokenSubmit} style="margin-top: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
              Bearer token (legacy)
            </div>
            <input
              type="password"
              placeholder="Enter bearer token"
              value={tokenInput.value}
              onInput={(e) => {
                tokenInput.value = (e.target as HTMLInputElement).value;
                if (tokenError.value) tokenError.value = "";
              }}
            />
            {tokenError.value && (
              <div style="color: var(--error); font-size: 13px;">
                {tokenError.value}
              </div>
            )}
            <button type="submit" class="btn btn-primary" style="margin-top: 8px;">
              Connect
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
