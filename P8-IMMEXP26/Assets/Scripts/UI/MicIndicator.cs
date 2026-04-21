using UnityEngine;
using UnityEngine.UI;

public class MicIndicator : MonoBehaviour
{
    public Image image;
    private bool active = false;

    public void Toggle()
    {
        active = !active;
        image.enabled = active;
    }
}