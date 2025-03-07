import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';

dotenv.config();

// Express setup
const app = express();
const httpServer = createServer(app);

// Socket.IO setup with combined config
const io = new Server(httpServer, {
  cors: {
    origin: [
      process.env.FRONTEND_URL,
      process.env.BACKEND_URL,
      process.env.CLIENT_URL || "http://localhost:3000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true,
  pingTimeout: 180000, // Using the longer timeout from the first file
  pingInterval: 10000,
  connectTimeout: 60000
});

// User tracking data structures
const onlineUsers = new Map();
const rooms = new Map();
const roomMessages = new Map();

// Function to clean up inactive users
const cleanupInactiveUsers = () => {
  const now = Date.now();
  const inactivityThreshold = 360000; // 6 minutes

  for (const [userId, userData] of onlineUsers.entries()) {
    if (now - userData.lastActivity > inactivityThreshold) {
      const lastSeen = new Date();
      onlineUsers.delete(userId);
      io.emit("user_status", { userId, status: "offline", lastSeen });
    }
  }
};

setInterval(cleanupInactiveUsers, 300000); // Run every 5 minutes

// Authentication middleware
io.use(async (socket, next) => {
  try {
    // Check if token exists in handshake auth
    const token = socket.handshake.auth.token;
    
    if (token) {
      // Verify JWT token
      const decoded = await new Promise((resolve, reject) => {
        jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
          if (err) reject(new Error("Authentication error: Invalid token"));
          else resolve(decoded);
        });
      });
      
      socket.user = decoded;
    } else {
      // If no token, use socket ID as user ID for room functionality
      // This allows the room functionality to work without authentication
      socket.user = { id: socket.id };
    }
    
    next();
  } catch (error) {
    // If JWT verification fails but we want to allow unauthenticated connections for room service
    socket.user = { id: socket.id };
    next();
  }
});

// Connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.user.id);
  
  // User Status Management Functions
  const updateUserStatus = (userId, status) => {
    try {
      if (status === "online") {
        onlineUsers.set(userId, {
          socketId: socket.id,
          lastActivity: Date.now(),
          lastSeen: new Date(),
        });
      } else {
        const userData = onlineUsers.get(userId);
        const lastSeen = new Date();
        if (userData) {
          userData.lastSeen = lastSeen;
        }
        onlineUsers.delete(userId);
      }

      // Broadcast the status change to all connected clients
      io.emit("user_status", {
        userId,
        status,
        lastSeen: status === "offline" ? new Date() : null,
      });
    } catch (error) {
      console.error("Error updating user status:", error);
    }
  };
  
  // Set initial user status if authenticated
  if (socket.user && socket.user.id && socket.handshake.auth.token) {
    updateUserStatus(socket.user.id, "online");
  }
  
  // --- Chat & Status Events ---
  
  // Handle client-side status update
  socket.on("update_status", ({ status }) => {
    updateUserStatus(socket.user.id, status);
  });

  // Handle status request for specific user
  socket.on("get_user_status", (userId, callback) => {
    try {
      const userData = onlineUsers.get(userId);
      const status = userData ? "online" : "offline";
      const lastSeen = userData?.lastSeen || null;

      if (typeof callback === "function") {
        callback({ status, lastSeen });
      }
    } catch (error) {
      console.error("Error getting user status:", error);
      if (typeof callback === "function") {
        callback({ status: "offline", lastSeen: null });
      }
    }
  });

  // Handle request for all online users
  socket.on("get_online_users", (callback) => {
    try {
      const onlineUsersList = Array.from(onlineUsers.keys());
      if (typeof callback === "function") {
        callback({ users: onlineUsersList });
      }
    } catch (error) {
      console.error("Error getting online users:", error);
      if (typeof callback === "function") {
        callback({ users: [] });
      }
    }
  });

  // Heartbeat to keep user active
  socket.on("heartbeat", (callback) => {
    try {
      const userData = onlineUsers.get(socket.user.id);
      if (userData) {
        userData.lastActivity = Date.now();
        if (typeof callback === "function") {
          callback({ status: "ok", timestamp: Date.now() });
        }
      }
    } catch (error) {
      console.error("Heartbeat error:", error);
    }
  });

  // New direct message event
  socket.on("new_message", async (message, callback) => {
    console.log("Received new_message event:", message);
    try {
      if (!message || typeof message !== "object") {
        throw new Error("Invalid message format");
      }
  
      const { sender, recipient, content } = message;
  
      if (!sender || !recipient || !content) {
        throw new Error("Missing required message properties");
      }
  
      // Broadcast to all sockets in the room or to specific users
      io.sockets.emit("receive_message", message);
  
      // Send confirmation back to sender
      if (typeof callback === "function") {
        callback({ status: "success" });
      }
  
    } catch (error) {
      console.error("Error handling new message:", error);
      if (typeof callback === "function") {
        callback({ status: "error", error: error.message });
      }
    }
  });

  // Message received confirmation
  socket.on("message_received", (messageId) => {
    console.log(`Message ${messageId} received by client`);
  });

  // Connection check
  socket.on("check_connection", (callback) => {
    if (typeof callback === "function") {
      callback({
        status: "connected",
        userId: socket.user.id,
        isOnline: true,
        timestamp: Date.now(),
      });
    }
  });
  
  // --- Room Management Events ---
  
  // Join room event
  socket.on('join-room', ({ roomId, userId, username, mediaState }) => {
    if (!roomId || !userId || !username) {
      console.error('Invalid roomId, userId or username');
      return;
    }
    
    // Handle case where user with same username exists in room
    if (rooms.has(roomId)) {
      const existingUser = Array.from(rooms.get(roomId).entries()).find(([_, user]) => user.username === username);
      if (existingUser) {
        const [existingUserId, _] = existingUser;
        rooms.get(roomId).delete(existingUserId);
        socket.to(roomId).emit('user-disconnected', { userId: existingUserId, username });
      }
    }
    
    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    
    // Add user to room
    rooms.get(roomId).set(userId, { username, mediaState, socketId: socket.id });
    
    socket.join(roomId);
    console.log(`Rooms size after join: ${rooms.size}`);
    console.log(`User ${username} (ID: ${userId}) joined room: ${roomId}`);
    
    // Notify other users in the room
    socket.to(roomId).emit('user-connected', { userId, username, mediaState });
    
    // Send list of users in room to the new user
    const usersInRoom = Array.from(rooms.get(roomId), ([id, data]) => ({
      userId: id,
      username: data.username,
      mediaState: data.mediaState
    }));
    socket.emit('room-users', usersInRoom);
    
    // Send room messages history
    if (roomMessages.has(roomId)) {
      socket.emit('room-messages', roomMessages.get(roomId));
    }
  });
  
  // Media state change (video/audio toggle)
  socket.on('media-state-changed', ({ roomId, userId, mediaState }) => {
    if (rooms.has(roomId) && rooms.get(roomId).has(userId)) {
      rooms.get(roomId).get(userId).mediaState = mediaState;
      socket.to(roomId).emit('media-state-changed', { userId, mediaState });
    }
  });
  
  // Room chat message
  socket.on('send-message', ({ roomId, userId, username, message }) => {
    const messageData = { userId, username, message, timestamp: Date.now() };
    
    if (!roomMessages.has(roomId)) {
      roomMessages.set(roomId, []);
    }
    roomMessages.get(roomId).push(messageData);
    
    // Limit message history to 100 messages
    if (roomMessages.get(roomId).length > 100) {
      roomMessages.get(roomId).shift();
    }
    
    io.to(roomId).emit('receive-message', messageData);
  });
  
  // Disconnect handler
  socket.on('disconnect', (reason) => {
    console.log("User disconnected:", socket.user.id, "Reason:", reason);
    
    // Update user status if authenticated
    if (socket.user && socket.user.id && socket.handshake.auth.token) {
      updateUserStatus(socket.user.id, "offline");
    }
    
    // Clean up room membership
    rooms.forEach((users, roomId) => {
      users.forEach((user, userId) => {
        if (socket.id === user.socketId) {
          console.log(`User ${user.username} (ID: ${userId}) disconnected from room ${roomId}`);
          users.delete(userId);
          socket.to(roomId).emit('user-disconnected', { userId, username: user.username });
          
          // Clean up empty rooms
          if (users.size === 0) {
            roomMessages.delete(roomId);
            rooms.delete(roomId);
          }
        }
      });
    });
  });
});

// REST endpoint for active rooms
app.get('/active-rooms', (req, res) => {
  const activeRooms = rooms.size;
  res.json({ activeRooms });
});

// Start server
const PORT = process.env.PORT || process.env.SOCKET_PORT || 5001;
httpServer.listen(PORT, () => console.log(`Socket.IO server running on port ${PORT}`));