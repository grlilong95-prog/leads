const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    const rootHtml = path.join(__dirname, 'index.html');
    if (fs.existsSync(rootHtml)) {
        res.sendFile(rootHtml);
    } else {
        res.status(404).send('Not Found index.html');
    }
});

// ==================== 1. 本地 JSON 数据持久化引擎 ====================
const DB_FILE = path.join(__dirname, 'db.json');

let db = {
    users: [
        { id: 'u_admin', username: 'admin', password: 'admin888', role: 'admin', balance: 999999, can_access: true, can_extract: true, status: 'normal' }
    ],
    leads: [],
    archivedLeads: [], // 冷库归档线索
    purchaseLogs: [],
    dripConfig: { enabled: true, countPerBatch: 5, intervalSeconds: 60 }
};

let importQueue = [];

// 读取文件
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(data);
            if (!db.archivedLeads) db.archivedLeads = [];
            console.log('成功加载本地持久化数据库 (db.json)');
        } else {
            saveDB();
        }
    } catch (e) {
        console.error('数据库加载失败，使用默认配置:', e);
    }
}

// 防抖写入文件（避免频繁写磁盘）
let saveTimer = null;
function saveDB() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
        } catch (e) {
            console.error('数据库保存失败:', e);
        }
    }, 500);
}

loadDB(); // 初始化加载

// ==================== 2. 账号单设备锁登录态记录 ====================
const activeUserSockets = new Map(); // userId -> socket.id

// ==================== 3. 定时滴灌 + 线索降价/归档引擎 ====================
let dripTimer = null;

function startSchedulerEngine() {
    if (dripTimer) clearInterval(dripTimer);
    dripTimer = setInterval(() => {
        let needUpdate = false;

        // A. 匀速滴灌投放
        if (db.dripConfig.enabled && importQueue.length > 0) {
            const count = Math.min(db.dripConfig.countPerBatch, importQueue.length);
            const batch = importQueue.splice(0, count);
            const nowStr = new Date().toLocaleString();
            batch.forEach(lead => {
                lead.create_time = nowStr;
                lead.timestamp = Date.now(); // 记录精准时间戳用于降价归档
                lead.originalPrice = lead.price;
                db.leads.unshift(lead);
            });
            needUpdate = true;
        }

        // B. 线索降价与冷库归档检查
        const now = Date.now();
        const H24 = 24 * 3600 * 1000;
        const H48 = 48 * 3600 * 1000;
        const D7 = 7 * 24 * 3600 * 1000;

        for (let i = db.leads.length - 1; i >= 0; i--) {
            const lead = db.leads[i];
            const age = now - (lead.timestamp || new Date(lead.create_time).getTime() || now);

            // 超 7 天无人问津 -> 自动冷库归档
            if (age > D7) {
                db.archivedLeads.unshift(db.leads.splice(i, 1)[0]);
                needUpdate = true;
                continue;
            }

            // 超 48 小时 -> 5 折降价
            if (age > H48 && !lead.isDiscount50) {
                lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.5));
                lead.isDiscount50 = true;
                lead.isDiscount20 = true;
                needUpdate = true;
            } 
            // 超 24 小时 -> 8 折降价
            else if (age > H24 && !lead.isDiscount20) {
                lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.8));
                lead.isDiscount20 = true;
                needUpdate = true;
            }
        }

        if (needUpdate) {
            saveDB();
            io.emit('realtime-db-update');
        }
    }, Math.max(2, db.dripConfig.intervalSeconds) * 1000);
}

startSchedulerEngine();

// ==================== Socket.io 实时交互监听 ====================
io.on('connection', (socket) => {

    // 账号登录（带抢占挤下线设备锁）
    socket.on('login', ({ username, password }, callback) => {
        const user = db.users.find(u => u.username === username && u.password === password);
        if (!user) return callback({ success: false, message: '账号或密码错误！' });
        if (!user.can_access || user.status === 'banned') {
            return callback({ success: false, message: '账号已被禁用！' });
        }

        // 设备锁校验：若已在其他地方登录，挤掉对方
        if (activeUserSockets.has(user.id)) {
            const oldSocketId = activeUserSockets.get(user.id);
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('force-logout', '您的账号已在其他设备或浏览器登录，您已被挤下线！');
            }
        }
        activeUserSockets.set(user.id, socket.id);
        socket.userId = user.id;

        callback({ success: true, user });
    });

    // 拉取数据
    socket.on('fetch-all-data', (callback) => {
        callback({
            users: db.users,
            leads: db.leads,
            archivedCount: db.archivedLeads.length,
            purchaseLogs: db.purchaseLogs,
            queueCount: importQueue.length,
            dripConfig: db.dripConfig
        });
    });

    // 调整滴灌频率
    socket.on('update-drip-config', (config, callback) => {
        db.dripConfig = { ...db.dripConfig, ...config };
        saveDB();
        startSchedulerEngine();
        io.emit('realtime-db-update');
        if (callback) callback({ success: true });
    });

    // 队列控制
    socket.on('control-import-queue', (action, callback) => {
        if (action === 'clear') {
            importQueue = [];
        } else if (action === 'release_all') {
            const nowStr = new Date().toLocaleString();
            const now = Date.now();
            importQueue.forEach(lead => {
                lead.create_time = nowStr;
                lead.timestamp = now;
                lead.originalPrice = lead.price;
                db.leads.unshift(lead);
            });
            importQueue = [];
        }
        saveDB();
        io.emit('realtime-db-update');
        if (callback) callback({ success: true });
    });

    // 手动录入
    socket.on('add-manual-lead', (leadData, callback) => {
        const cleanPhone = String(leadData.phone || '').trim();
        const existInLeads = db.leads.some(l => String(l.phone).trim() === cleanPhone);
        const existInQueue = importQueue.some(l => String(l.phone).trim() === cleanPhone);

        if (existInLeads || existInQueue) {
            return callback({ success: false, message: `手机号 ${cleanPhone} 已存在（或正在排队中）！` });
        }

        const newLead = {
            id: 'lead_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            name: leadData.name || '无',
            gender: leadData.gender || '无',
            phone: cleanPhone,
            region: leadData.region || '无',
            source: leadData.source || '无',
            price: Number(leadData.price) || 20,
            originalPrice: Number(leadData.price) || 20,
            create_time: new Date().toLocaleString(),
            timestamp: Date.now()
        };

        db.leads.unshift(newLead);
        saveDB();
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    // Excel 批量导入
    socket.on('add-batch-leads', ({ insertList, mode }, callback) => {
        let added = 0;
        let dup = 0;
        const existingLeadsPhones = new Set(db.leads.map(l => String(l.phone).trim()));
        const existingQueuePhones = new Set(importQueue.map(l => String(l.phone).trim()));
        const now = Date.now();

        insertList.forEach(item => {
            const cleanPhone = String(item.phone || '').trim();
            if (existingLeadsPhones.has(cleanPhone) || existingQueuePhones.has(cleanPhone)) {
                dup++;
            } else {
                existingLeadsPhones.add(cleanPhone);
                const leadObj = {
                    id: 'lead_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
                    name: item.name || '无',
                    gender: item.gender || '无',
                    phone: cleanPhone,
                    region: item.region || '无',
                    source: item.source || 'WPS批量导入',
                    price: Number(item.price) || 20,
                    originalPrice: Number(item.price) || 20,
                    create_time: item.create_time || new Date().toLocaleString(),
                    timestamp: now
                };

                if (mode === 'drip') {
                    importQueue.push(leadObj);
                } else {
                    db.leads.unshift(leadObj);
                }
                added++;
            }
        });

        saveDB();
        io.emit('realtime-db-update');
        callback({ success: true, addedCount: added, duplicateCount: dup, mode });
    });

    // 购买/提取线索
    socket.on('extract-leads', ({ userId, targetLeads }, callback) => {
        const user = db.users.find(u => u.id === userId);
        if (!user) return callback({ success: false, message: '用户不存在' });
        if (!user.can_extract) return callback({ success: false, message: '账号无提取权限！' });

        const totalPrice = targetLeads.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
        if (user.role !== 'admin' && user.balance < totalPrice) {
            return callback({ success: false, message: `余额不足，所需 ¥${totalPrice}，余额 ¥${user.balance}` });
        }

        if (user.role !== 'admin') {
            user.balance -= totalPrice;
        }

        const nowStr = new Date().toLocaleString();
        targetLeads.forEach(lead => {
            db.purchaseLogs.unshift({
                id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                username: user.username,
                lead_id: String(lead.id),
                lead_name: lead.name,
                phone: lead.phone,
                price: lead.price,
                source: lead.source,
                time: nowStr
            });
        });

        saveDB();
        io.emit('realtime-db-update');
        callback({ success: true, newBalance: user.balance });
    });

    // 删除线索
    socket.on('delete-leads', (leadIds, callback) => {
        db.leads = db.leads.filter(l => !leadIds.includes(l.id));
        saveDB();
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    // 创建子账号
    socket.on('create-user', ({ username, password, balance }, callback) => {
        if (db.users.some(u => u.username === username)) {
            return callback({ success: false, message: '用户名已存在！' });
        }
        db.users.push({
            id: 'u_' + Date.now(),
            username,
            password,
            balance: Number(balance) || 0,
            role: 'user',
            can_access: true,
            can_extract: true,
            status: 'normal'
        });
        saveDB();
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    // 更新用户状态
    socket.on('update-user-field', ({ userId, updateData }, callback) => {
        const u = db.users.find(x => x.id === userId);
        if (u) {
            Object.assign(u, updateData);
            saveDB();
            io.emit('realtime-db-update');
            if (callback) callback({ success: true });
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId && activeUserSockets.get(socket.userId) === socket.id) {
            activeUserSockets.delete(socket.userId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`系统启动成功，端口: ${PORT}`));
