using UnityEngine;
using UnityEngine.InputSystem;
using Whisper;

public class VoiceTest : MonoBehaviour
{
    public WhisperManager whisperManager;
    private LlmService llm; //Sends VAD Data

    [Header("Input")]
    [Tooltip("Drag the XRI Right Interaction -> Activate action here")]
    public InputActionReference recordAction;

    [Header("UI")]
    public MicIndicator micIndicator;

    [Header("Dev")]
    public bool useTextInput = false;

    [Header("Voice Activity Detection (VAD)")]
    [Tooltip("How loud the mic needs to be to count as speaking (0.001 to 0.05)")]
    public float vadThreshold = 0.015f;
    [Tooltip("How often to send data to the server (seconds)")]
    public float vadUpdateInterval = 0.1f;

    private AudioClip _clip;
    private string _micDevice;
    private string _typedText = "";
    private bool _showInput = false;

    // VAD tracking variables
    private float _timeSinceLastVadSend = 0f;
    private float _currentSpeechMs = 0f;
    private float _currentPauseMs = 0f;
    private int _isCurrentlySpeaking = 0; // BINARY, 0 = no, 1 = yes

    private int turnIndex = 0;

    public ProsodyClient prosodyClient;   // drag in inspector or FindObjectOfType
    private int _frameSamples = 320;      // 20ms @ 16kHz
    private float[] _frameFloat;
    private short[] _framePcm16;

    void Start()
    {
        if (whisperManager == null) whisperManager = GetComponent<WhisperManager>();
        llm = FindObjectOfType<LlmService>();

        if (Microphone.devices.Length > 0) _micDevice = Microphone.devices[0];
        else Debug.LogError("No Microphone detected!");


        prosodyClient = prosodyClient != null ? prosodyClient : FindObjectOfType<ProsodyClient>();

        _frameSamples = 320; // 20ms @ 16kHz
        _frameFloat = new float[_frameSamples];
        _framePcm16 = new short[_frameSamples];
    }

    void Update()
    {
        if (useTextInput)
        {
            if (Keyboard.current != null && Keyboard.current.enterKey.wasPressedThisFrame && !_showInput)
            {
                _showInput = true;
            }
            return;
        }

        if (recordAction != null && recordAction.action.WasPressedThisFrame())
{
    // Grab the exact scene name (Case-Sensitive!)
    string currentScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name;

    // 1. PRIMARY FEATURE: We are in the interview, handle voice recording!
    if (currentScene == "CoreScene")
    {
        if (Microphone.IsRecording(_micDevice)) 
        {
            StopAndTranscribe();
        }
        else 
        {
            StartRecording();
        }
        micIndicator?.Toggle();
    }
    // 2. SECONDARY FEATURE: We are in the Lobby, handle scene transition!
    else
    {
        Scenetransition transition = FindObjectOfType<Scenetransition>();
        if (transition != null)
        {
            transition.BeginInterview();
        }
        else
        {
            Debug.LogWarning("No Scenetransition script found! Make sure the Transition Manager prefab is in this scene.");
        }
    }
}

        // VAD Loop in session when mic is running
        if (Microphone.IsRecording(_micDevice))
        {
            ProcessVAD();
        }
    }

    // ---Real-Time Audio Analysis ---
    void ProcessVAD()
    {
        if (_clip == null || prosodyClient == null || !prosodyClient.Connected) return;

        int pos = Microphone.GetPosition(_micDevice);
        if (pos <= 0) return;

        // Avoid wrap issues: since you record 300 seconds, wrap isn’t a concern.
        // Still clamp to avoid invalid GetData offsets.
        if (pos < _frameSamples) return;

        int start = pos - _frameSamples;
        start = Mathf.Clamp(start, 0, _clip.samples - _frameSamples);

        _clip.GetData(_frameFloat, start);

        // Convert float [-1,1] -> int16 PCM
        for (int i = 0; i < _frameSamples; i++)
        {
            float s = Mathf.Clamp(_frameFloat[i], -1f, 1f);
            _framePcm16[i] = (short)(s * 32767f);
        }

        // Send audio frame to Python
        prosodyClient.SendPcmFrame(_framePcm16);

        // Send BC features to Bun at your existing interval
        _timeSinceLastVadSend += Time.deltaTime;
        if (_timeSinceLastVadSend >= vadUpdateInterval && llm != null)
        {
            var pf = prosodyClient.Latest;

            BcFeatures bc = new BcFeatures
            {
                vad = pf.vad,
                pauseMs = pf.pauseMs,
                speechMs = pf.speechMs,
                addressee = "UNKNOWN", // later: compute from gaze
                agentsSpeaking = new AgentsSpeaking { HR = false, TECH = false }
            };

            llm.SendBackchannelFeatures(bc);
            _timeSinceLastVadSend = 0f;
        }
    }

    void OnGUI()
    {
        if (!useTextInput || !_showInput) return;
        GUILayout.BeginArea(new Rect(10, Screen.height - 50, 500, 40));
        GUILayout.BeginHorizontal();
        GUI.SetNextControlName("DevInput");
        _typedText = GUILayout.TextField(_typedText, GUILayout.Width(400));
        GUI.FocusControl("DevInput");

        if (GUILayout.Button("Send", GUILayout.Width(60)) || (Event.current.isKey && Event.current.keyCode == KeyCode.Return))
        {
            if (!string.IsNullOrEmpty(_typedText)) { Broadcast(_typedText); _typedText = ""; _showInput = false; }
        }
        GUILayout.EndHorizontal();
        GUILayout.EndArea();
    }

    void StartRecording()
    {
        Debug.Log("Recording... (Press Space/Trigger to stop)");

        // Reset our VAD timers for the new recording session
        _currentSpeechMs = 0f;
        _currentPauseMs = 0f;
        _isCurrentlySpeaking = 0;

        _clip = Microphone.Start(_micDevice, false, 300, 16000); // Record for 300 seconds (5 minutes)
    }

    async void StopAndTranscribe()
    {
        int samples = Microphone.GetPosition(_micDevice);
        Microphone.End(_micDevice);

        if (samples <= 0) { Debug.Log("No audio captured."); return; }

        float[] data = new float[samples * _clip.channels];
        _clip.GetData(data, 0);

        float peak = 0f;
        for (int i = 0; i < data.Length; i++) { float a = Mathf.Abs(data[i]); if (a > peak) peak = a; }
        Debug.Log($"Processing {samples / (float)_clip.frequency:F1}s | peak: {peak:F4} | ch: {_clip.channels} | freq: {_clip.frequency}");

        if (peak < 0.01f) { Debug.LogWarning("Mic audio too quiet — check your mic input!"); return; }

        var trimmed = AudioClip.Create("trimmed", samples, _clip.channels, _clip.frequency, false);
        trimmed.SetData(data, 0);

        var result = await whisperManager.GetTextAsync(trimmed);
        string text = result.Result?.Trim();
        Debug.Log($"<color=green>Heard:</color> {text}");

        if (string.IsNullOrEmpty(text) || text.Length < 2
            || text.Contains("[BLANK") || text.Contains("(BLANK")) return;

        Broadcast(text);
    }

    void Broadcast(string text)
    {
        Debug.Log($"<color=white>[Broadcast]</color> {text}");
        // Just send it to the first agent we find. The Bun server will decide who actually speaks!
        FindObjectOfType<NpcAgent>().Say(text);
    }
}