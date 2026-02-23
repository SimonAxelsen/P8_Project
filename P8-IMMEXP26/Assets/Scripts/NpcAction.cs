using System;
using UnityEngine;

/// <summary>
/// Lightweight non-verbal action extracted from LLM output.
/// LLM wraps JSON in [META]...[/META] tags at the start of its reply.
/// Example: [META]{"action":"nod","gaze":"speaker"}[/META] That sounds great!
/// </summary>
[Serializable]
public struct NpcAction
{
    public string action;   // animator trigger: nod, smile, lean_forward, lean_back, shake_head, idle
    public string gaze;     // speaker, away, neutral

    public bool IsEmpty => string.IsNullOrEmpty(action) && string.IsNullOrEmpty(gaze);

    public static readonly NpcAction None = new NpcAction { action = "idle", gaze = "neutral" };

    const string OPEN = "[META]";
    const string CLOSE = "[/META]";

    /// <summary>Parse [META]{...}[/META] from raw LLM text. Returns action + clean dialogue.</summary>
    public static (NpcAction action, string dialogue) Parse(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return (None, "");

        int a = raw.IndexOf(OPEN);
        int b = raw.IndexOf(CLOSE);
        if (a < 0 || b <= a) return (None, raw.Trim());

        string json = raw.Substring(a + OPEN.Length, b - a - OPEN.Length);
        string text = (raw.Substring(0, a) + raw.Substring(b + CLOSE.Length)).Trim();

        try   { return (JsonUtility.FromJson<NpcAction>(json), text); }
        catch { return (None, text); }
    }
}
