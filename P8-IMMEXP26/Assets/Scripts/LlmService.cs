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

    // Backchannel trigger from server.
    public System.Action<string, string> OnBackchannel;

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
            system_prompt = profile.GetSystemPrompt(),
            prompt = userText,
            options = new LlmOptions { temperature = profile.temperature, repeat_penalty = profile.repeatPenalty }
        };

        ws.SendText(JsonUtility.ToJson(msg));
    }

    void OnMessage(byte[] bytes)
{
    string raw = Encoding.UTF8.GetString(bytes);

    var baseMsg = JsonUtility.FromJson<BaseMsg>(raw);
    if (baseMsg == null || string.IsNullOrEmpty(baseMsg.type))
        return;

    if (baseMsg.type == "llm")
    {
        var msg = JsonUtility.FromJson<RelayResponse>(raw);
        if (pending.TryGetValue(msg.npc, out var cb))
        {
            pending.Remove(msg.npc);
            cb?.Invoke(msg.response);
        }
        return;
    }

    if (baseMsg.type == "bc_trigger")
    {
        var bc = JsonUtility.FromJson<BcTriggerMsg>(raw);
            Debug.Log($"[BC] npc={bc.npc} action={bc.action}");
            OnBackchannel?.Invoke(bc.npc, bc.action);
        return;
    }

    if (baseMsg.type == "error")
    {
        var err = JsonUtility.FromJson<RelayResponse>(raw);
        Debug.LogError($"[Relay] {err.message}");
        return;
    }

    


}



[System.Serializable]
public class BcFeatures
{
    public string type = "bc_features";
    public int vad;           // 0/1
    public float pauseMs;
    public float speechMs;
    public string addressee;  // "HR"/"TECH"/"UNKNOWN"
    public AgentsSpeaking agentsSpeaking = new AgentsSpeaking();
}

[System.Serializable]
public class AgentsSpeaking
{
    public bool HR;
    public bool TECH;
}
    private float _bcLogCooldown;

    public void SendBackchannelFeatures(BcFeatures features)
    {
        if (ws == null || ws.State != WebSocketState.Open) return;

        ws.SendText(JsonUtility.ToJson(features));

        _bcLogCooldown += Time.deltaTime;
        if (_bcLogCooldown >= 1f)
        {
            _bcLogCooldown = 0f;
            Debug.Log($"[BC->Server] vad={features.vad} pauseMs={features.pauseMs:F0} speechMs={features.speechMs:F0} addr={features.addressee}");
        }
    }



}

// JSON structures for WebSocket messages
[System.Serializable]
class RelayRequest
{
    public string type;
    public string npc;
    public string model;
    public string system_prompt;
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

[System.Serializable]
class BaseMsg { public string type; }

[System.Serializable]
class BcTriggerMsg
{
    public string type;   // "bc_trigger"
    public string npc;    // "HR" or "TECH"
    public string action; // animator trigger
}