using UnityEngine;
using System.Threading.Tasks;
using NativeWebSocket;

public class WebSocketTest : MonoBehaviour
{
    private WebSocket websocket;
    //backend url
    public string serverUrl = "ws://10.67.104.236:3000";
    
    private async void Start()
    {
        websocket = new WebSocket(serverUrl);

        websocket.OnOpen += () => Debug.Log("WebSocket Connected!");
        websocket.OnError += (e) => Debug.LogError($"WebSocket Error: {e}");
        websocket.OnClose += (e) => Debug.Log($"WebSocket Closed: {e}");
        websocket.OnMessage += (bytes) =>
        {
            string message = System.Text.Encoding.UTF8.GetString(bytes);
            Debug.Log($"Received: {message}");
        };

        await websocket.Connect();
    }

    private void Update()
    {
        #if !UNITY_WEBGL || UNITY_EDITOR
        websocket?.DispatchMessageQueue();
        #endif

        if (Input.GetKeyDown(KeyCode.T))
        {
            if (websocket.State == WebSocketState.Open)
            {
                websocket.SendText("Hello from Unity");
            }
        }
    }

    private async void OnApplicationQuit()
    {
        await websocket?.Close();
    }
}
