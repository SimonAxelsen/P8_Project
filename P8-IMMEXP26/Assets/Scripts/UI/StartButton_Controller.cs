using UnityEngine;

/// <summary>
/// Attach to your Start Button.
/// Hides the start screen UI and activates the document,
/// which triggers Application_Viewer's built-in scale-in intro automatically.
/// </summary>
public class StartButton_Controller : MonoBehaviour
{
    [Header("References")]
    [Tooltip("The document GameObject with Application_Viewer attached")]
    public GameObject documentObject;

    [Tooltip("The start screen UI elements to hide (e.g. a parent Canvas or panel)")]
    public GameObject startScreenUI;

    [Tooltip("The canvas containing the Begin Interview button — starts inactive")]
    public GameObject beginInterviewCanvas;

    // Called by the Button's OnClick() event in the Inspector
    public void OnStartPressed()
    {
        if (startScreenUI != null)
            startScreenUI.SetActive(false);

        if (documentObject != null)
            documentObject.SetActive(true); // Application_Viewer.Start() fires here → scale-in plays

        if (beginInterviewCanvas != null)
            beginInterviewCanvas.SetActive(true);
    }
}