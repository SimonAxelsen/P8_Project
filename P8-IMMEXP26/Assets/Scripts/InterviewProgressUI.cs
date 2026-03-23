using UnityEngine;
using TMPro;

public class InterviewProgressUI : MonoBehaviour
{
    [Header("UI References")]
    [Tooltip("Drag your TextMeshPro - Text (UI) component here")]
    public TextMeshProUGUI progressText;

    // Subscribe to the radio broadcast when this object turns on
    void OnEnable()
    {
        LlmService.OnGameDataUpdated += UpdateDisplay;
    }

    // Unsubscribe when it turns off (prevents memory leaks!)
    void OnDisable()
    {
        LlmService.OnGameDataUpdated -= UpdateDisplay;
    }

    void UpdateDisplay(InterviewGameData data)
    {
        if (progressText == null) return;

        // TMP supports rich text tags like <b> and <color> natively!
        string displayString = "<b><color=#FFFFFF>INTERVIEW PROGRESS</color></b>\n\n";

        // Loop through the arrays the Bun server sent us
        for (int i = 0; i < data.allCategories.Length; i++)
        {
            string categoryName = data.allCategories[i];
            int currentScore = data.allScores[i];

            // Add it to our text output. We can even color-code the 100% scores!
            if (currentScore >= 100)
            {
                displayString += $"{categoryName}: <color=#00FF00>{currentScore}%</color>\n";
            }
            else
            {
                displayString += $"{categoryName}: {currentScore}%\n";
            }
        }

        progressText.text = displayString;
    }
}