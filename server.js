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

// 全局数据状态
let db = {
    users: [
        { id: 'u_admin', username: 'admin', password: 'admin888', role: 'admin', balance: 999999, can_access: true, can_extract: true, status: 'normal' }
    ],
    leads: [],
    purchaseLogs: []
};

// 待发布缓冲队列与定时发布参数配置
let importQueue = [];
let dripConfig = {
    enabled: true,       // 是否开启定时滴灌
    countPerBatch: 5,    // 每次发布几条
    intervalSeconds: 60  // 间隔多少秒（默认60秒/1分钟）
};
let dripTimer = null;

// 核心定时器：匀速将队列数据释放到公共线索池
function startDripScheduler() {
    if (dripTimer) clearInterval(dripTimer);
    dripTimer = setInterval(() => {
        if (!dripConfig.enabled || importQueue.length === 0) return;

        // 每次提取 countPerBatch 条数据
        const count = Math.min(dripConfig.countPerBatch, importQueue.length);
        const batch = importQueue.splice(0, count);

        // 释放的那一刻，生成最新的“当下真实时间”！
        const nowStr = new Date().toLocaleString();
        batch.forEach(lead => {
            lead.create_time = nowStr; 
            db.leads.unshift(lead);
        });

        // 毫秒级全网广播：子账号页面自动弹出新数据
        io.emit('realtime-db-update');
    }, Math.max(2, dripConfig.intervalSeconds) * 1000);
}

// 启动定时任务
startDripScheduler();

io.on('connection', (socket) => {
    socket.on('login', ({ username, password }, callback) => {
        const user = db.users.find(u => u.username === username && u.password === password);
        if (!user) return callback({ success: false, message: '账号或密码错误！' });
        if (!user.can_access || user.status === 'banned') {
            return callback({ success: false, message: '账号已被禁用！' });
        }
        callback({ success: true, user });
    });

    // 拉取全量数据 + 队列状态
    socket.on('fetch-all-data', (callback) => {
        callback({
            users: db.users,
            leads: db.leads,
            purchaseLogs: db.purchaseLogs,
            queueCount: importQueue.length, // 仅供管理员后台控制使用
            dripConfig: dripConfig
        });
    });

    // 动态调整匀速发布参数
    socket.on('update-drip-config', (config, callback) => {
        dripConfig = { ...dripConfig, ...config };
        startDripScheduler();
        io.emit('realtime-db-update');
        if (callback) callback({ success: true });
    });

    // 队列控制操作 (清空 / 立即全部释放)
    socket.on('control-import-queue', (action, callback) => {
        if (action === 'clear') {
            importQueue = [];
        } else if (action === 'release_all') {
            const nowStr = new Date().toLocaleString();
            importQueue.forEach(lead => {
                lead.create_time = nowStr;
                db.leads.unshift(lead);
            });
            importQueue = [];
        }
        io.emit('realtime-db-update');
        if (callback) callback({ success: true });
    });

    // 手动录入线索
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
            create_time: new Date().toLocaleString()
        };

        db.leads.unshift(newLead);
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    // Excel 批量导入（支持直发或放入定时队列）
    socket.on('add-batch-leads', ({ insertList, mode }, callback) => {
        let added = 0;
        let dup = 0;
        const existingLeadsPhones = new Set(db.leads.map(l => String(l.phone).trim()));
        const existingQueuePhones = new Set(importQueue.map(l => String(l.phone).trim()));

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
                    create_time: item.create_time || new Date().toLocaleString()
                };

                if (mode === 'drip') {
                    importQueue.push(leadObj); // 进入定时释放队列
                } else {
                    db.leads.unshift(leadObj); // 立即全量入库
                }
                added++;
            }
        });

        io.emit('realtime-db-update');
        callback({ success: true, addedCount: added, duplicateCount: dup, mode });
    });

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
                time: nowStr
            });
        });

        io.emit('realtime-db-update');
        callback({ success: true, newBalance: user.balance });
    });

    socket.on('delete-leads', (leadIds, callback) => {
        db.leads = db.leads.filter(l => !leadIds.includes(l.id));
        io.emit('realtime-db-update');
        callback({ success: true });
    });

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
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    socket.on('update-user-field', ({ userId, updateData }, callback) => {
        const u = db.users.find(x => x.id === userId);
        if (u) {
            Object.assign(u, updateData);
            io.emit('realtime-db-update');
            if (callback) callback({ success: true });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`启动成功: ${PORT}`));
