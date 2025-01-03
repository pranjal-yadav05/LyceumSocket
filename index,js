import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

const rooms = new Map();
const roomMessages = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userId, username, mediaState }) => {
    if (!roomId || !userId || !username) {
      console.error('Invalid roomId, userId or username');
      return;
    }

    if (rooms.has(roomId)) {
      const existingUser = Array.from(rooms.get(roomId).entries()).find(([_, user]) => user.username === username);
      if (existingUser) {
        const [existingUserId, _] = existingUser;
        rooms.get(roomId).delete(existingUserId);
        socket.to(roomId).emit('user-disconnected', { userId: existingUserId, username });
      }
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    rooms.get(roomId).set(userId, { username, mediaState, socketId: socket.id });

    socket.join(roomId);
    console.log(`User ${username} (ID: ${userId}) joined room: ${roomId}`);

    socket.to(roomId).emit('user-connected', { userId, username, mediaState });

    const usersInRoom = Array.from(rooms.get(roomId), ([id, data]) => ({
      userId: id,
      username: data.username,
      mediaState: data.mediaState
    }));
    socket.emit('room-users', usersInRoom);

    if (roomMessages.has(roomId)) {
      socket.emit('room-messages', roomMessages.get(roomId));
    }
  });

  socket.on('media-state-changed', ({ roomId, userId, mediaState }) => {
    if (rooms.has(roomId) && rooms.get(roomId).has(userId)) {
      rooms.get(roomId).get(userId).mediaState = mediaState;
      socket.to(roomId).emit('media-state-changed', { userId, mediaState });
    }
  });

  socket.on('send-message', ({ roomId, userId, username, message }) => {
    const messageData = { userId, username, message, timestamp: Date.now() };
    
    if (!roomMessages.has(roomId)) {
      roomMessages.set(roomId, []);
    }
    roomMessages.get(roomId).push(messageData);

    if (roomMessages.get(roomId).length > 100) {
      roomMessages.get(roomId).shift();
    }

    io.to(roomId).emit('receive-message', messageData);
  });

  socket.on('disconnect', () => {
    rooms.forEach((users, roomId) => {
      users.forEach((user, userId) => {
        if (socket.id === user.socketId) {
          console.log(`User ${user.username} (ID: ${userId}) disconnected from room ${roomId}`);
          users.delete(userId);
          socket.to(roomId).emit('user-disconnected', { userId, username: user.username });

          if (users.size === 0) {
            roomMessages.delete(roomId);
            rooms.delete(roomId);
          }
        }
      });
    });
  });
});

const PORT = process.env.PORT || 5001;
httpServer.listen(PORT, () => console.log(`Socket.IO server running on port ${PORT}`));

