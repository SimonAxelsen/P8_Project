using UnityEngine;

public class BackchannelFeatureSender : MonoBehaviour
{
    public LlmService llm;

    [Header("Mic")]
    [Tooltip("Leave empty/null to use default. Prefer setting explicitly in VR.")]
    public string micDevice = null;
    public int sampleRate = 48000;   // 48000 is often safer in VR/headsets
    public int frameMs = 30;

    [Header("VAD")]
    public float rmsThreshold = 0.003f; 
    public float hangoverMs = 200f;

    [Header("Send Rate")]
    public float sendEveryMs = 100f;

    [Header("Triadic (optional)")]
    public string addressee = "UNKNOWN"; // later set from gaze logic

    private AudioClip clip;
    private float sendTimer;

    private bool vad;
    private float vadHangover;
    private float speechMs;
    private float pauseMs;

    private float[] frameBuf;



    void Start()
    {
        if (llm == null) llm = FindObjectOfType<LlmService>();

        Debug.Log("Mics: " + string.Join(", ", Microphone.devices));

        // If micDevice isn't set, keep null (Unity default), but in VR you usually want to set it explicitly.
        int frameSamples = Mathf.CeilToInt(sampleRate * (frameMs / 1000f));
        frameBuf = new float[frameSamples];

        clip = Microphone.Start(micDevice, true, 1, sampleRate);


    }

    void OnDisable()
    {
        if (Microphone.IsRecording(micDevice))
            Microphone.End(micDevice);
    }

    void Update()
    {
        if (clip == null) return;
        if (!Microphone.IsRecording(micDevice)) return;

        int pos = Microphone.GetPosition(micDevice);
        if (pos <= 0) return;                 // mic not ready yet
        if (pos < frameBuf.Length) return;    // not enough samples yet

        // Avoid wrap-around reads (keeps GetData stable on more devices)
        int start = pos - frameBuf.Length;
        start = Mathf.Clamp(start, 0, clip.samples - frameBuf.Length);

        clip.GetData(frameBuf, start);

        float rms = ComputeRms(frameBuf);
        bool speechNow = rms >= rmsThreshold;

        // Hangover to avoid flicker
        if (speechNow)
        {
            vad = true;
            vadHangover = hangoverMs;
        }
        else
        {
            vadHangover -= Time.deltaTime * 1000f;
            if (vadHangover <= 0f) vad = false;
        }

        if (vad)
        {
            speechMs += Time.deltaTime * 1000f;
            pauseMs = 0f;
        }
        else
        {
            pauseMs += Time.deltaTime * 1000f;
            speechMs = 0f; // minimal: resets when not speaking
        }

        sendTimer += Time.deltaTime * 1000f;
        if (sendTimer >= sendEveryMs)
        {
            sendTimer = 0f;

            var msg = new LlmService.BcFeatures
            {
                type = "bc_features",
                vad = vad ? 1 : 0,
                pauseMs = pauseMs,
                speechMs = speechMs,
                addressee = addressee,
                agentsSpeaking = new LlmService.AgentsSpeaking
                {
                    HR = false,
                    TECH = false
                }
            };

            llm.SendBackchannelFeatures(msg);
            
        }
    }

    float ComputeRms(float[] x)
    {
        double sum = 0;
        for (int i = 0; i < x.Length; i++) sum += x[i] * x[i];
        return Mathf.Sqrt((float)(sum / x.Length));
    }


}