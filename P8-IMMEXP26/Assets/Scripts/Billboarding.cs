using UnityEngine;

public class Billboarding : MonoBehaviour
{
    private Transform mainCameraTransform;
    
    [Tooltip("Keep checked for VR! Keeps the text upright instead of tilting up and down.")]
    public bool keepUpright = true; 

    void Start()
    {
        // Grab the VR camera's transform automatically
        if (Camera.main != null)
        {
            mainCameraTransform = Camera.main.transform;
        }
        else
        {
            Debug.LogWarning("Billboarding script couldn't find a camera tagged as 'MainCamera'.");
        }
    }

    void LateUpdate()
    {
        // Do nothing if there's no camera
        if (mainCameraTransform == null) return;

        // Find the direction pointing from the text to the camera
        Vector3 directionToCamera = mainCameraTransform.position - transform.position;

        // If keepUpright is checked, ignore the vertical height difference
        if (keepUpright)
        {
            directionToCamera.y = 0;
        }

        // Look at the camera! 
        // (We use a minus sign so the 3D text doesn't appear mirrored/backwards)
        if (directionToCamera != Vector3.zero)
        {
            transform.rotation = Quaternion.LookRotation(-directionToCamera);
        }
    }
}