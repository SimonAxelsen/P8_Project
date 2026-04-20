using UnityEngine;
using UnityEngine.UI;

public class MicIndicator : MonoBehaviour
{
    public Image circle;
    private bool active = false;

    public void Toggle()
    {
        active = !active;
        circle.color = active ? Color.green : Color.gray;
    }
}