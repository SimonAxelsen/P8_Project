using System.Collections;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using UnityEngine.InputSystem;

public class BlackScreenIntro : MonoBehaviour
{
    [Header("References")]
    public Image image;
    public AudioClip audioClip;

    [Header("Settings")]
    public float sceneTransitionDelay = 1.5f;
    public float fadeInDuration = 1f;
    public string nextScene = "";

    private bool started = false;

    void Start()
    {
        if (image != null)
            image.gameObject.SetActive(false);
    }

    void Update()
    {
        if (Keyboard.current.spaceKey.wasPressedThisFrame && !started)
        {
            started = true;
            StartCoroutine(PlayAndFade());
        }
    }

    IEnumerator PlayAndFade()
    {
        if (image != null)
        {
            image.gameObject.SetActive(true);
            
            yield return StartCoroutine(FadeInImage());
        }

        if (audioClip != null)
        {
            AudioSource audioSource = GetComponent<AudioSource>();
            if (audioSource == null)
                audioSource = gameObject.AddComponent<AudioSource>();
            
            audioSource.clip = audioClip;
            audioSource.Play();

            yield return new WaitForSeconds(audioClip.length);
        }

        yield return new WaitForSeconds(sceneTransitionDelay);

        if (!string.IsNullOrEmpty(nextScene))
            SceneManager.LoadScene(nextScene);
    }

    IEnumerator FadeInImage()
    {
        if (image == null)
            yield break;

        Color color = image.color;
        color.a = 0f;
        image.color = color;

        float elapsedTime = 0f;
        while (elapsedTime < fadeInDuration)
        {
            elapsedTime += Time.deltaTime;
            color.a = Mathf.Clamp01(elapsedTime / fadeInDuration);
            image.color = color;
            yield return null;
        }

        color.a = 1f;
        image.color = color;
    }

}