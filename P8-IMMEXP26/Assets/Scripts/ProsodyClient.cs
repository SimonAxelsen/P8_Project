using UnityEngine;
using System;
using System.Text;
using NativeWebSocket;

public class ProsodyClient : MonoBehaviour
{
    [Header("Python Prosody WS")]
    public string pythonUrl = "ws://localhost:8765";

    [Header("Audio Format")]
    public int sampleRate = 16000;
    public int frameMs = 20; // must match Python FRAME_MS

    public bool Connected => _ws != null && _ws.State == WebSocketState.Open;

    // Latest features from Python
    public ProsodyFeatures Latest { get; private set; } = new ProsodyFeatures();

    public event Action<ProsodyFeatures> OnProsody;

    private WebSocket _ws;

    [Serializable]
    public class ProsodyFeatures
    {
        public string type;
        public int vad;
        public float rms;
        public float rmsDb;
        public float pauseMs;
        public float speechMs;
        public float f0Mean;      // may be 0 if null in JSON
        public float f0Slope;     // may be 0 if null in JSON
        public float voicedRatio; // may be 0 if null in JSON
        public float specFlux;
        public float speechConfidence;
        public float boundaryConfidence;
        public float turnEndScore;
        public float questionLike;
        public float engagementScore;
    }

    async void Start()
    {
        _ws = new WebSocket(pythonUrl);
        _ws.OnOpen += () => Debug.Log("[ProsodyClient] Connected to Python");
        _ws.OnError += (e) => Debug.LogError("[ProsodyClient] WS error: " + e);
        _ws.OnClose += (_) => Debug.Log("[ProsodyClient] Disconnected");
        _ws.OnMessage += OnMessage;

        await _ws.Connect();
    }

    void Update()
    {
#if !UNITY_WEBGL || UNITY_EDITOR
        _ws?.DispatchMessageQueue();
#endif
    }

    async void OnApplicationQuit()
    {
        if (_ws != null) await _ws.Close();
    }

    void OnMessage(byte[] bytes)
    {
        var raw = Encoding.UTF8.GetString(bytes);
        // Python sends JSON only
        var msg = JsonUtility.FromJson<ProsodyFeatures>(raw);
        if (msg == null || string.IsNullOrEmpty(msg.type)) return;

        if (msg.type == "prosody_features")
        {
            Latest = msg;
            OnProsody?.Invoke(Latest);
        }
    }

    /// <summary>
    /// Send one frame of int16 PCM mono to Python as binary.
    /// </summary>
    public void SendPcmFrame(short[] pcm)
    {
        if (_ws == null || _ws.State != WebSocketState.Open) return;

        byte[] bytes = new byte[pcm.Length * 2];
        Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
        _ws.Send(bytes);
    }
}
