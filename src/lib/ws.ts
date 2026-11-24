import { useEffect, useRef, useState } from 'react';

interface UseRealtimeOptions {
  room: string | null;
  staffToken?: string | null;
  tableToken?: string | null;
  onEvent: (eventName: string, payload: unknown) => void;
}

export function useRealtimeRoom({ room, staffToken, tableToken, onEvent }: UseRealtimeOptions) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!room) return;
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let attempt = 0;

    function connect() {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (!active) return;
        attempt = 0;
        setConnected(true);
        ws?.send(
          JSON.stringify({
            action: 'subscribe',
            room,
            staffToken: staffToken || undefined,
            tableToken: tableToken || undefined,
          })
        );
        pingTimer = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event && msg.event !== 'pong') {
            onEventRef.current(msg.event, msg.payload);
          }
        } catch {
          // Ignore malformed message
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingTimer) clearInterval(pingTimer);
        if (active) {
          const delay = Math.min(8000, 1000 * Math.pow(1.5, attempt));
          attempt += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      ws?.close();
    };
  }, [room, staffToken, tableToken]);

  return { connected };
}
