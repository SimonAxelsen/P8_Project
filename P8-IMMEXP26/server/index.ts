import { serve } from "bun";

const PORT = 3000;

serve({
  port: PORT,

  fetch(req, server) {
    // Upgrade HTTP request to WebSocket
    if (server.upgrade(req)) {
      return; 
    }

    return new Response("WebSocket server running", { status: 200 });
  },

  websocket: {
    open(ws) {
      console.log("Client connected");

      ws.send(JSON.stringify({
        type: "connected",
        message: "Hello from backend"
      }));

      // Heartbeat every 5 seconds
      const interval = setInterval(() => {
        ws.send(JSON.stringify({
          type: "heartbeat",
          timestamp: Date.now()
        }));
      }, 5000);

      (ws as any).heartbeat = interval;
    },

    message(ws, message) {
      console.log("📩 Received:", message.toString());

      // Echo message back
      ws.send(JSON.stringify({
        type: "echo",
        data: message.toString()
      }));
    },

    close(ws) {
      console.log("Client disconnected");

      if ((ws as any).heartbeat) {
        clearInterval((ws as any).heartbeat);
      }
    }
  }
});

console.log(`WebSocket server running on ws://0.0.0.0:${PORT}`);
