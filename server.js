const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

console.log('Connecting to MySQL with:', {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Shahid123*',
  database: process.env.DB_NAME || 'call-app'
});
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Shahid123*',
  database: process.env.DB_NAME || 'call-app'
});
// Test DB connection on startup
(async () => {
  try {
    await db.query('SELECT 1');
    console.log('MySQL connection successful.');
  } catch (err) {
    console.error('MySQL connection failed:', err);
  }
})();

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// Signup
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Incoming request: ${req.method} ${req.url}`);
  next();
});

app.post('/register', async (req, res) => {
  const { name, email, password, avatar } = req.body;
  if (!(name && email && password)) return res.json({ success: false, message: 'Missing fields' });
  const hash = await bcrypt.hash(password, 10);
  try {
    // Insert user, avatar is optional
    const [result] = await db.query(
      'INSERT INTO users (name, email, password, avatar) VALUES (?, ?, ?, ?)',
      [name, email, hash, avatar || null]
    );
    // Fetch the newly created user
    const [rows] = await db.query('SELECT id, name, email, avatar, created_at FROM users WHERE id = ?', [result.insertId]);
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Register error:', err);
    let msg = 'Server error';
    if (err.code === 'ER_DUP_ENTRY') msg = 'Email already registered';
    res.json({ success: false, message: msg });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.json({ success: false, message: 'User not found' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: 'Incorrect password' });
    // Generate a token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 25000, // 25 seconds
  pingTimeout: 60000,  // 60 seconds
});

// Notification-based WebRTC signaling logic
const connectedClients = {}; // { socketId: { userId, type: 'web' | 'mobile' } }
const activeCalls = {}; // { callId: { webSocketId, mobileSocketId, status } }

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Register client (web or mobile)
  socket.on('register-client', ({ userId, clientType }) => {
    console.log(`[Socket] Registering ${clientType} client for user ${userId}: ${socket.id}`);
    connectedClients[socket.id] = { userId, clientType };
    socket.userId = userId;
    socket.clientType = clientType;
    socket.emit('client-registered', { socketId: socket.id });
  });

  // Initiate call (from web to mobile)
  socket.on('initiate-call', ({ calleeUserId, callId }) => {
    console.log(`[Socket] Call initiation from ${socket.id} to user ${calleeUserId}, callId: ${callId}`);
    
    // Store the call information
    activeCalls[callId] = {
      webSocketId: socket.id,
      mobileSocketId: null,
      calleeUserId,
      status: 'initiated'
    };
    
    socket.callId = callId;
    socket.emit('call-initiated', { callId });
  });

  // Join call (from mobile)
  socket.on('join-call', ({ callId }) => {
    console.log(`[Socket] Mobile client ${socket.id} joining call ${callId}`);
    
    if (activeCalls[callId] && activeCalls[callId].status === 'initiated') {
      activeCalls[callId].mobileSocketId = socket.id;
      activeCalls[callId].status = 'connected';
      socket.callId = callId;
      
      // Notify both parties that they're connected
      const webSocketId = activeCalls[callId].webSocketId;
      
      socket.emit('call-joined', { callId, peerSocketId: webSocketId });
      io.to(webSocketId).emit('callee-joined', { callId, peerSocketId: socket.id });
      
      console.log(`[Socket] Call ${callId} connected: web=${webSocketId}, mobile=${socket.id}`);
    } else {
      socket.emit('call-not-found', { callId });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    
    // Clean up client registration
    delete connectedClients[socket.id];
    
    // Find and clean up any call associated with this socket
    const callId = Object.keys(activeCalls).find(key => 
      activeCalls[key].webSocketId === socket.id || activeCalls[key].mobileSocketId === socket.id
    );

    if (callId) {
      console.log(`[Socket] Call ${callId} hung up by ${socket.id} on disconnect`);
      const call = activeCalls[callId];
      const otherSocketId = socket.id === call.webSocketId ? call.mobileSocketId : call.webSocketId;

      if (otherSocketId) {
        io.to(otherSocketId).emit('peer-left', { callId });
      }
      
      delete activeCalls[callId];
    }
  });

  socket.on('reject-call', ({ callId }) => {
    console.log(`[Socket] Call ${callId} rejected by ${socket.id}`);
    if (activeCalls[callId]) {
      const webSocketId = activeCalls[callId].webSocketId;
      io.to(webSocketId).emit('call-rejected', { callId });
      delete activeCalls[callId];
    }
  });

  socket.on('hangup-call', ({ callId }) => {
    console.log(`[Socket] Call ${callId} hung up by ${socket.id}`);
    if (activeCalls[callId]) {
      const call = activeCalls[callId];
      
      // Notify the other party
      if (call.webSocketId === socket.id && call.mobileSocketId) {
        io.to(call.mobileSocketId).emit('peer-left', { callId });
      } else if (call.mobileSocketId === socket.id && call.webSocketId) {
        io.to(call.webSocketId).emit('peer-left', { callId });
      }
      
      delete activeCalls[callId];
    }
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`API & signaling server running on port ${PORT}`));

// Get user profile by ID (authentication via token recommended)
app.get('/profile/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, avatar, created_at FROM users WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// Save push token
app.post('/push-token', async (req, res) => {
  console.log('[Push Token] Received request to /push-token with body:', req.body);
  const { userId, pushToken } = req.body;
  if (!userId || !pushToken) {
    return res.json({ success: false, message: 'Missing userId or pushToken' });
  }
  
  try {
    // Update or insert push token for user
    await db.query(
      'UPDATE users SET push_token = ? WHERE id = ?',
      [pushToken, userId]
    );
        console.log('[Push Token] Database update result:', result);
    res.json({ success: true, message: 'Push token saved' });
  } catch (err) {
    console.error('Push token save error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// Send call push notification
app.post('/send-call-push', async (req, res) => {
  console.log(`[Push] Received request to /send-call-push with body:`, req.body);
  const { toUserId, roomId, callerName } = req.body;
  if (!toUserId || !roomId || !callerName) {
    return res.json({ success: false, message: 'Missing required fields' });
  }
  
  try {
    // Get the recipient's push token
    console.log(`[Push] Getting push token for userId: ${toUserId}`);
    const [rows] = await db.query(
      'SELECT push_token FROM users WHERE id = ?',
      [toUserId]
    );
    
    if (!rows.length || !rows[0].push_token) {
      return res.json({ success: false, message: 'User not found or no push token' });
    }
    
        const pushToken = rows[0].push_token;
    console.log(`[Push] Found push token: ${pushToken}`);
    
    // Send push notification using Expo's push service
    const message = {
      to: pushToken,
      title: 'Incoming Call',
      body: `${callerName} is calling...`,
      priority: 'high',
      // Use the category identifier defined in the mobile app
      categoryId: 'incoming_call',
      // The data payload to be used by the app
      data: {
        type: 'incoming_call',
        roomId: roomId,
        callerName: callerName
      },
      // Android-specific settings for a full-screen call notification
      android: {
        channelId: 'incoming_calls', // Must match the channel ID created in the app
        sticky: true, // Makes the notification persistent until dismissed
        fullScreenIntent: true, // Displays the notification as a full-screen activity
      },
    };
    
        console.log('[Push] Sending notification to Expo service with message:', JSON.stringify(message, null, 2));
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
	'Authorization': `Bearer 3yAGY_0iEIsd3m6-LtOYeBB0gmib4AvdVIMl5VjQ`,
      },
      body: JSON.stringify(message),
    });
    
    const result = await response.json();
    console.log('Push notification result:', result);
    
    res.json({ success: true, message: 'Push notification sent', result });
  } catch (err) {
    console.error('Send push error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// Reject call endpoint
app.post('/reject-call', async (req, res) => {
  const { roomId } = req.body;
  if (!roomId) {
    return res.json({ success: false, message: 'Missing roomId' });
  }
  
  try {
    // Emit reject-call to all sockets in the room
    io.to(roomId).emit('call-rejected');
    res.json({ success: true, message: 'Call rejected' });
  } catch (err) {
    console.error('Reject call error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});
