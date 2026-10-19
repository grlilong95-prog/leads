process.env.TZ = 'Asia/Shanghai'; // 强制使用中国北京时间

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// 全局防崩溃护航
process.on('uncaughtException', (err) => console.error('【捕获未处理异常】:', err));
process.on('unhandledRejection', (reason) => console.error('【捕获未处理拒绝】:', reason));

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

// 精准北京时间字符串
function getChinaTimeString(dateObj = new Date()) {
    return dateObj.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 精准北京时间小时 (0-23)
function getBeijingHour() {
    try {
        const hourStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false });
        return parseInt(hourStr, 10);
    } catch (e) {
        return new Date().getHours();
    }
}

// 统一过滤清理手机号（只提取纯数字）
function sanitizePhone(rawPhone) {
    if (!rawPhone) return '';
    return String(rawPhone).replace(/[^0-9]/g, '').trim();
}

// 数据库连接 (固定为 loan_leads_db)
const MONGO_URI = 'mongodb+srv://gr:Yu19950120@cluster0.o5ppjmn.mongodb.net/loan_leads_db?retryWrites=true&w=majority';

// 允许缓冲指令，防止网络波动直接报错
mongoose.set('bufferCommands', true);

mongoose.connect(MONGO_URI, { 
    serverSelectionTimeoutMS: 15000, 
    maxPoolSize: 10 
})
.then(() => {
    console.log('✅ 成功连接云端数据库！所有数据正稳妥保护中！');
    migrateOldData();
})
.catch(err => console.error('❌ 数据库连接暂时失败，系统正在自动尝试重连...', err));

const UserSchema = new mongoose.Schema({
    id: { type: String, index: true },
    username: { type: String, unique: true, index: true },
    password: String, role: String, balance: Number,
    can_access: Boolean, can_extract: Boolean, status: String
});

const LeadSchema = new mongoose.Schema({
    id: { type: String, unique: true, index: true },
    name: String, gender: String,
    phone: { type: String, index: true },
    region: String, source: String, price: Number, originalPrice: Number,
    create_time: String, timestamp: { type: Number, index: true },
    isDiscount20: Boolean, isDiscount50: Boolean,
    isArchived: { type: Boolean, default: false, index: true }
});

const QueueSchema = new mongoose.Schema({
    id: { type: String, unique: true, index: true },
    name: String, gender: String,
    phone: { type: String, index: true },
    region: String, source: String, price: Number, originalPrice: Number
});

const ConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    dripConfig: {
        enabled: Boolean,
        mode: { type: String, default: 'fixed' },
        countPerBatch: { type: Number, default: 5 },
        minCountPerBatch: { type: Number, default: 2 },
        maxCountPerBatch: { type: Number, default: 6 },
        intervalSeconds: { type: Number, default: 60 },
        onlyDaytime: { type: Boolean, default: true },
        lastDripTimestamp: { type: Number, default: 0 }
    },
    importQueue: Array
});

const LogSchema = new mongoose.Schema({
    id: String, username: { type: String, index: true },
    lead_id: { type: String, index: true }, lead_name: String,
    phone: String, price: Number, source: String, time: String
});

const User = mongoose.model('User', UserSchema);
const Lead = mongoose.model('Lead', LeadSchema);
const QueueItem = mongoose.model('QueueItem', QueueSchema);
const Config = mongoose.model('Config', ConfigSchema);
const PurchaseLog = mongoose.model('PurchaseLog', LogSchema);

async function migrateOldData() {
    try {
        const config = await Config.findOne({ key: 'main' });
        if (config && config.importQueue && config.importQueue.length > 0) {
            console.log(`检测到旧队列中有 ${config.importQueue.length} 条数据，开始搬迁...`);
            const oldQueue = config.importQueue;
            const docsToInsert = oldQueue.map(item => ({
                id: item.id || ('lead_' + Date.now() + '_' + Math.floor(Math.random() * 10000)),
                name: item.name || '无',
                gender: item.gender || '无',
                phone: sanitizePhone(item.phone),
                region: item.region || '无',
                source: item.source || '批量导入',
                price: Number(item.price) || 20,
                originalPrice: Number(item.price) || 20
            }));

            const batchSize = 2000;
            for (let i = 0; i < docsToInsert.length; i += batchSize) {
                const chunk = docsToInsert.slice(i, i + batchSize);
                await QueueItem.insertMany(chunk, { ordered: false });
            }

            config.importQueue = [];
            await config.save();
            console.log('✅ 数据平滑迁移完毕！');
            io.emit('realtime-db-update');
        }
    } catch (e) {
        console.error('迁移提示:', e.message);
    }
}

async function initDB() {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const adminExists = await User.findOne({ username: 'admin' }).lean();
        if (!adminExists) {
            await User.create({
                id: 'u_admin', username: 'admin', password: 'admin888', role: 'admin', balance: 999999, can_access: true, can_extract: true, status: 'normal'
            });
        }
        const configExists = await Config.findOne({ key: 'main' }).lean();
        if (!configExists) {
            await Config.create({
                key: 'main',
                dripConfig: {
                    enabled: true, mode: 'fixed', countPerBatch: 5,
                    minCountPerBatch: 2, maxCountPerBatch: 6,
                    intervalSeconds: 60, onlyDaytime: true, lastDripTimestamp: 0
                },
                importQueue: []
            });
        }
    } catch (e) {}
}
setTimeout(initDB, 2000);

const activeUserSockets = new Map();

// 滴灌引擎
let isDripRunning = false;
async function runDripLoop() {
    if (isDripRunning) return;
    isDripRunning = true;
    try {
        if (mongoose.connection.readyState === 1) {
            const config = await Config.findOne({ key: 'main' }).lean();
            if (config && config.dripConfig && config.dripConfig.enabled) {
                const queueCount = await QueueItem.countDocuments({});
                if (queueCount > 0) {
                    const now = Date.now();
                    const intervalMs = (config.dripConfig.intervalSeconds || 60) * 1000;
                    const lastTime = config.dripConfig.lastDripTimestamp || 0;

                    if (now - lastTime >= intervalMs) {
                        let canRelease = true;
                        if (config.dripConfig.onlyDaytime !== false) {
                            const bjHour = getBeijingHour();
                            if (bjHour < 8 || bjHour >= 22) {
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

                            const batch = await QueueItem.find({}).limit(releaseCount).lean();
                            if (batch.length > 0) {
                                const nowStr = getChinaTimeString(new Date(now));
                                const idsToRemove = batch.map(b => b._id);

                                const docsToInsert = batch.map(item => ({
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
                                }));

                                await Lead.insertMany(docsToInsert);
                                await QueueItem.deleteMany({ _id: { $in: idsToRemove } });

                                await Config.updateOne({ key: 'main' }, { $set: { 'dripConfig.lastDripTimestamp': now } });
                                io.emit('realtime-db-update');
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('滴灌提示:', err.message);
    } finally {
        isDripRunning = false;
        setTimeout(runDripLoop, 4000);
    }
}
runDripLoop();

// 降价引擎
async function runAgingJob() {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const now = Date.now();
        const H24 = 24 * 3600 * 1000;
        const H48 = 48 * 3600 * 1000;

        let needEmit = false;

        // 【安全修复】：移除了原本7天强行封存隐身的代码，线索永久留存在列表里！

        const discount50Leads = await Lead.find({ isDiscount50: { $ne: true }, timestamp: { $lt: now - H48 } });
        for (let lead of discount50Leads) {
            lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.5));
            lead.isDiscount50 = true;
            lead.isDiscount20 = true;
            await lead.save();
            needEmit = true;
        }

        const discount20Leads = await Lead.find({ isDiscount50: { $ne: true }, isDiscount20: { $ne: true }, timestamp: { $lt: now - H24 } });
        for (let lead of discount20Leads) {
            lead.price = Math.max(1, Math.floor((lead.originalPrice || lead.price) * 0.8));
            lead.isDiscount20 = true;
            await lead.save();
            needEmit = true;
        }

        if (needEmit) {
            io.emit('realtime-db-update');
        }
    } catch (e) {
        console.error('降价提示:', e.message);
    }
}
setInterval(runAgingJob, 10 * 60 * 1000);

// Socket 交互
io.on('connection', (socket) => {

    socket.on('login', async ({ username, password }, callback) => {
        try {
            const user = await User.findOne({ username, password }).lean();
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

    // 【安全修复】：即便网络抖动，也绝不向前端返还空数组覆盖前端！
    socket.on('fetch-all-data', async (callback) => {
        try {
            if (mongoose.connection.readyState !== 1) {
                console.log('⚠️ 数据库连接中，跳过此帧数据推送，防止清空前端数据');
                return;
            }

            const users = await User.find({}).select('-password').lean() || [];
            const purchaseLogs = await PurchaseLog.find({}).sort({ _id: -1 }).limit(3000).lean() || [];

            // 【安全修复】：获取数据库所有线索，永久不隐藏、不封存！
            const leads = await Lead.find({}).sort({ timestamp: -1 }).lean() || [];
            
            const archivedCount = await Lead.countDocuments({ isArchived: true }) || 0;
            const queueCount = await QueueItem.countDocuments({}) || 0;
            const config = await Config.findOne({ key: 'main' }).lean();

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
            console.error('拉取数据异常:', e.message);
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
                await Config.updateOne({ key: 'main' }, { $set: { importQueue: [] } });
            } else if (action === 'release_all') {
                const queueItems = await QueueItem.find({}).lean();
                const now = Date.now();
                const nowStr = getChinaTimeString(new Date(now));
                const docsToInsert = queueItems.map(lead => ({
                    id: lead.id, name: lead.name, gender: lead.gender, phone: lead.phone,
                    region: lead.region, source: lead.source, price: lead.price, originalPrice: lead.price,
                    create_time: nowStr, timestamp: now
                }));
                if (docsToInsert.length > 0) {
                    await Lead.insertMany(docsToInsert);
                }
                await QueueItem.deleteMany({});
                await Config.updateOne({ key: 'main' }, { $set: { importQueue: [] } });
            }
            io.emit('realtime-db-update');
            if (callback) callback({ success: true });
        } catch (e) {}
    });

    socket.on('add-manual-lead', async (leadData, callback) => {
        try {
            const cleanPhone = sanitizePhone(leadData.phone);
            if (cleanPhone.length !== 11) {
                return callback({ success: false, message: '请输入正确的 11 位手机号！' });
            }

            const existInLeads = await Lead.findOne({ phone: cleanPhone }).lean();
            const existInQueue = await QueueItem.findOne({ phone: cleanPhone }).lean();

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

            const incomingPhones = insertList
                .map(item => sanitizePhone(item.phone))
                .filter(p => p.length === 11);

            const existingLeads = await Lead.find({ phone: { $in: incomingPhones } }).select('phone').lean();
            const existingQueues = await QueueItem.find({ phone: { $in: incomingPhones } }).select('phone').lean();

            const existingPhoneSet = new Set([
                ...existingLeads.map(l => l.phone),
                ...existingQueues.map(q => q.phone)
            ]);

            const queueDocs = [];
            const leadDocs = [];

            for (let item of insertList) {
                const cleanPhone = sanitizePhone(item.phone);
                if (cleanPhone.length !== 11) continue;

                if (existingPhoneSet.has(cleanPhone)) {
                    dup++;
                } else {
                    existingPhoneSet.add(cleanPhone);
                    const leadObj = {
                        id: 'lead_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
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
                        queueDocs.push(leadObj);
                    } else {
                        leadDocs.push(leadObj);
                    }
                    added++;
                }
            }

            if (queueDocs.length > 0) await QueueItem.insertMany(queueDocs, { ordered: false });
            if (leadDocs.length > 0) await Lead.insertMany(leadDocs, { ordered: false });

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

            const targetIds = targetLeads.map(l => String(l.id));
            const dbLeads = await Lead.find({ id: { $in: targetIds } }).lean();

            if (dbLeads.length === 0) {
                return callback({ success: false, message: '选择的线索不存在或已被删除！' });
            }

            const totalPrice = dbLeads.reduce((sum, item) => sum + (Number(item.price) || 0), 0);

            if (user.role !== 'admin' && user.balance < totalPrice) {
                return callback({ success: false, message: `余额不足，所需 ¥${totalPrice}，当前余额 ¥${user.balance}` });
            }

            if (user.role !== 'admin') {
                user.balance -= totalPrice;
                await user.save();
            }

            const nowStr = getChinaTimeString();
            const logDocs = dbLeads.map(lead => ({
                id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                username: user.username,
                lead_id: String(lead.id),
                lead_name: lead.name,
                phone: lead.phone,
                price: lead.price,
                source: lead.source,
                time: nowStr
            }));
            await PurchaseLog.insertMany(logDocs);

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
            const exist = await User.findOne({ username }).lean();
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
server.listen(PORT, () => console.log(`🚀 系统安全启动成功！监听端口: ${PORT}`));
