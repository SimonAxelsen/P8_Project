using UnityEngine;
using Whisper;

public class VoiceTest : MonoBehaviour
{
    public WhisperManager whisperManager;
    
    [Header("Dev")]
    public bool useTextInput = false;

    private AudioClip _clip;
    private string _micDevice;
    private string _typedText = "";
    private bool _showInput = false;

    void Start()
    {
        if (whisperManager == null) whisperManager = GetComponent<WhisperManager>();
        if (Microphone.devices.Length > 0) _micDevice = Microphone.devices[0];
        else Debug.LogError("No Microphone detected!");
    }

    void Update()
    {
        if (useTextInput)
        {
            if (Input.GetKeyDown(KeyCode.Return) && !_showInput) _showInput = true;
            return;
        }

        if (Input.GetKeyDown(KeyCode.Space))
        {
            if (Microphone.IsRecording(_micDevice)) StopAndTranscribe();
            else StartRecording();
        }
    }

    // --- Text input GUI (dev mode) ---
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
        Debug.Log("Recording... (Press Space to stop)");
        _clip = Microphone.Start(_micDevice, false, 10, 16000);
    }

    async void StopAndTranscribe()
    {
        // Trim clip to actual recorded length — massively speeds up Whisper inference
        int samples = Microphone.GetPosition(_micDevice);
        Microphone.End(_micDevice);

        if (samples <= 0) { Debug.Log("No audio captured."); return; }

        // Create a trimmed clip with only the recorded samples
        float[] data = new float[samples * _clip.channels];
        _clip.GetData(data, 0);

        // Check audio level — helps diagnose mic issues
        float peak = 0f;
        for (int i = 0; i < data.Length; i++) { float a = Mathf.Abs(data[i]); if (a > peak) peak = a; }
        Debug.Log($"Processing {samples / (float)_clip.frequency:F1}s | peak: {peak:F4} | ch: {_clip.channels} | freq: {_clip.frequency}");

        if (peak < 0.01f) { Debug.LogWarning("Mic audio too quiet — check your mic input!"); return; }

        var trimmed = AudioClip.Create("trimmed", samples, _clip.channels, _clip.frequency, false);
        trimmed.SetData(data, 0);

        var result = await whisperManager.GetTextAsync(trimmed);
        string text = result.Result?.Trim();
        Debug.Log($"<color=green>Heard:</color> {text}");

        // Filter garbage: empty, too short, or Whisper hallucinations
        if (string.IsNullOrEmpty(text) || text.Length < 2
            || text.Contains("[BLANK") || text.Contains("(BLANK")) return;

        Broadcast(text);
    }

    void Broadcast(string text)
    {
        Debug.Log($"<color=white>[Broadcast]</color> {text}");
        foreach (var agent in FindObjectsOfType<NpcAgent>())
            agent.Say(text);
    }
}