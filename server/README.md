# Bun WebSocket Server

WebSocket server for the VR project. The server handles real-time communication between the Unity VR application and backend services.

## 📋 Prerequisites

- Bun runtime (see installation below)
- Unity 6.0.3 or newer
- VR headset or Unity Editor for testing

---

## 🚀 Installation

### Step 1: Install Bun

#### **Mac (macOS):**
```bash
# Via Homebrew (recommended)
brew install bun

# Or direct installer script
curl -fsSL https://bun.sh/install | bash
```

After installation, restart your terminal or run:
```bash
source ~/.zshrc  # or ~/.bash_profile
```

#### **Windows:**
```powershell
# Via PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Or download installer from: https://bun.sh/docs/installation

**Verify installation:**
```bash
bun --version
```

### Step 2: Install Dependencies

Navigate to the `server/` folder and install dependencies:

```bash
cd server
bun install
```

This installs all required packages defined in `package.json`.

---

## 🏃 Running the Server

### Start the Server

From the `server/` folder:

```bash
bun run index.ts
```

You should see:
```
WebSocket server running on ws://0.0.0.0:3000
```

The server is now running on port **3000** and listening on all network interfaces (`0.0.0.0`), meaning it can receive connections from other devices on the same network.

### Find Your IP Address

**Mac:**
```bash
# Find your local IP address
ifconfig | grep "inet " | grep -v 127.0.0.1
```

**Windows:**
```powershell
# Find your local IP address
ipconfig | findstr IPv4
```

You'll need this IP address in Unity (e.g., `ws://192.168.1.100:3000`).

---

## 🎮 Unity Setup

The Unity project already includes:
- ✅ NativeWebSocket package (installed)
- ✅ WebSocketTest script (in `Assets/Scripts/WebSocketTest.cs`)

### Step 1: Configure Server URL

1. Select `WebSocketTest` GameObject in Hierarchy
2. In Inspector, find the `Server Url` field
3. Update the URL to your PC's IP address:
   ```
   ws://[YOUR_IP_ADDRESS]:3000
   ```
   
   **Example:**
   - VR headset on network: `ws://192.168.1.100:3000`

### Step 2: Test Connection

1. **Start Bun server** (see above)
2. **Press Play** in Unity Editor
3. Open **Console** window (Window → General → Console)
4. You should see:
   ```
   WebSocket Connected!
   Received: {"type":"connected","message":"Hello from backend"}
   ```
5. **Test sending messages:**
   - Press **T** on keyboard
   - You should see echo in Console:
   ```
   Received: {"type":"echo","data":"Hello from Unity"}
   ```

---

---

## 📝 Notes

- Server runs on port **3000** by default
- Server sends heartbeat messages every 5 seconds
- All messages are echoed back to the client
- Server logs all connections and messages in console

---

## 🛠️ Development

### Project Structure
```
server/
├── index.ts          # Main server file
├── package.json      # Dependencies
├── tsconfig.json     # TypeScript configuration
└── README.md         # This file
```

### Adding New Features

Edit `index.ts` to add new WebSocket handlers or endpoints.

---

## 📚 Resources

- [Bun Documentation](https://bun.sh/docs)
- [NativeWebSocket GitHub](https://github.com/endel/NativeWebSocket)
- [Unity WebSocket Guide](https://docs.unity3d.com/Manual/webgl-networking.html)
