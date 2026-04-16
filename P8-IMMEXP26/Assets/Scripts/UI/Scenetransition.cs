using System.Collections;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

/// <summary>
/// Attach this to a persistent GameObject in the scene (e.g. a TransitionManager).
/// 
/// Setup:
///   1. Create a UI Canvas (Screen Space - Overlay, sort order high e.g. 10).
///   2. Add a full-screen Image child to it, color black, alpha 0. 
///   3. Assign that Image to the fadeImage field below.
///   4. Hook your "Begin Interview" button's OnClick() to this script's BeginInterview() method.
/// </summary>
public class Scenetransition : MonoBehaviour
{
    [Header("References")]
    [Tooltip("Full-screen black UI Image used for the fade overlay")]
    public Image fadeImage;

    [Header("Settings")]
    [Tooltip("How long the fade to black takes in seconds")]
    public float fadeDuration = 0.8f;

    void Awake()
    {
        // Make sure the overlay starts fully transparent
        if (fadeImage != null)
        {
            Color c = fadeImage.color;
            c.a = 0f;
            fadeImage.color = c;
            fadeImage.raycastTarget = false; // don't block clicks while invisible
        }
    }

    public void BeginInterview()
{
    // 1. Ask Unity for the name of the scene we are currently in
    string scenename = SceneManager.GetActiveScene().name;

    // 2. Check if it is NOT "Corescene"
    if (scenename != "Corescene")
    {
        StartCoroutine(FadeAndLoad());
    }
}

    IEnumerator FadeAndLoad()
    {
        // Block input during transition
        fadeImage.raycastTarget = true;

        // Fade overlay from transparent → opaque
        float elapsed = 0f;
        while (elapsed < fadeDuration)
        {
            elapsed += Time.deltaTime;
            float alpha = Mathf.Clamp01(elapsed / fadeDuration);
            SetFadeAlpha(alpha);
            yield return null;
        }

        SetFadeAlpha(1f);

        // Load the next scene by build index
        int nextIndex = SceneManager.GetActiveScene().buildIndex + 1;
        SceneManager.LoadScene(nextIndex);
    }

    void SetFadeAlpha(float alpha)
    {
        if (fadeImage == null) return;
        Color c = fadeImage.color;
        c.a = alpha;
        fadeImage.color = c;
    }
}