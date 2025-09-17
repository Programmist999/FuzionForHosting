const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

// Хранилище WebSocket соединений
const userConnections = new Map();
const activeCalls = new Map(); // Добавляем для отслеживания активных звонков

// WebSocket обработка
wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const userId = url.searchParams.get('userId');
    
    console.log('User connected:', userId);
    
    if (userId) {
        userConnections.set(userId.toString(), ws);
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(userId, data);
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        console.log('User disconnected:', userId);
        if (userId) {
            userConnections.delete(userId.toString());
            
            // Завершаем все активные звонки пользователя
            for (const [callId, callInfo] of activeCalls.entries()) {
                if (callInfo.callerId === userId.toString() || callInfo.targetUserId === userId.toString()) {
                    activeCalls.delete(callId);
                    notifyCallEnded(callId, userId.toString());
                }
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleWebSocketMessage(userId, data) {
    console.log('Received message:', data.type, 'from:', userId);
    console.log('Received message type:', data.type, 'from user:', userId);
    
    switch (data.type) {
        case 'call-offer':
            handleCallOffer(userId, data);
            break;
        case 'call-answer':
            handleCallAnswer(userId, data);
            break;
        case 'ice-candidate':
            (userId, data);
            break;
        case 'reject-call':
            handleRejectCall(userId, data);
            break;
        case 'end-call':
            handleEndCall(userId, data);
            break;
    }
}

function handleCallOffer(callerId, data) {
    const { targetUserId, offer, callerName, callerAvatar, callId } = data;
    console.log('Call offer from', callerId, 'to', targetUserId, 'callId:', callId);
    
    // Сохраняем информацию о звонке
    activeCalls.set(callId, {
        callerId: callerId.toString(),
        targetUserId: targetUserId.toString(),
        offer: offer,
        timestamp: Date.now()
    });
    
    const targetWs = userConnections.get(targetUserId.toString());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'incoming-call',
            callerId: callerId,
            offer: offer,
            callerName: callerName,
            callerAvatar: callerAvatar,
            callId: callId
        }));
        console.log('Call offer sent to', targetUserId);
    } else {
        console.log('Target user not connected:', targetUserId);
        activeCalls.delete(callId);
        
        // Уведомляем вызывающего о недоступности
        const callerWs = userConnections.get(callerId.toString());
        if (callerWs && callerWs.readyState === WebSocket.OPEN) {
            callerWs.send(JSON.stringify({
                type: 'call-error',
                error: 'USER_OFFLINE',
                message: 'Пользователь не в сети'
            }));
        }
    }
}

function handleCallAnswer(calleeId, data) {
    const { callerId, answer, callId } = data;
    console.log('Call answer from', calleeId, 'to', callerId, 'callId:', callId);
    
    // Проверяем, что звонок существует
    const callInfo = activeCalls.get(callId);
    if (!callInfo || callInfo.callerId !== callerId.toString() || callInfo.targetUserId !== calleeId.toString()) {
        console.log('Invalid call answer for callId:', callId);
        return;
    }
    
    const callerWs = userConnections.get(callerId.toString());
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call-answered',
            answer: answer,
            calleeId: calleeId,
            callId: callId
        }));
    }
}

function handleIceCandidate(userId, data) {
    const { targetUserId, candidate, callId } = data;
    console.log('ICE candidate from', userId, 'to', targetUserId, 'callId:', callId);

    // В handleIceCandidate добавьте:
    console.log('ICE candidate data:', {
        from: userId,
        to: targetUserId,
        callId: callId,
        candidate: candidate ? 'exists' : 'null'
    });
    
    // Проверяем, что звонок существует
    const callInfo = activeCalls.get(callId);
    if (!callInfo) {
        console.log('ICE candidate for non-existent call:', callId);
        return;
    }
    
    const targetWs = userConnections.get(targetUserId.toString());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        console.log('Forwarding ICE candidate to target user');
        targetWs.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: candidate,
            userId: userId,
            callId: callId
        }));
    } else {
        console.log('Target user not connected for ICE candidate:', targetUserId);
    }
}

function handleRejectCall(calleeId, data) {
    const { callerId, callId } = data;
    console.log('Call rejected by', calleeId, 'for caller', callerId, 'callId:', callId);
    
    // Удаляем информацию о звонке
    activeCalls.delete(callId);
    
    const callerWs = userConnections.get(callerId.toString());
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call-rejected',
            calleeId: calleeId,
            callId: callId
        }));
    }
}

function handleEndCall(userId, data) {
    const { targetUserId, callId } = data;
    console.log('End call from', userId, 'to', targetUserId, 'callId:', callId);
    
    // Удаляем информацию о звонке
    activeCalls.delete(callId);
    
    const targetWs = userConnections.get(targetUserId.toString());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'call-ended',
            callId: callId
        }));
    }
}

function notifyCallEnded(callId, disconnectedUserId) {
    const callInfo = activeCalls.get(callId);
    if (!callInfo) return;
    
    const otherUserId = callInfo.callerId === disconnectedUserId ? callInfo.targetUserId : callInfo.callerId;
    const otherWs = userConnections.get(otherUserId);
    
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
        otherWs.send(JSON.stringify({
            type: 'call-ended',
            reason: 'USER_DISCONNECTED',
            callId: callId
        }));
    }
    
    activeCalls.delete(callId);
}

// Очистка старых звонков каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [callId, callInfo] of activeCalls.entries()) {
        if (now - callInfo.timestamp > 300000) { // 5 минут
            activeCalls.delete(callId);
            console.log('Cleaned up old call:', callId);
        }
    }
}, 60000);

// Инициализация базы данных (остается без изменений)
const db = new sqlite3.Database('./messenger.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
    } else {
        console.log('Подключение к SQLite базе данных установлено.');
        
        // Создание таблицы пользователей
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            avatar TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('Ошибка создания таблицы users:', err);
            } else {
                console.log('Таблица users готова.');
            }
        });
        
        // Создание таблицы сообщений
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            message_text TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_read INTEGER DEFAULT 0,
            FOREIGN KEY (sender_id) REFERENCES users (id),
            FOREIGN KEY (receiver_id) REFERENCES users (id)
        )`, (err) => {
            if (err) {
                console.error('Ошибка создания таблицы messages:', err);
            } else {
                console.log('Таблица messages готова.');
            }
        });
        
        // Создание тестового пользователя
        db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
            if (err) {
                console.error('Ошибка проверки пользователей:', err);
                return;
            }
            
            if (row.count === 0) {
                const testPassword = bcrypt.hashSync("test123", 10);
                db.run(
                    "INSERT INTO users (username, password, name, avatar) VALUES (?, ?, ?, ?)",
                    ["testuser", testPassword, "Test User", "https://via.placeholder.com/150/7a64ff/ffffff?text=T"],
                    function(err) {
                        if (err) {
                        }
                    }
                );
            }
        });
    }
});

// API маршруты (остаются без изменений)
app.post('/api/register', async (req, res) => {
    const { username, password, name } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Имя пользователя и пароль обязательны' });
    }
    
    if (username.length < 3) {
        return res.status(400).json({ success: false, error: 'Имя пользователя должно содержать至少 3 символа' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Пароль должен содержать至少 6 символов' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run(
            'INSERT INTO users (username, password, name) VALUES (?, ?, ?)',
            [username, hashedPassword, name || username],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(400).json({ success: false, error: 'Пользователь с таким именем уже существует' });
                    }
                    return res.status(500).json({ success: false, error: 'Ошибка при создании пользователя' });
                }
                
                db.get(
                    'SELECT id, username, name, avatar, created_at FROM users WHERE id = ?',
                    [this.lastID],
                    (err, user) => {
                        if (err) {
                            return res.status(500).json({ success: false, error: 'Ошибка при получении данных пользователя' });
                        }
                        
                        res.json({ 
                            success: true,
                            message: 'Пользователь успешно создан',
                            user
                        });
                    }
                );
            }
        );
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Имя пользователя и пароль обязательны' });
    }
    
    db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        async (err, user) => {
            if (err) {
                console.error('Ошибка поиска пользователя:', err);
                return res.status(500).json({ success: false, error: 'Ошибка сервера' });
            }
            
            if (!user) {
                return res.status(400).json({ success: false, error: 'Неверное имя пользователя или пароль' });
            }
            
            const isValidPassword = await bcrypt.compare(password, user.password);
            
            if (!isValidPassword) {
                return res.status(400).json({ success: false, error: 'Неверное имя пользователя или пароль' });
            }
            
            const { password: _, ...userWithoutPassword } = user;
            res.json({ 
                success: true,
                message: 'Вход выполнен успешно',
                user: userWithoutPassword
            });
        }
    );
});

app.post('/api/update-profile', (req, res) => {
    const { userId, name, avatar } = req.body;
    
    if (!userId) {
        return res.status(400).json({ success: false, error: 'ID пользователя обязательно' });
    }
    
    db.run(
        'UPDATE users SET name = COALESCE(?, name), avatar = COALESCE(?, avatar) WHERE id = ?',
        [name, avatar, userId],
        function(err) {
            if (err) {
                console.error('Ошибка обновления профиля:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при обновлении профиля' });
            }
            
           db.get(
                'SELECT id, username, name, avatar, created_at FROM users WHERE id = ?',
                [userId],
                (err, user) => {  // ← Добавлено =>
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Ошибка при получении данных пользователя' });
                    }
                    
                    res.json({ 
                        success: true,
                        message: 'Профиль успешно обновлен',
                        user
                    });
                }
            );
        }
    );
});

app.get('/api/users', (req, res) => {
    db.all(
        'SELECT id, username, name, avatar, created_at FROM users ORDER BY name',
        (err, users) => {
            if (err) {
                console.error('Ошибка получения пользователей:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при получении списка пользователей' });
            }
            
            res.json({ success: true, users });
        }
    );
});

app.post('/api/send-message', (req, res) => {
    const { senderId, receiverId, messageText } = req.body;
    
    if (!senderId || !receiverId || !messageText) {
        return res.status(400).json({ success: false, error: 'Отсутствуют обязательные поля' });
    }
    
    db.run(
        'INSERT INTO messages (sender_id, receiver_id, message_text) VALUES (?, ?, ?)',
        [senderId, receiverId, messageText],
        function(err) {
            if (err) {
                console.error('Ошибка отправки сообщения:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при отправке сообщения' });
            }
            
            res.json({ 
                success: true,
                message: 'Сообщение отправлено',
                messageId: this.lastID
            });
        }
    );
});

app.get('/api/messages/:userId1/:userId2', (req, res) => {
    const { userId1, userId2 } = req.params;
    
    db.all(
        `SELECT m.*, u1.username as sender_username, u1.name as sender_name, u1.avatar as sender_avatar,
                u2.username as receiver_username, u2.name as receiver_name, u2.avatar as receiver_avatar
         FROM messages m
         JOIN users u1 ON m.sender_id = u1.id
         JOIN users u2 ON m.receiver_id = u2.id
         WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
         ORDER BY m.timestamp ASC`,
        [userId1, userId2, userId2, userId1],
        (err, messages) => {
            if (err) {
                console.error('Ошибка получения сообщений:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при получении сообщений' });
            }
            
            db.run(
                'UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
                [userId1, userId2],
                (err) => {
                    if (err) {
                        console.error('Ошибка обновления статуса сообщений:', err);
                    }
                    
                    res.json({ success: true, messages });
                }
            );
        }
    );
});

app.get('/api/check-new-messages/:userId/:contactId', (req, res) => {
    const { userId, contactId } = req.params;
    
    db.get(
        `SELECT COUNT(*) as count 
         FROM messages 
         WHERE (receiver_id = ? AND sender_id = ? AND is_read = 0)`,
        [userId, contactId],
        (err, row) => {
            if (err) {
                console.error('Ошибка проверки новых сообщений:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при проверке сообщений' });
            }
            
            res.json({ success: true, hasNewMessages: row.count > 0 });
        }
    );
});

app.get('/api/search-users', (req, res) => {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
        return res.status(400).json({ success: false, error: 'Слишком короткий запрос' });
    }
    
    db.all(
        `SELECT id, username, name, avatar, created_at 
         FROM users 
         WHERE username LIKE ? OR name LIKE ?
         ORDER BY username
         LIMIT 10`,
        [`%${query}%`, `%${query}%`],
        (err, users) => {
            if (err) {
                console.error('Ошибка поиска пользователей:', err);
                return res.status(500).json({ success: false, error: 'Ошибка при поиске пользователей' });
            }
            
            res.json({ success: true, users });
        }
    );
});

// Обслуживание статических файлов
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработка ошибок
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`WebSocket сервер запущен`);
    console.log(`Откройте в браузера: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nЗавершение работы сервера...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Подключение к базе данных закрыто.');
        server.close(() => {
            console.log('Сервер остановлен.');
            process.exit(0);
        });
    });
});


