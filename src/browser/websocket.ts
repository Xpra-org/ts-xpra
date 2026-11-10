import type { Transport } from '../core/types.ts';

export class WebSocketTransport implements Transport {
  private socket?: WebSocket;
  private cancelOpen?: () => void;
  private maxBufferedBytes: number;
  constructor(maxBufferedBytes = 16 * 1024 ** 2) { this.maxBufferedBytes = maxBufferedBytes; }
  open(url: string, handlers: Parameters<Transport['open']>[1]): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, 'binary'); this.socket = socket;
      socket.binaryType = 'arraybuffer';
      let opened = false;
      this.cancelOpen = () => reject(new Error('Connection cancelled'));
      socket.onopen = () => {
        if (socket.protocol !== 'binary') { reject(new Error('Server did not select the binary WebSocket subprotocol')); this.close(); return; }
        opened = true; this.cancelOpen = undefined; resolve();
      };
      socket.onmessage = event => {
        if (!(event.data instanceof ArrayBuffer)) { handlers.error(new Error('Expected binary WebSocket data')); return; }
        handlers.data(new Uint8Array(event.data));
      };
      socket.onerror = () => { const error = new Error('WebSocket connection failed. Check the endpoint, TLS certificate, and server WebSocket support.'); if (!opened) reject(error); else handlers.error(error); };
      socket.onclose = event => { if (!opened) reject(new Error('WebSocket closed before opening')); else handlers.close(`Transport closed (${event.code})${event.reason ? `: ${event.reason}` : ''}`); };
    });
  }
  send(data: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    if (this.socket.bufferedAmount + data.length > this.maxBufferedBytes) throw new Error('Outgoing WebSocket queue limit exceeded');
    this.socket.send(data as Uint8Array<ArrayBuffer>);
  }
  close() {
    const socket = this.socket; this.socket = undefined; this.cancelOpen?.(); this.cancelOpen = undefined;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); }
  }
}
