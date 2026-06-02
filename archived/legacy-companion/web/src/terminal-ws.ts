interface TerminalConnectionCallbacks {
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
}

export interface TerminalConnection {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  disconnect: () => void;
}

export function createTerminalConnection(
  terminalId: string,
  callbacks: TerminalConnectionCallbacks,
): TerminalConnection {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("companion_auth_token") || "";
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${terminalId}?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    callbacks.onOpen?.();
  };

  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      callbacks.onData(new Uint8Array(event.data));
    } else {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "exit") {
          callbacks.onExit(msg.exitCode);
        }
      } catch {
        // not JSON, ignore
      }
    }
  };

  socket.onerror = () => {
    callbacks.onError?.("Terminal WebSocket connection error");
  };

  socket.onclose = (event) => {
    if (!event.wasClean) {
      callbacks.onError?.("Terminal connection lost");
    }
  };

  return {
    sendInput(data: string) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    },
    sendResize(cols: number, rows: number) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    },
    disconnect() {
      socket.close();
    },
  };
}
