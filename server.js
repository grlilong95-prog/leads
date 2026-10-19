process.env.TZ = 'Asia/Shanghai'; // 强制使用中国北京时间

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// ==================== 0. 全局防崩溃安全帽 (绝对防止 Bad Gateway/坏门) ====================
process.on('uncaughtException', (err) => {
    console.error('【捕获到全局报错，程序已自动恢复，防关机】:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('【捕获到未处理的异步报错，程序已自动恢复，防关机】:', reason);
});

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

// 北京时间格式化
function getChinaTimeString(dateObj = new Date()) {
    return dateObj.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 固定的云端数据库存储位置
const MONGO_URI = 'mongodb+srv://gr:Yu19950120@cluster0.o5ppjmn.mongodb.net/loan_leads_db?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log('✅ 成功连接云端数据库，数据已实现永久持久化！'))
    .catch(err => console.error('❌ 数据库连接暂时失败（程序依然保持运行）:', err));

const UserSchema = new mongoose.Schema({
    id: String, username: String, password: String, role: String,
    balance: Number, can_access: Boolean, can_extract: Boolean, status: String
});
const LeadSchema = new mongoose.Schema({
    id: String, name: String, gender: String, phone: String, region: String,
    source: String, price: Number, originalPrice: Number, create_time: String, timestamp: Number,
    isDiscount20: Boolean, isDiscount50: Boolean, isArchived: { type: Boolean, default: false }
});
const QueueSchema = new mongoose.Schema({
    id: String, name: String, gender: String, phone: String, region: String,
    source: String, price: Number, originalPrice: Number
});
const ConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'main' },
    dripConfig: {
        enabled: Boolean,
        mode: { type: String, default: 'fixed' },
        countPerBatch: { type: Number, default: 5 },
        minCountPerBatch: { type: Number, default: 2 },
        maxCountPerBatch: { type: Number, default: 6 },
        intervalSeconds: { type: Number, default: 60 },
        onlyDaytime: { type: Boolean, default: true },
        lastDripTimestamp: { type: Number, default: 0 }
    }
});
const LogSchema = new mongoose.Schema({
    id: String, username: String, lead_id: String, lead_name: String,
    phone: String, price: Number, source: String, time: String
});

const User = mongoose.model('User', UserSchema);
const Lead = mongoose.model('Lead', LeadSchema);
const QueueItem = mongoose.model('QueueItem', QueueSchema);
const Config = mongoose.model('Config', ConfigSchema);
const PurchaseLog = mongoose.model('PurchaseLog', LogSchema);

// 初始化账号与配置
async function initDB() {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await User.create({
                id: 'u_admin', username: 'admin', password: 'admin888', role: 'admin', balance: 999999, can_access: true, can_extract: true, status: 'normal'
            });
        }
        const configExists = await Config.findOne({ key: 'main' });
        if (!configExists) {
            await Config.create({
                key: 'main',
                dripConfig: {
                    enabled: true, mode: 'fixed', countPerBatch: 5,
                    minCountPerBatch: 2, maxCountPerBatch: 6,
                    intervalSeconds: 60, onlyDaytime: true, lastDripTimestamp: 0
                }
            });
        }
    } catch (e) {
        console.error('初始化配置异常:', e);
    }
}
setTimeout(initDB, 3000);

const activeUserSockets = new Map();

// 核心滴灌调度引擎
let dripTimer = null;

async function startSchedulerEngine() {
    if (dripTimer) clearInterval(dripTimer);

    dripTimer = setInterval(async () => {
        try {
            if (mongoose.connection.readyState !== 1) return; // 数据库未准备好时跳过，防报错

            let needUpdate = false;
            const config = await Config.findOne({ key: 'main' });
            if (!config) return;

            const now = Date.now();
            const queueCount = await QueueItem.countDocuments({});

            // A. 滴灌投放引擎
            if (config.dripConfig.enabled && queueCount > 0) {
                const intervalMs = (config.dripConfig.intervalSeconds || 60) * 1000;
                const lastTime = config.dripConfig.lastDripTimestamp || 0;

                if (now - lastTime >= intervalMs) {

                    let canRelease = true;
                    if (config.dripConfig.onlyDaytime !== false) {
                        const currentHour = parseInt(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
                        if (currentHour < 8 || currentHour >= 22) {
                            canRelease = false; 
                        }
                    }

                    if (canRelease) {
                        let releaseCount = config.dripConfig.countPerBatch || 5;

                        if (config.dripConfig.mode === 'random') {
                            const min = Number(config.dripConfig.minCountPerBatch) || 1;
                            const max = Math.max(min, Number(config.dripConfig.maxCountPerBatch) || 5);
                            releaseCount = Math.floor(Math.random() * (max - min + 1)) + min;
                        }

                        const batch = await QueueItem.find({}).limit(releaseCount);
                        if (batch.length > 0) {
                            const nowStr = getChinaTimeString(new Date(now));
                            const idsToRemove = batch.map(b => b._id);

                            for (let item of batch) {
                                await Lead.create({
                                    id: item.id,
                                    name: item.name,
                                    gender: item.gender,
                                    phone: item.phone,
                                    region: item.region,
                                    source: item.source,
                                    price: item.price,
                                    originalPrice: item.price,
                                    create_time: nowStr,
                                    timestamp: now
                                });
                            }

                            await QueueItem.deleteMany({ _id: { $in: idsToRemove } });

                            config.dripConfig.lastDripTimestamp = now;
                            await config.save();
                            needUpdate = true;
                        }
                    }
                }
            }

            // B. 线索自动降价与冷库归档
            const H24 = 24 * 3600 * 1000;
            const H48 = 48 * 3600 * 1000;
            const D7 = 7 * 24 * 3600 * 1000;

            const activeLeads = await Lead.find({ isArchived: false });
            for (let lead of activeLeads) {
                const age = now - (lead.timestamp || now);

                if (age > D7) {
                    lead.isArchived = true;
                    await lead.save();
                    needUpdate = true;
                } else if (age > H48 && !lead.isDiscount50) {
                    lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.5));
                    lead.isDiscount50 = true;
                    lead.isDiscount20 = true;
                    await lead.save();
                    needUpdate = true;
                } else if (age > H24 && !lead.isDiscount20) {
                    lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.8));
                    lead.isDiscount20 = true;
                    await lead.save();
                    needUpdate = true;
                }
            }

            if (needUpdate) {
                io.emit('realtime-db-update');
            }
        } catch (err) {
            console.error('滴灌执行捕获到小异常 (已自动忽略防崩):', err);
        }
    }, 3000);
}

startSchedulerEngine();

io.on('connection', (socket) => {

    socket.on('login', async ({ username, password }, callback) => {
        try {
            const user = await User.findOne({ username, password });
            if (!user) return callback({ success: false, message: '账号或密码错误！' });
            if (!user.can_access || user.status === 'banned') {
                return callback({ success: false, message: '账号已被禁用！' });
            }

            if (activeUserSockets.has(user.id)) {
                const oldSocketId = activeUserSockets.get(user.id);
                if (oldSocketId !== socket.id) {
                    io.to(oldSocketId).emit('force-logout', '您的账号已在其他设备登录，已被挤下线！');
                }
            }
            activeUserSockets.set(user.id, socket.id);
            socket.userId = user.id;

            callback({ success: true, user });
        } catch (e) {
            callback({ success: false, message: '系统连接中，请刷新重试！' });
        }
    });

    socket.on('fetch-all-data', async (callback) => {
        try {
            const users = await User.find({}) || [];
            const purchaseLogs = await PurchaseLog.find({}).sort({ _id: -1 }) || [];

            const purchasedLeadIds = purchaseLogs.map(l => String(l.lead_id));
            const leads = await Lead.find({
                $or: [
                    { isArchived: false },
                    { id: { $in: purchasedLeadIds } }
                ]
            }).sort({ timestamp: -1 }) || [];

            const archivedCount = await Lead.countDocuments({ isArchived: true }) || 0;
            const queueCount = await QueueItem.countDocuments({}) || 0;
            const config = await Config.findOne({ key: 'main' });

            const defaultDrip = {
                enabled: true, mode: 'fixed', countPerBatch: 5,
                minCountPerBatch: 2, maxCountPerBatch: 6,
                intervalSeconds: 60, onlyDaytime: true, lastDripTimestamp: 0
            };

            callback({
                users,
                leads,
                archivedCount,
                purchaseLogs,
                queueCount,
                dripConfig: config ? { ...defaultDrip, ...config.dripConfig } : defaultDrip
            });
        } catch (e) {
            console.error('拉取数据异常:', e);
        }
    });

    socket.on('update-drip-config', async (newConfig, callback) => {
        try {
            const config = await Config.findOne({ key: 'main' });
            if (config) {
                config.dripConfig = { ...config.dripConfig, ...newConfig };
                await config.save();
                io.emit('realtime-db-update');
            }
            if (callback) callback({ success: true });
        } catch (e) {}
    });

    socket.on('control-import-queue', async (action, callback) => {
        try {
            if (action === 'clear') {
                await QueueItem.deleteMany({});
            } else if (action === 'release_all') {
                const queueItems = await QueueItem.find({});
                const now = Date.now();
                const nowStr = getChinaTimeString(new Date(now));
                for (let lead of queueItems) {
                    await Lead.create({
                        id: lead.id, name: lead.name, gender: lead.gender, phone: lead.phone,
                        region: lead.region, source: lead.source, price: lead.price, originalPrice: lead.price,
                        create_time: nowStr, timestamp: now
                    });
                }
                await QueueItem.deleteMany({});
            }
            io.emit('realtime-db-update');
            if (callback) callback({ success: true });
        } catch (e) {}
    });

    socket.on('add-manual-lead', async (leadData, callback) => {
        try {
            const cleanPhone = String(leadData.phone || '').trim();
            const existInLeads = await Lead.findOne({ phone: cleanPhone });
            const existInQueue = await QueueItem.findOne({ phone: cleanPhone });

            if (existInLeads || existInQueue) {
                return callback({ success: false, message: `手机号 ${cleanPhone} 已存在！` });
            }

            const now = Date.now();
            await Lead.create({
                id: 'lead_' + now + '_' + Math.floor(Math.random() * 1000),
                name: leadData.name || '无',
                gender: leadData.gender || '无',
                phone: cleanPhone,
                region: leadData.region || '无',
                source: leadData.source || '无',
                price: Number(leadData.price) || 20,
                originalPrice: Number(leadData.price) || 20,
                create_time: getChinaTimeString(new Date(now)),
                timestamp: now
            });

            io.emit('realtime-db-update');
            callback({ success: true });
        } catch (e) {
            callback({ success: false, message: '录入失败，请重试！' });
        }
    });

    socket.on('add-batch-leads', async ({ insertList, mode }, callback) => {
        try {
            let added = 0, dup = 0;
            const now = Date.now();
            const chinaTime = getChinaTimeString(new Date(now));

            for (let item of insertList) {
                const cleanPhone = String(item.phone || '').trim();
                const existInDb = await Lead.findOne({ phone: cleanPhone });
                const existInQueue = await QueueItem.findOne({ phone: cleanPhone });

                if (existInDb || existInQueue) {
                    dup++;
                } else {
                    const leadObj = {
                        id: 'lead_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
                        name: item.name || '无',
                        gender: item.gender || '无',
                        phone: cleanPhone,
                        region: item.region || '无',
                        source: item.source || 'WPS批量导入',
                        price: Number(item.price) || 20,
                        originalPrice: Number(item.price) || 20,
                        create_time: item.create_time || chinaTime,
                        timestamp: now
                    };

                    if (mode === 'drip') {
                        await QueueItem.create(leadObj);
                    } else {
                        await Lead.create(leadObj);
                    }
                    added++;
                }
            }

            io.emit('realtime-db-update');
            callback({ success: true, addedCount: added, duplicateCount: dup, mode });
        } catch (e) {
            callback({ success: false, message: '导入过程异常，请稍后重试！' });
        }
    });

    socket.on('extract-leads', async ({ userId, targetLeads }, callback) => {
        try {
            const user = await User.findOne({ id: userId });
            if (!user) return callback({ success: false, message: '用户不存在' });
            if (!user.can_extract) return callback({ success: false, message: '账号无提取权限！' });

            const totalPrice = targetLeads.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
            if (user.role !== 'admin' && user.balance < totalPrice) {
                return callback({ success: false, message: `余额不足，所需 ¥${totalPrice}，余额 ¥${user.balance}` });
            }

            if (user.role !== 'admin') {
                user.balance -= totalPrice;
                await user.save();
            }

            const nowStr = getChinaTimeString();
            for (let lead of targetLeads) {
                await PurchaseLog.create({
                    id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                    username: user.username,
                    lead_id: String(lead.id),
                    lead_name: lead.name,
                    phone: lead.phone,
                    price: lead.price,
                    source: lead.source,
                    time: nowStr
                });
            }

            io.emit('realtime-db-update');
            callback({ success: true, newBalance: user.balance });
        } catch (e) {
            callback({ success: false, message: '提取失败，请重试！' });
        }
    });

    socket.on('delete-leads', async (leadIds, callback) => {
        try {
            await Lead.deleteMany({ id: { $in: leadIds } });
            io.emit('realtime-db-update');
            callback({ success: true });
        } catch (e) {}
    });

    socket.on('create-user', async ({ username, password, balance }, callback) => {
        try {
            const exist = await User.findOne({ username });
            if (exist) {
                return callback({ success: false, message: '用户名已存在！' });
            }
            await User.create({
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
        } catch (e) {}
    });

    socket.on('update-user-field', async ({ userId, updateData }, callback) => {
        try {
            await User.updateOne({ id: userId }, { $set: updateData });
            io.emit('realtime-db-update');
            if (callback) callback({ success: true });
        } catch (e) {}
    });

    socket.on('disconnect', () => {
        if (socket.userId && activeUserSockets.get(socket.userId) === socket.id) {
            activeUserSockets.delete(socket.userId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`系统启动成功，端口: ${PORT}`));
