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

    void Start()
    {
        if (whisperManager == null) whisperManager = GetComponent<WhisperManager>();
        llm = FindObjectOfType<LlmService>();

        if (Microphone.devices.Length > 0) _micDevice = Microphone.devices[0];
        else Debug.LogError("No Microphone detected!");
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
            if (Microphone.IsRecording(_micDevice)) StopAndTranscribe();
            else StartRecording();
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
        int pos = Microphone.GetPosition(_micDevice);

        // Analysis of small chunk of audio (256 samples) to analyze
        if (pos > 256 && _clip != null)
        {
            float[] samples = new float[256];
            _clip.GetData(samples, pos - 256); // Grab the most recent audio

            // Find the peak volume in this chunk
            float peak = 0f;
            for (int i = 0; i < samples.Length; i++)
            {
                if (Mathf.Abs(samples[i]) > peak) peak = Mathf.Abs(samples[i]);
            }

            // Determine if the user is currently speaking based on our threshold
            if (peak > vadThreshold)
            {
                _currentSpeechMs += Time.deltaTime * 1000f;
                _currentPauseMs = 0f; // Reset pause timer because they are making noise
                _isCurrentlySpeaking = 1;
            }
            else
            {
                _currentPauseMs += Time.deltaTime * 1000f;
                // If they pause for more than 1.5 seconds, we consider the speaking turn OVER  
                if (_currentPauseMs > 1500f) _isCurrentlySpeaking = 0;
            }

            // Send this data to the Bun server every X seconds
            _timeSinceLastVadSend += Time.deltaTime;
            if (_timeSinceLastVadSend >= vadUpdateInterval && llm != null)
            {
                BcFeatures bc = new BcFeatures
                {
                    vad = _isCurrentlySpeaking,
                    pauseMs = _currentPauseMs,
                    speechMs = _currentSpeechMs,
                    addressee = "UNKNOWN", // UKNOWN let's both agent do the backchanneling.
                    agentsSpeaking = new AgentsSpeaking { HR = false, TECH = false } // Assume agents aren't talking over you
                };

                llm.SendBackchannelFeatures(bc);
                _timeSinceLastVadSend = 0f; // And then we reset the network timer for some reason
            }
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