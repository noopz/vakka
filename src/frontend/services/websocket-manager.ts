import { wsState } from "../signals/index.js";
import { getDeviceId, getDeviceSecret, getToken } from "./auth.js";

type WSState = "disconnected" | "connecting" | "connected" | "disconnecting";

class WebSocketManager extends EventTarget {
  private ws: WebSocket | null = null;
  private state: WSState = "disconnected";
  private token: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedSessions = new Set<string>();

  constructor() {
    super();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.state !== "connected") {
          this.reconnect();
        }
      });
    }
  }

  connect(token?: string): void {
    if (token) this.token = token;
    this.doConnect();
  }

  disconnect(): void {
    this.setState("disconnecting");
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  subscribe(sessionId: string): void {
    this.subscribedSessions.add(sessionId);
    this.send({ type: "subscribe", sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  send(payload: Record<string, any>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private doConnect(): void {
    if (this.state === "connecting" || this.state === "connected") return;
    this.setState("connecting");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;
    // Auth creds travel in the Sec-WebSocket-Protocol header (via the second
    // arg to `new WebSocket`) instead of the URL query string, so they don't
    // leak into server access logs. Server validates and echoes the matched
    // subprotocol back to complete the handshake.
    const deviceId = getDeviceId();
    const deviceSecret = getDeviceSecret();
    let subprotocol: string;
    if (deviceId && deviceSecret) {
      subprotocol = `vakka.device.${deviceId}.${deviceSecret}`;
    } else {
      const tok = this.token || getToken() || "";
      subprotocol = `vakka.bearer.${tok}`;
    }

    try {
      this.ws = new WebSocket(url, [subprotocol]);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.setState("connected");
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      // Re-subscribe to any sessions
      for (const sid of this.subscribedSessions) {
        this.send({ type: "subscribe", sessionId: sid });
      }
    };

    this.ws.onmessage = (event) => {
      this.reconnectAttempts = 0;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }

      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === "pong") return;

      this.dispatchEvent(
        new CustomEvent("message", { detail: data })
      );
    };

    this.ws.onclose = () => {
      this.cleanup();
      if (this.state !== "disconnecting") {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private reconnect(): void {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
    this.doConnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    const jitter = delay * 0.2 * Math.random();
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay + jitter);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
        this.pongTimer = setTimeout(() => {
          this.reconnect();
        }, 5000);
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(s: WSState): void {
    this.state = s;
    if (s === "disconnecting") {
      wsState.value = "disconnected";
    } else {
      wsState.value = s;
    }
    this.dispatchEvent(new CustomEvent("statechange", { detail: s }));
  }
}

export const wsManager = new WebSocketManager();
