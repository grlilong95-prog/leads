process.env.TZ = 'Asia/Shanghai'; // 强制使用中国北京时间

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

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

// 直接连接你的云端数据库
const MONGO_URI = 'mongodb+srv://gr:Yu19950120@cluster0.o5ppjmn.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ 成功连接云端数据库，数据已实现永久持久化！'))
    .catch(err => console.error('❌ 数据库连接失败:', err));

const UserSchema = new mongoose.Schema({
    id: String, username: String, password: String, role: String,
    balance: Number, can_access: Boolean, can_extract: Boolean, status: String
});
const LeadSchema = new mongoose.Schema({
    id: String, name: String, gender: String, phone: String, region: String,
    source: String, price: Number, originalPrice: Number, create_time: String, timestamp: Number,
    isDiscount20: Boolean, isDiscount50: Boolean, isArchived: { type: Boolean, default: false }
});
const ConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'main' },
    dripConfig: { enabled: Boolean, countPerBatch: Number, intervalSeconds: Number },
    importQueue: Array
});
const LogSchema = new mongoose.Schema({
    id: String, username: String, lead_id: String, lead_name: String,
    phone: String, price: Number, source: String, time: String
});

const User = mongoose.model('User', UserSchema);
const Lead = mongoose.model('Lead', LeadSchema);
const Config = mongoose.model('Config', ConfigSchema);
const PurchaseLog = mongoose.model('PurchaseLog', LogSchema);

// 初始化账号与配置
async function initDB() {
    try {
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
                dripConfig: { enabled: true, countPerBatch: 5, intervalSeconds: 60 },
                importQueue: []
            });
        }
    } catch (e) {
        console.error('初始化配置异常:', e);
    }
}
initDB();

const activeUserSockets = new Map();

// 定时滴灌与降价引擎
let dripTimer = null;

async function startSchedulerEngine() {
    if (dripTimer) clearInterval(dripTimer);

    dripTimer = setInterval(async () => {
        try {
            let needUpdate = false;
            const config = await Config.findOne({ key: 'main' });
            if (!config) return;

            if (config.dripConfig.enabled && config.importQueue.length > 0) {
                const count = Math.min(config.dripConfig.countPerBatch, config.importQueue.length);
                const batch = config.importQueue.splice(0, count);
                const now = Date.now();
                const nowStr = getChinaTimeString(new Date(now));

                for (let lead of batch) {
                    lead.create_time = nowStr;
                    lead.timestamp = now;
                    lead.originalPrice = lead.price;
                    await Lead.create(lead);
                }
                await config.save();
                needUpdate = true;
            }

            const now = Date.now();
            const H24 = 24 * 3600 * 1000;
            const H48 = 48 * 3600 * 1000;
            const D7 = 7 * 24 * 3600 * 1000;

            const activeLeads = await Lead.find({ isArchived: false });
            for (let lead of activeLeads) {
                const age = now - (lead.timestamp || new Date(lead.create_time).getTime() || now);

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
            console.error('调度引擎出错:', err);
        }
    }, 10000);
}

startSchedulerEngine();

io.on('connection', (socket) => {

    socket.on('login', async ({ username, password }, callback) => {
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
    });

    socket.on('fetch-all-data', async (callback) => {
        const users = await User.find({});
        const leads = await Lead.find({ isArchived: false }).sort({ timestamp: -1 });
        const archivedCount = await Lead.countDocuments({ isArchived: true });
        const purchaseLogs = await PurchaseLog.find({}).sort({ _id: -1 });
        const config = await Config.findOne({ key: 'main' });

        callback({
            users,
            leads,
            archivedCount,
            purchaseLogs,
            queueCount: config ? config.importQueue.length : 0,
            dripConfig: config ? config.dripConfig : { enabled: true, countPerBatch: 5, intervalSeconds: 60 }
        });
    });

    socket.on('update-drip-config', async (newConfig, callback) => {
        const config = await Config.findOne({ key: 'main' });
        if (config) {
            config.dripConfig = { ...config.dripConfig, ...newConfig };
            await config.save();
            io.emit('realtime-db-update');
        }
        if (callback) callback({ success: true });
    });

    socket.on('control-import-queue', async (action, callback) => {
        const config = await Config.findOne({ key: 'main' });
        if (config) {
            if (action === 'clear') {
                config.importQueue = [];
            } else if (action === 'release_all') {
                const now = Date.now();
                const nowStr = getChinaTimeString(new Date(now));
                for (let lead of config.importQueue) {
                    lead.create_time = nowStr;
                    lead.timestamp = now;
                    lead.originalPrice = lead.price;
                    await Lead.create(lead);
                }
                config.importQueue = [];
            }
            await config.save();
            io.emit('realtime-db-update');
        }
        if (callback) callback({ success: true });
    });

    socket.on('add-manual-lead', async (leadData, callback) => {
        const cleanPhone = String(leadData.phone || '').trim();
        const existInLeads = await Lead.findOne({ phone: cleanPhone });
        const config = await Config.findOne({ key: 'main' });
        const existInQueue = config ? config.importQueue.some(l => String(l.phone).trim() === cleanPhone) : false;

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
    });

    socket.on('add-batch-leads', async ({ insertList, mode }, callback) => {
        let added = 0, dup = 0;
        const config = await Config.findOne({ key: 'main' });
        const now = Date.now();
        const chinaTime = getChinaTimeString(new Date(now));

        for (let item of insertList) {
            const cleanPhone = String(item.phone || '').trim();
            const existInDb = await Lead.findOne({ phone: cleanPhone });
            const existInQueue = config ? config.importQueue.some(l => String(l.phone).trim() === cleanPhone) : false;

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

                if (mode === 'drip' && config) {
                    config.importQueue.push(leadObj);
                } else {
                    await Lead.create(leadObj);
                }
                added++;
            }
        }

        if (config) await config.save();
        io.emit('realtime-db-update');
        callback({ success: true, addedCount: added, duplicateCount: dup, mode });
    });

    socket.on('extract-leads', async ({ userId, targetLeads }, callback) => {
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
    });

    socket.on('delete-leads', async (leadIds, callback) => {
        await Lead.deleteMany({ id: { $in: leadIds } });
        io.emit('realtime-db-update');
        callback({ success: true });
    });

    socket.on('create-user', async ({ username, password, balance }, callback) => {
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
    });

    socket.on('update-user-field', async ({ userId, updateData }, callback) => {
        await User.updateOne({ id: userId }, { $set: updateData });
        io.emit('realtime-db-update');
        if (callback) callback({ success: true });
    });

    socket.on('disconnect', () => {
        if (socket.userId && activeUserSockets.get(socket.userId) === socket.id) {
            activeUserSockets.delete(socket.userId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`系统启动成功，端口: ${PORT}`));
