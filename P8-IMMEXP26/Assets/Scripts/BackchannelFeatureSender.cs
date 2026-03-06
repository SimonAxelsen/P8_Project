using UnityEngine;

public class BackchannelFeatureSender : MonoBehaviour
{
    public LlmService llm;

    [Header("Mic")]
    public string micDevice = null;      // null = default
    public int sampleRate = 16000;
    public int frameMs = 30;

    [Header("VAD")]
    public float rmsThreshold = 0.015f;  // tune this
    public float hangoverMs = 200f;

    [Header("Send Rate")]
    public float sendEveryMs = 100f;

    [Header("Triadic (optional)")]
    public string addressee = "UNKNOWN"; // later set from gaze logic

    private AudioClip clip;
    private int lastSamplePos;
    private float sendTimer;

    private bool vad;
    private float vadHangover;
    private float speechMs;
    private float pauseMs;

    private float[] frameBuf;

    void Start()
    {
        if (llm == null) llm = FindObjectOfType<LlmService>();
        int frameSamples = Mathf.CeilToInt(sampleRate * (frameMs / 1000f));
        frameBuf = new float[frameSamples];

        clip = Microphone.Start(micDevice, true, 1, sampleRate);
        lastSamplePos = 0;
    }

    void Update()
    {
        if (clip == null) return;

        int pos = Microphone.GetPosition(micDevice);
        if (pos < 0 || pos == lastSamplePos) return;

        // read the most recent frame
        int frameSamples = frameBuf.Length;
        int start = pos - frameSamples;
        if (start < 0) start += clip.samples;

        clip.GetData(frameBuf, start);

        float rms = ComputeRms(frameBuf);
        bool speechNow = rms >= rmsThreshold;

        // hangover to avoid flicker
        if (speechNow)
        {
            vad = true;
            vadHangover = hangoverMs;
        }
        else
        {
            vadHangover -= Time.deltaTime * 1000f;
            if (vadHangover <= 0) vad = false;
        }

        if (vad)
        {
            speechMs += Time.deltaTime * 1000f;
            pauseMs = 0;
        }
        else
        {
            pauseMs += Time.deltaTime * 1000f;
            speechMs = 0; // keep minimal; alternatively track segment separately
        }

        sendTimer += Time.deltaTime * 1000f;
        if (sendTimer >= sendEveryMs)
        {
            sendTimer = 0;
            var msg = new BcFeatures
            {
                type = "bc_features",
                vad = vad ? 1 : 0,
                pauseMs = pauseMs,
                speechMs = speechMs,
                addressee = addressee,
                agentsSpeaking = new AgentsSpeaking { HR = false, TECH = false } // wire this later
            };
            llm.SendBackchannelFeatures(msg);
        }

        lastSamplePos = pos;
    }

    float ComputeRms(float[] x)
    {
        double sum = 0;
        for (int i = 0; i < x.Length; i++) sum += x[i] * x[i];
        return Mathf.Sqrt((float)(sum / x.Length));
    }
}