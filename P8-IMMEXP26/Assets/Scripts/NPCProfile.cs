using UnityEngine;
using System;

/// <summary>
/// Lightweight NPC identity. System prompt + non-verbal instructions are baked
/// into the Ollama Modelfile (see server/modelfiles/). This just holds the
/// model reference and runtime tweaks editable in the Inspector.
/// </summary>
[Serializable]
public class NPCProfile
{
    public string npcName = "New NPC";

    [Header("Ollama Model (created via Modelfile)")]
    [Tooltip("Name of the Ollama model that already contains the system prompt + META instructions")]
    public string modelName = "npc-default";

    [Header("LLM Overrides")]
    [Range(0f, 2f)] public float temperature = 0.7f;
    [Range(1f, 2f)] public float repeatPenalty = 1.1f;

    [Header("Voice")]
    public string voiceModelName = "en_US-lessac-medium";
}

[CreateAssetMenu(fileName = "New NPC Profile", menuName = "AI/NPC Profile")]
public class NPCProfileAsset : ScriptableObject { public NPCProfile profile; }
