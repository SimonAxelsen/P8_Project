using UnityEngine;
using System;
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
    public string serverUrl = "ws://localhost:3001";

    [Header("ElevenLabs (server TTS)")]
    [Tooltip("When true, play server ElevenLabs audio and skip local Piper for replies.")]
    public bool useElevenLabsAudio = false;
    [Tooltip("Optional. If unset, uses an AudioSource on this GameObject.")]
    public AudioSource elevenLabsAudioSource;

    // Backchannel trigger from server.
    public System.Action<string, string> OnBackchannel;

    private WebSocket ws;
    private readonly Dictionary<string, System.Action<string>> pending = new();
    public static event System.Action<InterviewGameData> OnGameDataUpdated;

    void Awake()
    {
        if (useElevenLabsAudio && elevenLabsAudioSource == null)
            elevenLabsAudioSource = GetComponent<AudioSource>();
        if (useElevenLabsAudio && elevenLabsAudioSource == null)
            elevenLabsAudioSource = gameObject.AddComponent<AudioSource>();
    }

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

        // Gather phase instructions to structure the interview dynamically
        string phaseContext = "";
        if (InterviewManager.Instance != null)
        {
            phaseContext =  "\n" + InterviewManager.Instance.GetPhaseContext();
        }

        var msg = new RelayRequest
        {
            type = "llm",
            npc = npcKey,
            model = profile.modelName,
            // FIX: Remove the '+ phaseContext'. Let the Modelfile and Server do the thinking!
            system_prompt = profile.GetSystemPrompt(),
            prompt = userText,
            options = new LlmOptions
            {
                temperature = profile.temperature,
                repeat_penalty = profile.repeatPenalty,
                num_ctx = 4096,
                num_predict = 250,
                num_thread = 4
            }
        };

        ws.SendText(JsonUtility.ToJson(msg));
    }

    void OnMessage(byte[] bytes)
    {
    string raw = Encoding.UTF8.GetString(bytes);

    var baseMsg = JsonUtility.FromJson<BaseMsg>(raw);
    if (baseMsg == null || string.IsNullOrEmpty(baseMsg.type))
        return;

        if (baseMsg.type == "llm" || baseMsg.type == "llm_parsed")
        {
            // Parse the ENTIRE message into our new strict C# class
            var msg = JsonUtility.FromJson<ParsedLlmMessage>(raw);

            // --- THE CLEAN EVENT TRIGGER ---
            if (msg.gameData != null && msg.gameData.isOutro)
            {
                Debug.Log("<color=green>[SYSTEM] The server officially declared the Outro phase.</color>");
                // Turn on your Exit Text here!
            }

            // --- FUTURE PROOFING FOR YOUR HP BARS ---
            if (msg.gameData != null)
            {
                // Broadcast the data to any UI scripts that are listening!
                OnGameDataUpdated?.Invoke(msg.gameData);
            }

            // --- DIRECT-DELIVERY ROUTING ---
            NpcAgent[] allAgents = FindObjectsOfType<NpcAgent>();
            foreach (var agent in allAgents)
            {
                if (agent.Profile != null && agent.Profile.npcName == msg.npc)
                {
                    agent.OnLlmResponse(msg.response);
                }
            }
            return;
        }

        if (baseMsg.type == "bc_trigger")
    {
        var bc = JsonUtility.FromJson<BcTriggerMsg>(raw);
        OnBackchannel?.Invoke(bc.npc, bc.action);
        return;
    }

    if (baseMsg.type == "error")
    {
        var err = JsonUtility.FromJson<RelayResponse>(raw);
        Debug.LogError($"[Relay] {err.message}");
        return;
    }

    if (baseMsg.type == "audio")
    {
        var audioMsg = JsonUtility.FromJson<AudioMsg>(raw);
        if (audioMsg != null && useElevenLabsAudio && elevenLabsAudioSource != null && audioMsg.format == "pcm" && audioMsg.sampleRate > 0 && !string.IsNullOrEmpty(audioMsg.data))
        {
            AudioClip clip = DecodePcmToClip(audioMsg.data, audioMsg.sampleRate);
            if (clip != null)
            {
                elevenLabsAudioSource.clip = clip;
                elevenLabsAudioSource.Play();
                Debug.Log($"[LlmService] Playing ElevenLabs audio for npc={audioMsg.npc}, length={clip.length:F1}s");
            }
            else
                Debug.LogWarning("[LlmService] ElevenLabs audio received but PCM decode failed.");
        }
        else if (audioMsg != null && !useElevenLabsAudio)
            Debug.Log("[LlmService] ElevenLabs audio received; enable 'Use ElevenLabs Audio' on LlmService to hear it.");
        else if (audioMsg != null && useElevenLabsAudio && elevenLabsAudioSource == null)
            Debug.LogWarning("[LlmService] ElevenLabs audio received but no AudioSource (add one or enable Use ElevenLabs Audio).");
        return;
    }
    }

    /// <summary>Decode base64 PCM 16-bit LE to Unity AudioClip (mono).</summary>
    static AudioClip DecodePcmToClip(string base64, int sampleRate)
    {
        try
        {
            byte[] bytes = Convert.FromBase64String(base64);
            int sampleCount = bytes.Length / 2;
            float[] floats = new float[sampleCount];
            for (int i = 0; i < sampleCount; i++)
            {
                int s = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
                if (s >= 32768) s -= 65536;
                floats[i] = s / 32768f;
            }
            AudioClip clip = AudioClip.Create("ElevenLabs", sampleCount, 1, sampleRate, false);
            clip.SetData(floats, 0);
            return clip;
        }
        catch (Exception e)
        {
            Debug.LogError($"[LlmService] PCM decode failed: {e.Message}");
            return null;
        }
    }

    public void SendBackchannelFeatures(BcFeatures features)
    {
        if (ws == null || ws.State != WebSocketState.Open) return;
        ws.SendText(JsonUtility.ToJson(features));
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
    // OPTIMIZATION fields for Ollama to drastically reduce load and TTFT
    public int num_ctx;
    public int num_predict;
    public int num_thread;
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

[System.Serializable]
class AudioMsg
{
    public string type;
    public string npc;
    public string format;  // "pcm"
    public int sampleRate;
    public string data;    // base64
}

// Matches JSON and Bun
[System.Serializable]
public class InterviewGameData
{
    public string[] allCategories;
    public int[] allScores;
    public bool isOutro;
}

[System.Serializable]
public class ParsedLlmMessage
{
    public string type;
    public string npc;
    public string response;
    public InterviewGameData gameData;
}