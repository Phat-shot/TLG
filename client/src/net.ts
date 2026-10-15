import { io, Socket } from 'socket.io-client';
import { getTokens, refresh } from './api';

export type Listener = (...args: any[]) => void;

let socket: Socket | null = null;

export function connect(onAuthLost: () => void): Socket {
  if (socket) return socket;
  socket = io({ autoConnect: false, auth: (cb) => cb({ token: getTokens()?.access_token }), reconnection: true, reconnectionDelayMax: 3000 });
  let refreshing = false;
  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized' && !refreshing) {
      refreshing = true;
      const ok = await refresh();
      refreshing = false;
      if (ok) socket!.connect(); else onAuthLost();
    }
  });
  socket.connect();
  return socket;
}
export function disconnect() { socket?.disconnect(); socket = null; }
export function sock(): Socket { if (!socket) throw new Error('not connected'); return socket; }
