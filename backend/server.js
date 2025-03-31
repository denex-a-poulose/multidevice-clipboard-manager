const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, limit this to your actual domains
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["*"],
  },
  // Allow much larger payloads for clipboard data
  maxHttpBufferSize: 10e6, // 10 MB
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Store clipboard data and active connections
const sessions = {};
const activeConnections = {};

// Debug connection issues
io.engine.on("connection_error", (err) => {
  console.error(
    "Connection error:",
    err.req?.url,
    err.code,
    err.message,
    err.context
  );
});

const generateSessionCode = () => {
  // Generate a more readable 6-character code
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Removed similar-looking characters
  let code = "";

  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    code += characters[randomIndex];
  }

  // Check if code already exists and regenerate if needed
  return sessions[code] ? generateSessionCode() : code;
};

// Endpoint to get a new session code
app.get("/new-session", (req, res) => {
  const sessionCode = generateSessionCode();
  sessions[sessionCode] = {
    text: "",
    history: [], // Store clipboard history
    createdAt: new Date(),
    lastActivity: new Date(),
  };

  // Initialize connection tracking
  activeConnections[sessionCode] = new Set();

  console.log(`New session created: ${sessionCode}`);
  res.json({ sessionCode });
});

// Check if session exists
app.get("/check-session/:code", (req, res) => {
  const { code } = req.params;
  const sessionExists = !!sessions[code];

  res.json({
    exists: sessionExists,
    connections: sessionExists ? activeConnections[code]?.size || 0 : 0,
  });
});

// Debug endpoint to list all sessions
app.get("/debug/sessions", (req, res) => {
  const sessionInfo = {};
  Object.keys(sessions).forEach((code) => {
    sessionInfo[code] = {
      lastActivity: sessions[code].lastActivity,
      connections: activeConnections[code]?.size || 0,
    };
  });

  res.json(sessionInfo);
});

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);
  let currentSession = null;

  // Send immediate connection confirmation
  socket.emit("connected", { socketId: socket.id });

  // Join a specific session
  socket.on("join-session", (sessionCode) => {
    console.log(`Socket ${socket.id} joining session ${sessionCode}`);

    if (!sessions[sessionCode]) {
      console.log(`Invalid session: ${sessionCode}`);
      socket.emit("error", "Invalid session code");
      return;
    }

    // Leave any previous sessions this socket was in
    Object.keys(socket.rooms).forEach((room) => {
      if (room !== socket.id) {
        // Track which session we're leaving
        const oldSession = room;
        console.log(`Leaving session ${oldSession}`);

        socket.leave(oldSession);

        // Remove from active connections tracking
        if (activeConnections[oldSession]) {
          activeConnections[oldSession].delete(socket.id);

          // Update all clients in that session about connection count
          io.to(oldSession).emit("session-update", {
            connections: activeConnections[oldSession].size,
          });
        }
      }
    });

    // Join new session
    socket.join(sessionCode);
    currentSession = sessionCode;

    // Track connection in session
    if (!activeConnections[sessionCode]) {
      activeConnections[sessionCode] = new Set();
    }
    activeConnections[sessionCode].add(socket.id);

    // Update session activity timestamp
    sessions[sessionCode].lastActivity = new Date();

    // Send most recent clipboard text to the new member if it exists
    if (sessions[sessionCode].text) {
      socket.emit("paste-text", sessions[sessionCode].text);
    }

    // Notify all clients in the session about the number of connections
    const connectionCount = activeConnections[sessionCode].size;
    io.to(sessionCode).emit("session-update", {
      connections: connectionCount,
    });

    console.log(
      `Session ${sessionCode} now has ${connectionCount} connections`
    );
  });

  // Copy text to all devices in the session
  socket.on("copy-text", ({ sessionCode, text }) => {
    // Prevent empty text from being processed
    if (!text || text.trim() === "") {
      return;
    }

    console.log(
      `Received text from ${socket.id} for session ${sessionCode} (${
        text.length
      } chars): "${text?.substring(0, 30)}${text.length > 30 ? "..." : ""}"`
    );

    if (!sessions[sessionCode]) {
      console.log(`Session ${sessionCode} not found!`);
      socket.emit("error", "Invalid session code");
      return;
    }

    // Check who's in this room
    const room = io.sockets.adapter.rooms.get(sessionCode);
    console.log(`Room ${sessionCode} has ${room ? room.size : 0} members`);

    // Don't process if it's the exact same text as before
    if (sessions[sessionCode].text === text) {
      console.log(`Same text as current, ignoring`);
      return;
    }

    // Store the text in session
    sessions[sessionCode].text = text;

    // Add to history (limit to 10 items)
    if (!sessions[sessionCode].history) {
      sessions[sessionCode].history = [];
    }

    // Only add to history if it's not a duplicate of the most recent item
    if (
      sessions[sessionCode].history.length === 0 ||
      sessions[sessionCode].history[0] !== text
    ) {
      sessions[sessionCode].history.unshift(text);
      if (sessions[sessionCode].history.length > 10) {
        sessions[sessionCode].history.pop();
      }
    }

    sessions[sessionCode].lastActivity = new Date();

    // Broadcast to all devices in the session EXCEPT the sender
    socket.to(sessionCode).emit("paste-text", text);
    console.log(
      `Text broadcast to ${
        room ? room.size - 1 : 0
      } devices in session ${sessionCode}`
    );
  });

  // Get clipboard history for a session
  socket.on("get-history", ({ sessionCode }, callback) => {
    if (!sessions[sessionCode]) {
      callback({ error: "Invalid session code" });
      return;
    }

    callback({
      history: sessions[sessionCode].history || [],
    });
  });

  // Debugging tool
  socket.on("debug-info", (callback) => {
    const roomInfo = {};

    // Get all rooms this socket is in
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        roomInfo[room] = {
          members: io.sockets.adapter.rooms.get(room)?.size || 0,
        };
      }
    }

    callback({
      socketId: socket.id,
      connected: socket.connected,
      rooms: roomInfo,
    });
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);

    // Remove this connection from all sessions it was part of
    Object.keys(activeConnections).forEach((sessionCode) => {
      if (
        activeConnections[sessionCode] &&
        activeConnections[sessionCode].has(socket.id)
      ) {
        activeConnections[sessionCode].delete(socket.id);

        // Update remaining clients about connection count
        const remainingConnections = activeConnections[sessionCode].size;
        io.to(sessionCode).emit("session-update", {
          connections: remainingConnections,
        });

        console.log(
          `Session ${sessionCode} now has ${remainingConnections} connections`
        );
      }
    });
  });
});

// Clean up inactive sessions periodically (e.g., once per hour)
setInterval(() => {
  const now = new Date();
  const sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  Object.keys(sessions).forEach((sessionCode) => {
    const session = sessions[sessionCode];
    const timeSinceLastActivity = now - session.lastActivity;

    if (timeSinceLastActivity > sessionTimeout) {
      console.log(`Cleaning up inactive session: ${sessionCode}`);
      delete sessions[sessionCode];
      delete activeConnections[sessionCode];
    }
  });
}, 60 * 60 * 1000); // Run every hour

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server URL: http://localhost:${PORT}`);
});
