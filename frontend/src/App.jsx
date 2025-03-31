import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import axios from "axios";

function App() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinedSession, setJoinedSession] = useState(false);
  const [clipboardHistory, setClipboardHistory] = useState([]);
  const [socket, setSocket] = useState(null);
  const [error, setError] = useState("");
  const [connectedDevices, setConnectedDevices] = useState(0);
  const [lastActivity, setLastActivity] = useState("");
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [autoReceive, setAutoReceive] = useState(true);
  const [manualText, setManualText] = useState("");
  const [isClipboardSupported, setIsClipboardSupported] = useState(true);
  const monitoringInterval = useRef(null);

  // Server URL - REPLACE WITH YOUR ACTUAL SERVER IP
  const SERVER_URL = "http://{IP}:5000";

  // Check clipboard API support on component mount
  useEffect(() => {
    // Check if clipboard reading is supported
    const checkClipboardSupport = async () => {
      try {
        // First check if the Clipboard API exists
        if (!navigator.clipboard) {
          setIsClipboardSupported(false);
          return;
        }

        // Next, try to access readText (this will trigger permission request on desktop)
        // This might fail on mobile even if clipboard API exists
        if (navigator.clipboard.readText) {
          try {
            await navigator.clipboard.readText();
            setIsClipboardSupported(true);
          } catch (err) {
            // If permission denied or other error on desktop
            if (!/mobile|android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
              setIsClipboardSupported(true); // Still mark as supported on desktop for retry
            } else {
              setIsClipboardSupported(false); // Mark as unsupported on mobile
            }
          }
        } else {
          setIsClipboardSupported(false);
        }
      } catch (err) {
        console.error("Error checking clipboard support:", err);
        setIsClipboardSupported(false);
      }
    };

    checkClipboardSupport();
  }, []);

  // Initialize socket connection once on component mount
  useEffect(() => {
    console.log("Initializing socket connection to:", SERVER_URL);

    // Force WebSocket transport for more reliable connections
    const newSocket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    newSocket.on("connect", () => {
      console.log("✅ Connected to server with ID:", newSocket.id);
      setError("");
    });

    newSocket.on("disconnect", () => {
      console.log("❌ Disconnected from server");
      setJoinedSession(false);
      setIsMonitoring(false);
      stopClipboardMonitoring();
      setError("Disconnected from server. Trying to reconnect...");
    });

    newSocket.on("connect_error", (err) => {
      console.error("❌ Connection error:", err.message);
      setError(`Failed to connect to server (${err.message}). Check your network.`);
    });

    setSocket(newSocket);

    return () => {
      console.log("Cleaning up socket connection");
      stopClipboardMonitoring();
      newSocket.disconnect();
    };
  }, []);

  // Get a new session-code when the app loads
  useEffect(() => {
    if (socket && socket.connected) {
      console.log("Requesting new session code from server");

      axios.get(`${SERVER_URL}/new-session`)
        .then((res) => {
          console.log("✅ Received session code:", res.data.sessionCode);
          setSessionCode(res.data.sessionCode);
        })
        .catch((err) => {
          console.error("❌ Error getting session code:", err);
          setError("Couldn't get a session code. Server might be down.");
        });
    }
  }, [socket]);

  // Setup socket listeners
  useEffect(() => {
    if (!socket) return;

    const handlePaste = (receivedText) => {
      console.log("📥 Received text from server:", receivedText?.substring(0, 30) + (receivedText?.length > 30 ? "..." : ""));

      // Add to clipboard history
      setClipboardHistory(prev => [receivedText, ...prev.slice(0, 9)]);

      setLastActivity("Received text at " + new Date().toLocaleTimeString());

      // Visual feedback to show text was received
      const historyContainer = document.querySelector(".clipboard-history");
      if (historyContainer) {
        historyContainer.firstChild.style.backgroundColor = "#f0fff0";
        setTimeout(() => {
          if (historyContainer.firstChild) {
            historyContainer.firstChild.style.backgroundColor = "";
          }
        }, 500);
      }

      // Copy to clipboard automatically if autoReceive is enabled
      if (autoReceive) {
        navigator.clipboard.writeText(receivedText)
          .then(() => console.log("✅ Text copied to clipboard"))
          .catch(err => console.error("❌ Failed to copy to clipboard:", err));
      }
    };

    const handleError = (errorMsg) => {
      console.error("❌ Server error:", errorMsg);
      setError(errorMsg);
    };

    const handleSessionUpdate = (update) => {
      console.log("📊 Session update:", update);
      setConnectedDevices(update.connections);
    };

    socket.on("paste-text", handlePaste);
    socket.on("error", handleError);
    socket.on("session-update", handleSessionUpdate);

    return () => {
      socket.off("paste-text", handlePaste);
      socket.off("error", handleError);
      socket.off("session-update", handleSessionUpdate);
    };
  }, [socket, autoReceive]);

  // Start clipboard monitoring
  const startClipboardMonitoring = () => {
    if (!isClipboardSupported) {
      setError("Your browser doesn't support clipboard monitoring. Use the manual input below instead.");
      return false;
    }

    let lastClipboardContent = "";

    // Request clipboard permission by reading once
    navigator.clipboard.readText()
      .then(text => {
        console.log("✅ Clipboard permission granted");
        lastClipboardContent = text;

        // Set up polling interval to check for clipboard changes
        monitoringInterval.current = setInterval(() => {
          // Only check if document is focused to avoid excessive permission requests
          if (document.hasFocus()) {
            navigator.clipboard.readText()
              .then(currentText => {
                if (currentText !== lastClipboardContent && currentText.trim() !== "") {
                  console.log("📋 Clipboard content changed");
                  lastClipboardContent = currentText;

                  // Send to server
                  if (socket && joinedSession) {
                    socket.emit("copy-text", { sessionCode, text: currentText });
                    setLastActivity("Detected and sent clipboard content at " + new Date().toLocaleTimeString());
                  }
                }
              })
              .catch(err => {
                console.error("❌ Failed to read clipboard:", err);
                // Don't stop monitoring on occasional errors
              });
          }
        }, 1000); // Check every second

        return true;
      })
      .catch(err => {
        console.error("❌ Clipboard permission denied:", err);
        setError("Please allow clipboard access to enable monitoring");
        return false;
      });

    return true;
  };

  // Stop clipboard monitoring
  const stopClipboardMonitoring = () => {
    if (monitoringInterval.current) {
      clearInterval(monitoringInterval.current);
      monitoringInterval.current = null;
    }
  };

  const toggleClipboardMonitoring = () => {
    if (isMonitoring) {
      stopClipboardMonitoring();
      setIsMonitoring(false);
    } else {
      const success = startClipboardMonitoring();
      if (success) {
        setIsMonitoring(true);
        setError("");
      }
    }
  };

  const joinSession = () => {
    if (!socket || !sessionCode) {
      setError("Socket not connected or session code missing");
      return;
    }

    console.log("📥 Joining session:", sessionCode);
    setError("");
    socket.emit("join-session", sessionCode);
    setJoinedSession(true);
    setLastActivity("Joined session at " + new Date().toLocaleTimeString());
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        console.log("✅ Text copied to clipboard");
        setLastActivity("Copied to clipboard at " + new Date().toLocaleTimeString());
      })
      .catch(err => {
        console.error("❌ Failed to copy to clipboard:", err);
        setError("Failed to copy to clipboard. Please try manually.");
      });
  };

  const sendManualText = () => {
    if (!socket || !sessionCode || !joinedSession) {
      setError("Please join a session first");
      return;
    }

    if (!manualText.trim()) {
      setError("Please enter text to send");
      return;
    }

    console.log("📤 Sending text to server:", manualText.substring(0, 30) + (manualText.length > 30 ? "..." : ""));
    setError("");
    socket.emit("copy-text", { sessionCode, text: manualText });
    setLastActivity("Sent text at " + new Date().toLocaleTimeString());
  };

  const generateNewSession = () => {
    axios.get(`${SERVER_URL}/new-session`)
      .then((res) => {
        console.log("✅ Generated new session code:", res.data.sessionCode);
        setSessionCode(res.data.sessionCode);
        setJoinedSession(false);
        setError("");
      })
      .catch((err) => {
        console.error("❌ Error generating session:", err);
        setError("Couldn't generate a new session");
      });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <h1 className="text-2xl font-bold mb-6">Cross-Device Clipboard Sync</h1>

      <div className="bg-white p-6 rounded-lg shadow-md w-full max-w-md">
        <div className="mb-6">
          <p className="text-sm mb-2">Your Session Code:</p>
          <div className="flex mb-4">
            <input
              type="text"
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value.toUpperCase())}
              className="p-2 border rounded w-full text-center text-lg font-mono"
              placeholder="Enter Session Code"
            />
            <button
              onClick={generateNewSession}
              className="ml-2 p-2 bg-gray-200 rounded hover:bg-gray-300"
              title="Generate New Code"
            >
              ↻
            </button>
          </div>

          <button
            onClick={joinSession}
            disabled={joinedSession}
            className={`w-full p-2 rounded ${joinedSession
              ? "bg-green-200 text-green-800"
              : "bg-blue-500 text-white hover:bg-blue-600"
              }`}
          >
            {joinedSession ? "Connected to Session" : "Join Session"}
          </button>

          {connectedDevices > 0 && (
            <p className="mt-2 text-sm text-green-600">
              {connectedDevices} device{connectedDevices !== 1 ? 's' : ''} connected
            </p>
          )}
        </div>

        {joinedSession && isClipboardSupported && (
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <button
                onClick={toggleClipboardMonitoring}
                className={`px-4 py-2 rounded ${isMonitoring
                  ? "bg-red-500 text-white hover:bg-red-600"
                  : "bg-green-500 text-white hover:bg-green-600"
                  }`}
              >
                {isMonitoring ? "Stop Monitoring" : "Start Clipboard Monitoring"}
              </button>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="autoReceive"
                  checked={autoReceive}
                  onChange={(e) => setAutoReceive(e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="autoReceive" className="text-sm">Auto-copy received text</label>
              </div>
            </div>

            {isMonitoring ? (
              <p className="text-sm text-green-600">
                Clipboard monitoring active! Copy text normally on this device, and it will be sent automatically.
              </p>
            ) : (
              <p className="text-sm text-gray-600">
                Start clipboard monitoring to automatically sync your clipboard to other devices.
              </p>
            )}
          </div>
        )}

        {joinedSession && !isClipboardSupported && (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <p className="text-sm text-yellow-700">
              <strong>Note:</strong> Automatic clipboard monitoring is not supported on this device.
              Use the manual input below to share text instead.
            </p>
          </div>
        )}

        <div className="mb-4">
          <p className="text-sm mb-2">Clipboard History:</p>
          <div className="clipboard-history max-h-60 overflow-y-auto">
            {clipboardHistory.length > 0 ? (
              clipboardHistory.map((item, index) => (
                <div
                  key={index}
                  className="p-2 border rounded mb-2 cursor-pointer hover:bg-gray-100"
                  onClick={() => copyToClipboard(item)}
                  title="Click to copy"
                >
                  <div className="text-xs text-gray-500 mb-1">
                    {index === 0 ? "Most recent" : `Item ${index + 1}`}
                  </div>
                  <div className="text-sm font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.length > 60 ? `${item.substring(0, 60)}...` : item}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500 italic">No clipboard history yet</p>
            )}
          </div>
        </div>

        <div className="mb-4">
          <p className="text-sm mb-2">Manual Input:</p>
          <textarea
            className="p-2 border rounded w-full h-20 font-mono"
            placeholder="Type or paste text here to manually share across devices..."
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                sendManualText();
              }
            }}
          ></textarea>
          <button
            onClick={sendManualText}
            disabled={!joinedSession}
            className="w-full mt-2 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500"
          >
            Send Text Manually
          </button>
        </div>

        {lastActivity && (
          <p className="mt-2 text-xs text-gray-500">{lastActivity}</p>
        )}

        {error && (
          <p className="mt-4 text-red-500 text-sm">{error}</p>
        )}
      </div>

      <div className="mt-6 text-sm text-gray-600 max-w-md">
        <p className="font-bold">How to use:</p>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>Enter the same session code on all devices</li>
          <li>Click "Join Session" on each device</li>
          <li>If supported on your device, click "Start Clipboard Monitoring" to enable automatic syncing</li>
          <li>Copy text normally on any device - it will automatically sync where supported</li>
          <li>On mobile or other devices without clipboard access, use the manual input box</li>
          <li>Enable "Auto-copy received text" to automatically update your clipboard</li>
        </ol>

        <p className="mt-4 font-bold">Troubleshooting:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>Clipboard monitoring requires browser permission - allow when prompted</li>
          <li>For security reasons, monitoring only works when the tab is active</li>
          <li>Some browsers (especially mobile browsers) do not support clipboard monitoring</li>
          <li>If automatic syncing isn't working, use the manual text input</li>
        </ul>
      </div>

      <div className="fixed bottom-2 right-2 text-xs text-gray-400">
        {socket?.connected ? "Connected to server" : "Disconnected"}
      </div>
    </div>
  );
}

export default App;