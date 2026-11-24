import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DBInstance } from './db.ts';
import { sha256 } from './security.ts';

interface ClientMeta {
  ws: WebSocket;
  rooms: Set<string>;
}

export interface RealtimeHub {
  broadcastToRoom: (room: string, event: string, payload: unknown) => void;
  broadcastOrderUpdate: (tableSessionId: number, payload: unknown) => void;
  broadcastMenuUpdate: () => void;
  getConnectedCount: () => number;
  close: () => void;
}

export function createRealtimeHub(httpServer: HttpServer | null, db: DBInstance): RealtimeHub {
  const clients = new Set<ClientMeta>();
  let wss: WebSocketServer | null = null;

  if (httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws) => {
      const meta: ClientMeta = { ws, rooms: new Set(['public:menu']) };
      clients.add(meta);

      ws.send(JSON.stringify({ event: 'ws:connected', payload: { timestamp: new Date().toISOString() } }));

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            action?: string;
            room?: string;
            staffToken?: string;
            tableToken?: string;
            tableSessionId?: number;
          };

          if (msg.action === 'ping') {
            ws.send(JSON.stringify({ event: 'pong', payload: { t: Date.now() } }));
            return;
          }

          if (msg.action === 'subscribe' && typeof msg.room === 'string') {
            // Authorize staff rooms using staff session token
            if (msg.room.startsWith('role:')) {
              const targetRole = msg.room.replace('role:', '');
              if (!msg.staffToken) return;
              const tokenHash = sha256(msg.staffToken);
              const session = db
                .prepare(
                  `SELECT u.id, r.slug as role_slug
                   FROM staff_sessions s
                   JOIN users u ON u.id = s.user_id
                   JOIN roles r ON r.id = u.role_id
                   WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
                )
                .get(tokenHash) as { id: number; role_slug: string } | undefined;

              if (!session) {
                ws.send(JSON.stringify({ event: 'ws:error', payload: { error: 'Unauthorized room subscription' } }));
                return;
              }
              if (
                session.role_slug === 'super_admin' ||
                session.role_slug === targetRole ||
                (session.role_slug === 'chef' && targetRole === 'kitchen') ||
                (session.role_slug === 'admin' && targetRole !== 'super_admin')
              ) {
                meta.rooms.add(msg.room);
                ws.send(JSON.stringify({ event: 'ws:subscribed', payload: { room: msg.room } }));
              }
              return;
            }

            // Authorize customer table session room using customer table access token
            if (msg.room.startsWith('table:')) {
              const sessId = Number(msg.room.replace('table:', ''));
              if (!msg.tableToken || !Number.isFinite(sessId)) return;
              const access = db
                .prepare(
                  `SELECT session_id FROM table_access_tokens
                   WHERE token_hash = ? AND session_id = ? AND expires_at > datetime('now')`
                )
                .get(sha256(msg.tableToken), sessId) as { session_id: number } | undefined;
              if (!access) {
                ws.send(JSON.stringify({ event: 'ws:error', payload: { error: 'Invalid table session subscription' } }));
                return;
              }
              meta.rooms.add(msg.room);
              ws.send(JSON.stringify({ event: 'ws:subscribed', payload: { room: msg.room } }));
              return;
            }

            if (msg.room === 'public:menu') {
              meta.rooms.add('public:menu');
            }
          }
        } catch {
          // Ignore malformed JSON frames safely
        }
      });

      ws.on('close', () => {
        clients.delete(meta);
      });
    });
  }

  function broadcastToRoom(room: string, event: string, payload: unknown) {
    const data = JSON.stringify({ event, room, payload, timestamp: new Date().toISOString() });
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN && client.rooms.has(room)) {
        client.ws.send(data);
      }
    }
  }

  function broadcastOrderUpdate(tableSessionId: number, payload: unknown) {
    broadcastToRoom(`table:${tableSessionId}`, 'sync:update', payload);
    broadcastToRoom('role:kitchen', 'sync:update', payload);
    broadcastToRoom('role:counter', 'sync:update', payload);
    broadcastToRoom('role:admin', 'sync:update', payload);
    broadcastToRoom('role:waiter', 'sync:update', payload);
    broadcastToRoom('role:super_admin', 'sync:update', payload);
  }

  function broadcastMenuUpdate() {
    broadcastToRoom('public:menu', 'menu:updated', { updatedAt: new Date().toISOString() });
    broadcastToRoom('role:counter', 'menu:updated', { updatedAt: new Date().toISOString() });
    broadcastToRoom('role:admin', 'menu:updated', { updatedAt: new Date().toISOString() });
  }

  return {
    broadcastToRoom,
    broadcastOrderUpdate,
    broadcastMenuUpdate,
    getConnectedCount: () => clients.size,
    close: () => {
      wss?.close();
    },
  };
}
