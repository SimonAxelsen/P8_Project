using UnityEngine;
using System.Text;
using System.Collections.Generic;
using NativeWebSocket;

/// <summary>
/// Shared LLM service. Connects to the PC relay server via WebSocket.
/// Each NPC profile has its own Ollama model name (created via Modelfile with baked-in system prompt).
/// </summary>
public class LlmService : MonoBehaviour
{
    [Header("Relay Server")]
    public string serverUrl = "ws://localhost:3000";

    private WebSocket ws;
    private readonly Dictionary<string, System.Action<string>> pending = new();

    async void Start()
    {
        ws = new WebSocket(serverUrl);
        ws.OnOpen    += ()  => Debug.Log("[LlmService] Connected to relay");
        ws.OnError   += (e) => Debug.LogError($"[LlmService] WS error: {e}");
        ws.OnClose   += (_) => Debug.Log("[LlmService] WS closed");
        ws.OnMessage += OnMessage;
        await ws.Connect();
    }

    void Update()
    {
        #if !UNITY_WEBGL || UNITY_EDITOR
        ws?.DispatchMessageQueue();
        #endif
    }

    async void OnApplicationQuit() => await ws?.Close();

    /// <summary>Send a prompt to the relay server for a specific NPC.</summary>
    public void Ask(string userText, NPCProfile profile, System.Action<string> onResponse)
    {
        if (ws == null || ws.State != WebSocketState.Open)
        { Debug.LogError("[LlmService] WebSocket not connected"); return; }

        string npcKey = profile.npcName;
        pending[npcKey] = onResponse;

        var msg = new RelayRequest
        {
            type = "llm",
            npc = npcKey,
            model = profile.modelName,
            prompt = userText,
            options = new LlmOptions { temperature = profile.temperature, repeat_penalty = profile.repeatPenalty }
        };

        ws.SendText(JsonUtility.ToJson(msg));
    }

    void OnMessage(byte[] bytes)
    {
        string raw = Encoding.UTF8.GetString(bytes);
        var msg = JsonUtility.FromJson<RelayResponse>(raw);

        if (msg.type == "llm" && pending.TryGetValue(msg.npc, out var cb))
        {
            pending.Remove(msg.npc);
            cb?.Invoke(msg.response);
        }
        else if (msg.type == "error")
            Debug.LogError($"[Relay] {msg.message}");
    }
}

// JSON structures for WebSocket messages
[System.Serializable]
class RelayRequest
{
    public string type;
    public string npc;
    public string model;
    public string prompt;
    public LlmOptions options;
}

[System.Serializable]
class LlmOptions
{
    public float temperature;
    public float repeat_penalty;
}

[System.Serializable]
class RelayResponse
{
    public string type;
    public string npc;
    public string response;
    public string message; // for error type
}