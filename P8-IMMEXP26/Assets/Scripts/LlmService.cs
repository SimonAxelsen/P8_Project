using UnityEngine;
using System.Text;
using System.Collections.Generic;
using NativeWebSocket;

/// <summary>
/// Shared LLM service. Connects to the relay server via WebSocket.
/// </summary>
public class LlmService : MonoBehaviour
{
    [Header("Relay Server")]
    public string serverUrl = "ws://localhost:3000";

    private WebSocket ws;
    private readonly Dictionary<string, System.Action<string>> pending = new();
    private readonly Dictionary<string, System.Action<string, string>> pendingConv = new();

    async void Start()
    {
        ws = new WebSocket(serverUrl);
        ws.OnOpen    += ()  => Debug.Log("[LlmService] Connected");
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

    /// <summary>Legacy single-shot prompt for one NPC.</summary>
    public void Ask(string userText, NPCProfile profile, System.Action<string> onResponse)
    {
        if (!IsConnected()) return;
        pending[profile.npcName] = onResponse;
        ws.SendText(JsonUtility.ToJson(new RelayRequest
        {
            type = "llm", npc = profile.npcName, model = profile.modelName,
            system_prompt = profile.GetSystemPrompt(), prompt = userText,
            options = new LlmOptions { temperature = profile.temperature, repeat_penalty = profile.repeatPenalty }
        }));
    }

    /// <summary>
    /// Interview conversation turn. Server picks the NPC and responds — one round trip.
    /// Callback receives (npcName, rawResponse).
    /// </summary>
    public void AskConversation(string sessionId, string playerText, NPCProfile a, NPCProfile b, System.Action<string, string> onResponse)
    {
        if (!IsConnected()) return;
        pendingConv[sessionId] = onResponse;
        ws.SendText(JsonUtility.ToJson(new ConversationRequest
        {
            type = "conversation_turn", session = sessionId, prompt = playerText,
            npcs = new NpcInfoArray
            {
                npc0_name = a.npcName, npc0_system = a.GetSystemPrompt(), npc0_model = a.modelName,
                npc0_temp = a.temperature, npc0_repeat = a.repeatPenalty,
                npc1_name = b.npcName, npc1_system = b.GetSystemPrompt(), npc1_model = b.modelName,
                npc1_temp = b.temperature, npc1_repeat = b.repeatPenalty
            }
        }));
    }

    bool IsConnected()
    {
        if (ws == null || ws.State != WebSocketState.Open)
        { Debug.LogError("[LlmService] Not connected"); return false; }
        return true;
    }

    void OnMessage(byte[] bytes)
    {
        string raw = Encoding.UTF8.GetString(bytes);
        var msg = JsonUtility.FromJson<RelayResponse>(raw);

        if (msg.type == "llm" && pending.TryGetValue(msg.npc, out var cb))
        { pending.Remove(msg.npc); cb?.Invoke(msg.response); }
        else if (msg.type == "conversation_turn" && pendingConv.TryGetValue(msg.session, out var ccb))
        { pendingConv.Remove(msg.session); ccb?.Invoke(msg.npc, msg.response); }
        else if (msg.type == "error")
            Debug.LogError($"[Relay] {msg.message}");
    }
}

// ── JSON wire types ─────────────────────────────────────────────

[System.Serializable] class RelayRequest { public string type, npc, model, system_prompt, prompt; public LlmOptions options; }
[System.Serializable] class LlmOptions { public float temperature, repeat_penalty; }
[System.Serializable] class RelayResponse { public string type, npc, response, message, session; }

[System.Serializable]
class NpcInfoArray
{
    public string npc0_name, npc0_system, npc0_model;
    public float npc0_temp, npc0_repeat;
    public string npc1_name, npc1_system, npc1_model;
    public float npc1_temp, npc1_repeat;
}

[System.Serializable]
class ConversationRequest
{
    public string type, session, prompt;
    public NpcInfoArray npcs;
}