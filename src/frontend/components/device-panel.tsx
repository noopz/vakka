
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { fetchDevices, approveDevice, removeDevice } from "../services/api.js";
import { fetchPairingMode, setPairingMode } from "../services/auth.js";
import { Clickable } from "./clickable.js";

interface DeviceInfo {
  name: string;
  status: "trusted" | "pending" | "revoked";
  created: string;
  lastSeen: string | null;
}

interface DevicePanelProps {
  onClose: () => void;
}

export function DevicePanel({ onClose }: DevicePanelProps) {
  const devices = useSignal<Record<string, DeviceInfo>>({});
  const loading = useSignal(true);
  const pairingMode = useSignal<boolean>(false);
  const pairingBusy = useSignal(false);

  const load = async () => {
    try {
      const [result, pm] = await Promise.all([fetchDevices(), fetchPairingMode()]);
      devices.value = result.devices;
      pairingMode.value = pm.pairingMode;
    } catch {}
    loading.value = false;
  };

  useEffect(() => {
    load();
    // Poll while the modal is open so newly-registered pending devices show
    // up without a manual reload. 3s strikes a balance between freshness and
    // request volume — the modal is short-lived.
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const handleTogglePairing = async () => {
    if (pairingBusy.value) return;
    pairingBusy.value = true;
    try {
      const res = await setPairingMode(!pairingMode.value);
      pairingMode.value = res.pairingMode;
    } catch {}
    pairingBusy.value = false;
  };

  const handleApprove = async (id: string) => {
    await approveDevice(id);
    load();
  };

  const handleRevoke = async (id: string) => {
    await removeDevice(id);
    load();
  };

  function shortName(ua: string): string {
    if (/iPhone/.test(ua)) return "iPhone Safari";
    if (/Android/.test(ua)) return "Android";
    if (/Mac/.test(ua) && /Chrome/.test(ua)) return "Mac Chrome";
    if (/Mac/.test(ua) && /Safari/.test(ua)) return "Mac Safari";
    if (/Mac/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    return ua.length > 30 ? ua.substring(0, 30) + "\u2026" : ua;
  }

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  const entries = Object.entries(devices.value);
  const pending = entries.filter(([_, d]) => d.status === "pending");
  const trusted = entries.filter(([_, d]) => d.status === "trusted");

  return (
    <Clickable
      class="modal-overlay"
      tabIndex={-1}
      onClick={(e: Event) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal" style="max-width: 520px;">
        <h2>Devices</h2>

        {!loading.value && (
          <div class="device-section-title" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <span>Pairing Mode</span>
            <button
              class={`btn btn-small ${pairingMode.value ? "btn-primary" : "btn-ghost"}`}
              disabled={pairingBusy.value}
              onClick={handleTogglePairing}
            >
              {pairingMode.value ? "ON" : "OFF"}
            </button>
          </div>
        )}

        {!loading.value && pairingMode.value && (
          <div
            style="background: #4a3a10; border: 1px solid #b8860b; color: #ffd479; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px;"
          >
            Pairing mode enabled — new device registrations will be accepted for approval. Disable when done.
          </div>
        )}

        {loading.value && <div style="color: var(--text-secondary);">Loading...</div>}

        {!loading.value && pending.length > 0 && (
          <div>
            <div class="device-section-title">Pending Approval</div>
            {pending.map(([id, device]) => (
              <div key={id} class="device-item pending">
                <div class="device-info">
                  <div class="device-name">{shortName(device.name)}</div>
                  <div class="device-meta">Added {relativeTime(device.created)}</div>
                </div>
                <div class="device-actions">
                  <button class="btn btn-primary btn-small" onClick={() => handleApprove(id)}>Approve</button>
                  <button class="btn btn-danger btn-small" onClick={() => handleRevoke(id)}>Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading.value && trusted.length > 0 && (
          <div>
            <div class="device-section-title">Trusted Devices</div>
            {trusted.map(([id, device]) => (
              <div key={id} class="device-item">
                <div class="device-info">
                  <div class="device-name">{shortName(device.name)}</div>
                  <div class="device-meta">
                    {device.lastSeen ? `Last seen ${relativeTime(device.lastSeen)}` : "Never connected"}
                  </div>
                </div>
                <div class="device-actions">
                  <button class="btn btn-ghost btn-small" onClick={() => handleRevoke(id)}>Revoke</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading.value && entries.length === 0 && (
          <div style="color: var(--text-secondary);">No devices registered.</div>
        )}

        <div class="modal-actions">
          <button class="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Clickable>
  );
}
