using System.Collections;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;

public class BlackScreenIntro : MonoBehaviour
{
    [Header("References")]
    public Image blackPanel;         // The black UI Image
    public AudioSource audioSource;  // AudioSource with your voice clip

    [Header("Settings")]
    public float delayAfterClip = 0.5f;   // pause after clip ends before fade
    public float fadeDuration = 1.5f;      // how long the fade-out takes
    public string nextScene = "";          // leave empty to just fade and stop

    void Start()
    {
        // Make sure panel is fully black/opaque
        SetAlpha(1f);
        StartCoroutine(PlayAndFade());
    }

    IEnumerator PlayAndFade()
    {
        // Play the voice clip once
        audioSource.Play();

        // Wait for the clip to finish
        yield return new WaitForSeconds(audioSource.clip.length);

        // Small pause after clip
        yield return new WaitForSeconds(delayAfterClip);

        // Fade out the black panel
        float elapsed = 0f;
        while (elapsed < fadeDuration)
        {
            elapsed += Time.deltaTime;
            float alpha = Mathf.Lerp(1f, 0f, elapsed / fadeDuration);
            SetAlpha(alpha);
            yield return null;
        }

        SetAlpha(0f);

        // Optional: load next scene
        if (!string.IsNullOrEmpty(nextScene))
            SceneManager.LoadScene(nextScene);
    }

    void SetAlpha(float alpha)
    {
        Color c = blackPanel.color;
        c.a = alpha;
        blackPanel.color = c;
    }
}