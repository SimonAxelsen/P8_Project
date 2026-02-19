using UnityEngine;
using UnityEngine.Networking;
using System.Text;
using System.Collections;

/// <summary>
/// Shared stateless LLM service. One per scene. Agents call Ask() with their own profile.
/// </summary>
public class LlmService : MonoBehaviour
{
    [Header("Ollama")]
    public string ollamaUrl = "http://localhost:11434/api/generate";
    public string modelName = "qwen3:4b-instruct-2507-q4_K_M";

    /// <summary>Send a prompt to Ollama using the given NPC profile. Response returned via callback.</summary>
    public void Ask(string userText, NPCProfile profile, System.Action<string> onResponse)
    {
        StartCoroutine(PostRequest(userText, profile, onResponse));
    }

    IEnumerator PostRequest(string userPrompt, NPCProfile profile, System.Action<string> onResponse)
    {
        string system = profile != null ? profile.GetSystemPrompt() : "";
        float temp = profile != null ? profile.temperature : 0.7f;
        float rep  = profile != null ? profile.repeatPenalty : 1.1f;

        // Use a proper JSON structure class instead of manual string formatting
        // This avoids issues with escaping and missing fields
        var payload = new OllamaRequest
        {
            model = modelName,
            prompt = userPrompt,
            system = system,
            stream = false,
            options = new OllamaOptions { temperature = temp, repeat_penalty = rep }
        };

        string json = JsonUtility.ToJson(payload);

        // Debug.Log($"Sending JSON: {json}"); // Uncomment to debug request

        var req = new UnityWebRequest(ollamaUrl, "POST");
        req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "application/json");

        yield return req.SendWebRequest();

        if (req.result == UnityWebRequest.Result.Success)
        {
            string raw = req.downloadHandler.text;
            Debug.Log($"<color=yellow>[Ollama raw]</color> {raw.Substring(0, Mathf.Min(raw.Length, 300))}");
            onResponse?.Invoke(ParseResponse(raw));
        }
        else
            Debug.LogError($"Ollama error: {req.error}");
    }

    /// <summary>Extract the "response" string value from Ollama JSON by walking escaped quotes properly.</summary>
    string ParseResponse(string json)
    {
        string key = "\"response\":";
        int i = json.IndexOf(key);
        if (i == -1) return json;

        // Find the opening quote of the value
        int q = json.IndexOf('"', i + key.Length);
        if (q == -1) return json;

        // Walk forward collecting chars, respecting backslash escapes
        var sb = new StringBuilder();
        for (int c = q + 1; c < json.Length; c++)
        {
            if (json[c] == '\\' && c + 1 < json.Length)
            {
                char next = json[c + 1];
                if (next == '"')  { sb.Append('"'); c++; }
                else if (next == 'n')  { sb.Append('\n'); c++; }
                else if (next == 't')  { sb.Append('\t'); c++; }
                else if (next == '\\') { sb.Append('\\'); c++; }
                else { sb.Append(next); c++; }
            }
            else if (json[c] == '"') break; // unescaped quote = end of value
            else sb.Append(json[c]);
        }
        return sb.ToString();
    }
}

// Minimal JSON request structures for JsonUtility
[System.Serializable]
class OllamaRequest
{
    public string model;
    public string prompt;
    public string system;
    public bool stream;
    public OllamaOptions options;
}

[System.Serializable]
class OllamaOptions
{
    public float temperature;
    public float repeat_penalty;
}