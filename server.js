const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// 全局内存数据库（支持异地实时共享）
let db = {
    users: [
        { id: 'u_admin', username: 'admin', password: 'admin888', role: 'admin', balance: 999999, can_access: true, can_extract: true, status: 'normal' }
    ],
    leads: [],
    purchaseLogs: []
};

// 页面路由：优先读取文件，防止符号冲突导致白屏
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    const p1 = path.join(__dirname, 'public', 'index.html');
    const p2 = path.join(__dirname, 'index.html');
    
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);

    // 备用内能网页（安全符号转义版）
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>助贷网销线索管理系统 - 云端异地实时同步版</title>

    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.staticfile.org/vue/3.3.4/vue.global.prod.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://cdn.staticfile.org/limonte-sweetalert2/11.7.12/sweetalert2.all.min.js"></script>
    <script src="https://cdn.staticfile.org/xlsx/0.18.5/xlsx.full.min.js"></script>
    <script src="/socket.io/socket.io.js"></script>

    <style>
        [v-cloak] { display: none !important; }
        body { background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .font-mono-tech { font-family: 'Consolas', 'Menlo', monospace; }
        @keyframes pulse-dot {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
            50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(16, 185, 129, 0); }
        }
        .pulse-dot { animation: pulse-dot 1.6s infinite; }
        .tech-card { transition: box-shadow .2s ease; }
        .tech-card:hover { box-shadow: 0 4px 16px rgba(37, 99, 235, 0.08); }
        .tech-topbar { position: relative; }
        .tech-topbar::before {
            content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
            background: linear-gradient(90deg, transparent, #60a5fa, #38bdf8, #60a5fa, transparent); z-index: 10;
        }
        .pg-btn {
            min-width: 2.1rem; height: 2.1rem; display: inline-flex; align-items: center; justify-content: center;
            border: 1px solid #e2e8f0; background: #fff; color: #475569; border-radius: 0.4rem; font-size: 0.8rem; transition: all .15s ease;
        }
        .pg-btn:hover:not(:disabled):not(.pg-ellipsis) { border-color: #3b82f6; color: #2563eb; background: #eff6ff; }
        .pg-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .pg-btn-active { background: #2563eb !important; color: #fff !important; font-weight: 700; border-color: #2563eb !important; }
        .pg-ellipsis { border-color: transparent; background: transparent; cursor: default; }
    </style>
</head>
<body class="text-slate-800 antialiased">
    <div id="app" v-cloak class="min-h-screen flex flex-col">
        <!-- 登录界面 -->
        <div v-if="!isLoggedIn" class="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-950 flex items-center justify-center p-4 w-full fixed inset-0 z-50">
            <div class="bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl max-w-md w-full p-8 border border-white/20 relative overflow-hidden tech-topbar">
                <div class="text-center mb-8">
                    <div class="inline-flex p-3 bg-blue-600/10 rounded-2xl text-blue-600 mb-3">
                        <i class="fa-solid fa-shield-halved text-4xl"></i>
                    </div>
                    <h2 class="text-2xl font-bold text-slate-800">助贷网销线索系统</h2>
                    <p class="text-xs text-slate-500 mt-1">全网异地实时云同步版</p>
                </div>
                <form @submit.prevent="handleLogin" class="space-y-4">
                    <div>
                        <label class="block text-xs font-semibold text-slate-600 mb-1">账号</label>
                        <div class="relative">
                            <i class="fa-solid fa-user absolute left-3 top-3 text-slate-400 text-sm"></i>
                            <input v-model.trim="loginForm.username" required type="text" placeholder="请输入账号" class="w-full bg-slate-50 border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm outline-none">
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-slate-600 mb-1">密码</label>
                        <div class="relative">
                            <i class="fa-solid fa-lock absolute left-3 top-3 text-slate-400 text-sm"></i>
                            <input v-model.trim="loginForm.password" required type="password" placeholder="请输入密码" class="w-full bg-slate-50 border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm outline-none">
                        </div>
                    </div>
                    <button type="submit" :disabled="isLoggingIn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg text-sm transition flex items-center justify-center">
                        <i v-if="!isLoggingIn" class="fa-solid fa-right-to-bracket mr-2"></i>
                        <i v-else class="fa-solid fa-spinner fa-spin mr-2"></i>
                        {{ isLoggingIn ? '登录验证中...' : '安全登录' }}
                    </button>
                </form>
            </div>
        </div>

        <!-- 主界面 -->
        <template v-else>
            <header class="bg-gradient-to-r from-blue-700 via-indigo-700 to-blue-800 text-white shadow-md sticky top-0 z-40 tech-topbar">
                <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between flex-wrap gap-2">
                    <div class="flex items-center space-x-3 cursor-pointer" @click="switchTab('pool')">
                        <div class="bg-white/20 p-2 rounded-lg"><i class="fa-solid fa-filter-circle-dollar text-yellow-300 text-xl"></i></div>
                        <span class="font-bold text-lg hidden sm:inline">助贷网销线索系统</span>
                    </div>

                    <nav class="flex space-x-1">
                        <button @click="switchTab('pool')" :class="currentTab === 'pool' ? 'bg-white/20 font-bold border-b-2 border-yellow-400' : 'opacity-80'" class="px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm flex items-center">
                            <i class="fa-solid fa-list-check mr-1.5"></i>公共线索池
                        </button>
                        <button @click="switchTab('user')" :class="currentTab === 'user' ? 'bg-white/20 font-bold border-b-2 border-yellow-400' : 'opacity-80'" class="px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm flex items-center">
                            <i class="fa-solid fa-user-gear mr-1.5"></i>个人中心
                        </button>
                        <button v-if="currentUser?.role === 'admin'" @click="switchTab('admin')" :class="currentTab === 'admin' ? 'bg-white/20 font-bold border-b-2 border-yellow-400' : 'opacity-80'" class="px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm flex items-center">
                            <i class="fa-solid fa-shield-halved mr-1.5 text-yellow-300"></i>管理员控制台
                        </button>
                    </nav>

                    <div class="flex items-center space-x-2 sm:space-x-3">
                        <div class="hidden lg:flex items-center text-xs px-3 py-1 rounded-full border bg-black/30 border-white/20 text-emerald-400 font-bold">
                            <i class="fa-solid fa-circle text-[8px] mr-1.5 pulse-dot"></i>异地毫秒同步中
                        </div>
                        <div class="flex items-center space-x-2 text-xs bg-black/20 px-3 py-1.5 rounded-full border border-white/10">
                            <span>账号: <strong class="text-white">{{ currentUser?.username }}</strong></span>
                            <span class="text-yellow-300 font-bold">| 余额: ¥{{ (currentUser?.balance || 0).toLocaleString() }}</span>
                        </div>
                        <button @click="logout" class="bg-red-500/80 hover:bg-red-600 text-white px-2.5 py-1 rounded text-xs font-medium">退出</button>
                    </div>
                </div>
            </header>

            <main class="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
                <!-- 1. 公共线索池 -->
                <div v-if="currentTab === 'pool'" class="space-y-6">
                    <div class="bg-white rounded-xl shadow-sm border p-5 tech-card">
                        <div class="flex justify-between items-center mb-4 pb-2 border-b font-bold text-slate-800">
                            <span><i class="fa-solid fa-magnifying-glass text-blue-600 mr-2"></i>线索筛选 (全部: <b class="text-blue-600">{{ leads?.length || 0 }}</b> 条 / 结果: <b class="text-amber-600">{{ filteredLeads?.length || 0 }}</b> 条)</span>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <input v-model.trim="filters.region" placeholder="按地区搜索" class="bg-slate-50 border rounded-lg px-3 py-2 text-sm outline-none">
                            <input v-model.trim="filters.phoneTail" placeholder="按手机尾号搜索" class="bg-slate-50 border rounded-lg px-3 py-2 text-sm outline-none">
                            <select v-model="filters.source" class="bg-slate-50 border rounded-lg px-3 py-2 text-sm outline-none">
                                <option value="">按全部来源搜索</option>
                                <option v-for="item in sourceList" :key="item.name" :value="item.name">{{ item.name }} (¥{{ item.price }})</option>
                                <option value="无">无</option>
                            </select>
                        </div>
                        <div class="flex justify-between items-center mt-4 pt-3 border-t flex-wrap gap-2">
                            <div class="flex space-x-2">
                                <button @click="batchExtract" :disabled="selectedLeadIds.length === 0 || isProcessing" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold">
                                    批量提取已选 ({{ selectedLeadIds.length }})
                                </button>
                                <button v-if="currentUser?.role === 'admin'" @click="batchDeleteLeads" :disabled="selectedLeadIds.length === 0 || isProcessing" class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold">
                                    批量彻底删除 ({{ selectedLeadIds.length }})
                                </button>
                            </div>
                            <button @click="resetFilters" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium">重置筛选</button>
                        </div>
                    </div>

                    <div class="bg-white rounded-xl shadow-sm border overflow-hidden tech-card">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left border-collapse text-sm">
                                <thead>
                                    <tr class="bg-slate-100 text-slate-600 border-b">
                                        <th class="p-3 text-center w-12"><input type="checkbox" @change="toggleSelectAll" :checked="isAllSelected"></th>
                                        <th class="p-3">姓名</th>
                                        <th class="p-3">性别</th>
                                        <th class="p-3">地区</th>
                                        <th class="p-3">来源</th>
                                        <th class="p-3">提取单价</th>
                                        <th class="p-3">电话号码 (明文/脱敏)</th>
                                        <th class="p-3">录入时间</th>
                                        <th class="p-3 text-center">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y">
                                    <tr v-for="lead in pagedLeads" :key="lead.id" class="hover:bg-blue-50/60">
                                        <td class="p-3 text-center"><input type="checkbox" v-model="selectedLeadIds" :value="lead.id" :disabled="currentUser?.role !== 'admin' && isUnlocked(lead.id)"></td>
                                        <td class="p-3 font-bold text-slate-700">{{ lead.name }}</td>
                                        <td class="p-3">{{ lead.gender }}</td>
                                        <td class="p-3">{{ lead.region }}</td>
                                        <td class="p-3"><span class="bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-100 text-xs font-medium">{{ lead.source }}</span></td>
                                        <td class="p-3 font-bold text-red-500 font-mono-tech">¥{{ lead.price }}</td>
                                        <td class="p-3 font-mono-tech">
                                            <span v-if="isUnlocked(lead.id) || currentUser?.role === 'admin'" class="text-emerald-600 font-bold bg-emerald-50 px-2 py-1 rounded"><i class="fa-solid fa-lock-open mr-1"></i>{{ lead.phone }}</span>
                                            <span v-else class="text-slate-400"><i class="fa-solid fa-lock mr-1"></i>{{ maskPhone(lead.phone) }}</span>
                                        </td>
                                        <td class="p-3 text-xs text-slate-400 font-mono-tech">{{ lead.create_time }}</td>
                                        <td class="p-3 text-center space-x-1 whitespace-nowrap">
                                            <button v-if="isUnlocked(lead.id) || currentUser?.role === 'admin'" @click="openLeadDetail(lead)" class="bg-slate-100 hover:bg-slate-200 px-3 py-1 rounded text-xs font-bold text-slate-700">查看详情</button>
                                            <button v-else @click="extractSingle(lead)" :disabled="isProcessing" class="bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1 rounded text-xs font-bold">购买提取 (扣¥{{ lead.price }})</button>
                                            <button v-if="currentUser?.role === 'admin'" @click="deleteSingleLead(lead)" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-2 py-1 rounded text-xs font-bold">删除</button>
                                        </td>
                                    </tr>
                                    <tr v-if="!filteredLeads || filteredLeads.length === 0">
                                        <td colspan="9" class="text-center py-10 text-slate-400">暂无相关线索数据</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div v-if="filteredLeads && filteredLeads.length > 0" class="flex flex-col md:flex-row items-center justify-between gap-3 px-4 py-3 border-t bg-slate-50/60 text-xs">
                            <div class="text-slate-500">共 <b>{{ filteredLeads.length }}</b> 条 · 每页 {{ pageSize }} 条 · 第 <b>{{ currentPage }}</b> / {{ totalPages }} 页</div>
                            <div class="flex items-center space-x-1">
                                <button @click="prevPage" :disabled="currentPage === 1" class="pg-btn"><i class="fa-solid fa-angle-left"></i></button>
                                <template v-for="(p, idx) in pageNumbers" :key="idx">
                                    <button v-if="p !== '...'" @click="goToPage(p)" :class="['pg-btn', currentPage === p ? 'pg-btn-active' : '']">{{ p }}</button>
                                    <span v-else class="pg-btn pg-ellipsis">...</span>
                                </template>
                                <button @click="nextPage" :disabled="currentPage === totalPages" class="pg-btn"><i class="fa-solid fa-angle-right"></i></button>
                            </div>
                            <div class="flex items-center space-x-2">
                                <span>跳转至</span>
                                <input v-model.number="jumpPage" @keyup.enter="jumpToPage" type="number" class="w-12 border rounded px-1 py-0.5 text-center">
                                <span>页</span>
                                <button @click="jumpToPage" class="bg-blue-600 text-white px-2 py-0.5 rounded font-bold">跳转</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 2. 管理员控制台 -->
                <div v-if="currentTab === 'admin' && currentUser?.role === 'admin'" class="space-y-6">
                    <div class="flex space-x-2 border-b pb-2">
                        <button @click="adminSubTab = 'import'" :class="adminSubTab === 'import' ? 'bg-blue-600 text-white font-bold' : 'bg-white text-slate-600'" class="px-4 py-2 rounded-lg text-sm">录入/WPS导入查重</button>
                        <button @click="adminSubTab = 'users'" :class="adminSubTab === 'users' ? 'bg-blue-600 text-white font-bold' : 'bg-white text-slate-600'" class="px-4 py-2 rounded-lg text-sm">子账号管控与充值</button>
                        <button @click="adminSubTab = 'history'" :class="adminSubTab === 'history' ? 'bg-blue-600 text-white font-bold' : 'bg-white text-slate-600'" class="px-4 py-2 rounded-lg text-sm">全员提取流水</button>
                    </div>

                    <div v-if="adminSubTab === 'import'" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div class="bg-white rounded-xl border p-5 tech-card">
                            <h3 class="font-bold mb-4 text-slate-800"><i class="fa-solid fa-pen-to-square text-blue-600 mr-2"></i>手动录入新线索 (自动查重)</h3>
                            <form @submit.prevent="addManualLead" class="space-y-3">
                                <div class="grid grid-cols-2 gap-3">
                                    <input v-model.trim="manualForm.name" placeholder="姓名 (选填)" class="border p-2 rounded text-sm outline-none">
                                    <select v-model="manualForm.gender" class="border p-2 rounded text-sm outline-none">
                                        <option value="男">男</option><option value="女">女</option><option value="无">无</option>
                                    </select>
                                </div>
                                <div class="grid grid-cols-2 gap-3">
                                    <input v-model.trim="manualForm.phone" required type="tel" placeholder="11位手机号 (必填)" class="border border-blue-400 p-2 rounded text-sm font-mono-tech outline-none">
                                    <input v-model.trim="manualForm.region" placeholder="地区 (选填)" class="border p-2 rounded text-sm outline-none">
                                </div>
                                <div class="grid grid-cols-2 gap-3">
                                    <div>
                                        <label class="block text-xs text-slate-500 mb-1">选择数据来源</label>
                                        <select v-model="manualForm.source" @change="onSourceChange" class="w-full border p-2 rounded text-sm font-semibold outline-none">
                                            <option v-for="item in sourceList" :key="item.name" :value="item.name">{{ item.name }} (¥{{ item.price }})</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label class="block text-xs text-slate-500 mb-1">提取单价(元)</label>
                                        <input v-model.number="manualForm.price" required type="number" class="w-full border p-2 rounded text-sm font-bold text-red-500 font-mono-tech outline-none">
                                    </div>
                                </div>
                                <button type="submit" :disabled="isProcessing" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-bold">提交并全网实时广播</button>
                            </form>
                        </div>

                        <div class="bg-white rounded-xl border p-5 tech-card">
                            <h3 class="font-bold mb-2 text-slate-800"><i class="fa-solid fa-file-excel text-emerald-600 mr-2"></i>批量导入 WPS / Excel (.xlsx)</h3>
                            <p class="text-xs text-slate-500 mb-4">💡 <b>提示：</b>表格仅需提供手机号列（表头叫\`电话\`、\`手机号\`等即可），自动去重。</p>
                            <div class="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center relative hover:bg-slate-50 cursor-pointer">
                                <input type="file" @change="handleFileUpload" accept=".xlsx, .xls" class="absolute inset-0 opacity-0 cursor-pointer">
                                <i class="fa-solid fa-cloud-arrow-up text-4xl text-slate-400 mb-2"></i>
                                <p class="text-sm text-slate-600 font-medium">点击上传或将 Excel 文件拖拽到此处</p>
                            </div>
                        </div>
                    </div>

                    <div v-if="adminSubTab === 'users'" class="bg-white rounded-xl border p-5 tech-card">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="font-bold text-slate-800">子账号控制与充值</h3>
                            <button @click="createNewSubAccount" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold">开通新子账号</button>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left border-collapse text-sm">
                                <thead>
                                    <tr class="bg-slate-100 border-b text-slate-600">
                                        <th class="p-3">账号</th><th class="p-3">密码</th><th class="p-3">余额</th><th class="p-3">访问权限</th><th class="p-3">提取权限</th><th class="p-3 text-center">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y">
                                    <tr v-for="user in users" :key="user.id">
                                        <td class="p-3 font-bold">{{ user.username }} <span v-if="user.role==='admin'" class="text-xs text-amber-600 bg-amber-50 px-1 rounded border">主账号</span></td>
                                        <td class="p-3"><span @click="adminChangeSubPassword(user)" class="cursor-pointer text-blue-600 font-bold font-mono-tech">{{ user.password }} <i class="fa-solid fa-pen text-xs"></i></span></td>
                                        <td class="p-3 font-bold text-amber-600 font-mono-tech">¥{{ (user.balance || 0).toLocaleString() }}</td>
                                        <td class="p-3"><input type="checkbox" v-model="user.can_access" :disabled="user.role==='admin'" @change="updateUserPerm(user)"></td>
                                        <td class="p-3"><input type="checkbox" v-model="user.can_extract" :disabled="user.role==='admin'" @change="updateUserPerm(user)"></td>
                                        <td class="p-3 text-center"><button v-if="user.role!=='admin'" @click="adminRechargeUser(user)" class="bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-1 rounded text-xs font-bold">充值/扣款</button></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div v-if="adminSubTab === 'history'" class="bg-white rounded-xl border p-5 tech-card">
                        <h3 class="font-bold mb-4 text-slate-800">全员线索提取与交易历史流水</h3>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left border-collapse text-sm">
                                <thead>
                                    <tr class="bg-slate-100 border-b text-slate-600"><th class="p-3">流水号</th><th class="p-3">账号</th><th class="p-3">客户</th><th class="p-3">电话</th><th class="p-3">扣费</th><th class="p-3">提取时间</th></tr>
                                </thead>
                                <tbody class="divide-y">
                                    <tr v-for="log in purchaseLogs" :key="log.id">
                                        <td class="p-3 font-mono-tech text-xs text-slate-400">{{ log.id }}</td>
                                        <td class="p-3 font-bold text-blue-600">{{ log.username }}</td>
                                        <td class="p-3 font-bold">{{ log.lead_name || '无' }}</td>
                                        <td class="p-3 font-mono-tech text-emerald-600 font-bold">{{ log.phone }}</td>
                                        <td class="p-3 font-bold text-red-500 font-mono-tech">¥{{ log.price }}</td>
                                        <td class="p-3 text-xs text-slate-400 font-mono-tech">{{ log.time }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- 3. 个人中心 -->
                <div v-if="currentTab === 'user'" class="bg-white rounded-xl border p-5 tech-card">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-bold text-slate-800">我的已提取线索 (完整明文)</h3>
                        <button @click="exportMyLeads" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center"><i class="fa-solid fa-file-export mr-1"></i>导出已提取 Excel</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse text-sm">
                            <thead>
                                <tr class="bg-slate-100 border-b text-slate-600"><th class="p-3">姓名</th><th class="p-3">明文电话</th><th class="p-3">地区</th><th class="p-3">来源</th><th class="p-3">花费</th></tr>
                            </thead>
                            <tbody class="divide-y">
                                <tr v-for="lead in myUnlockedLeads" :key="lead.id">
                                    <td class="p-3 font-bold text-slate-700">{{ lead.name }}</td>
                                    <td class="p-3 font-mono-tech font-bold text-emerald-600 bg-emerald-50 rounded px-2">{{ lead.phone }}</td>
                                    <td class="p-3">{{ lead.region }}</td>
                                    <td class="p-3 text-xs"><span class="bg-blue-50 text-blue-600 px-2 py-0.5 rounded border border-blue-100">{{ lead.source }}</span></td>
                                    <td class="p-3 text-red-500 font-bold font-mono-tech">¥{{ lead.price }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </template>
    </div>

    <script>
        const socket = io();

        const app = Vue.createApp({
            data() {
                return {
                    isLoggedIn: false,
                    isLoggingIn: false,
                    isProcessing: false,
                    currentUser: null,
                    loginForm: { username: 'admin', password: 'admin888' },
                    currentTab: 'pool',
                    adminSubTab: 'import',
                    selectedLeadIds: [],
                    filters: { region: '', phoneTail: '', source: '' },
                    currentPage: 1, pageSize: 10, jumpPage: '',
                    sourceList: [
                        { name: 'GR-抖音投放', price: 55 }, { name: 'GR-百度推广', price: 35 }, { name: 'GR-抖音信息流', price: 85 },
                        { name: 'GR-平安进审', price: 5 }, { name: 'GR-南银法巴进审', price: 5 }, { name: 'GR-工行进审', price: 5 },
                        { name: 'GR-⭐银行大模型申请', price: 3 }, { name: 'GR-⭐消金大模型申请', price: 3 }, { name: 'GR-⭐网贷大模型申请', price: 3 },
                        { name: 'GR-⭐CRM-高星数据', price: 3 }, { name: 'GR-⭐CRM-乐数云', price: 3 }, { name: 'GR-CRM-91', price: 3 },
                        { name: 'GR-CRM-银标', price: 3 }, { name: 'GR-CRM-老站', price: 3 }, { name: 'GR-CRM-云象', price: 3 },
                        { name: 'GR-⭐融360', price: 65 }, { name: 'GR-⭐CRM-车贷车主融', price: 15 }, { name: 'GR-⭐消金纯下全格式', price: 5 },
                        { name: 'GR-⭐网贷纯下全格式', price: 5 }, { name: 'GR-⭐借条', price: 13 }, { name: 'GR-⭐商城申下', price: 8 },
                        { name: 'GR-银行混台被拒', price: 4 }, { name: 'GR-网贷混合申请', price: 3 }
                    ],
                    manualForm: { name: '', gender: '男', phone: '', region: '', source: 'GR-抖音投放', price: 55 },
                    users: [], leads: [], purchaseLogs: []
                }
            },
            computed: {
                filteredLeads() {
                    if (!Array.isArray(this.leads)) return [];
                    const regFilter = (this.filters.region || '').trim().toLowerCase();
                    const phoneFilter = (this.filters.phoneTail || '').trim();
                    const sourceFilter = this.filters.source || '';
                    return this.leads.filter(item => {
                        if (!item) return false;
                        const matchRegion = !regFilter || String(item.region || '').toLowerCase().includes(regFilter);
                        const matchPhone = !phoneFilter || String(item.phone || '').endsWith(phoneFilter);
                        const matchSource = !sourceFilter || String(item.source || '') === sourceFilter;
                        return matchRegion && matchPhone && matchSource;
                    });
                },
                pagedLeads() {
                    const start = (this.currentPage - 1) * this.pageSize;
                    return this.filteredLeads.slice(start, start + this.pageSize);
                },
                totalPages() { return Math.max(1, Math.ceil(this.filteredLeads.length / this.pageSize)); },
                pageNumbers() {
                    const total = this.totalPages, current = this.currentPage;
                    if (total <= 1) return [1];
                    const range = [];
                    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) range.push(i);
                    if (current - 1 > 2) range.unshift('...');
                    if (current + 1 < total - 1) range.push('...');
                    range.unshift(1);
                    if (total > 1) range.push(total);
                    return range;
                },
                isAllSelected() {
                    if (!Array.isArray(this.pagedLeads) || this.pagedLeads.length === 0) return false;
                    const selectable = this.pagedLeads.filter(l => this.currentUser?.role === 'admin' || !this.isUnlocked(l.id));
                    return selectable.length > 0 && selectable.every(l => this.selectedLeadIds.includes(l.id));
                },
                myUnlockedLeads() {
                    if (!this.currentUser) return [];
                    const curUser = String(this.currentUser.username || '').trim();
                    const unlockedSet = new Set(this.purchaseLogs.filter(l => String(l.username || '').trim() === curUser).map(l => String(l.lead_id)));
                    return this.leads.filter(lead => unlockedSet.has(String(lead.id)));
                }
            },
            watch: { filters: { deep: true, handler() { this.currentPage = 1; } } },
            created() {
                this.checkLocalSession();
                if (this.isLoggedIn) this.fetchAllData();
                socket.on('realtime-db-update', () => this.fetchAllData());
            },
            methods: {
                checkLocalSession() {
                    try {
                        const saved = localStorage.getItem('loan_system_user');
                        if (saved) { this.currentUser = JSON.parse(saved); this.isLoggedIn = true; }
                    } catch (e) { localStorage.removeItem('loan_system_user'); }
                },
                switchTab(tab) { this.currentTab = tab; },
                onSourceChange() {
                    const found = this.sourceList.find(s => s.name === this.manualForm.source);
                    this.manualForm.price = found ? found.price : 20;
                },
                fetchAllData() {
                    socket.emit('fetch-all-data', (data) => {
                        this.users = data.users || [];
                        this.leads = data.leads || [];
                        this.purchaseLogs = data.purchaseLogs || [];
                        if (this.currentUser) {
                            const me = this.users.find(u => u.username === this.currentUser.username);
                            if (me) {
                                if (!me.can_access || me.status === 'banned') { this.logout(); return; }
                                this.currentUser = me;
                                localStorage.setItem('loan_system_user', JSON.stringify(me));
                            }
                        }
                    });
                },
                handleLogin() {
                    this.isLoggingIn = true;
                    socket.emit('login', this.loginForm, (res) => {
                        this.isLoggingIn = false;
                        if (!res.success) return Swal.fire('登录失败', res.message, 'error');
                        this.currentUser = res.user; this.isLoggedIn = true;
                        localStorage.setItem('loan_system_user', JSON.stringify(res.user));
                        this.fetchAllData();
                    });
                },
                logout() { this.isLoggedIn = false; this.currentUser = null; localStorage.removeItem('loan_system_user'); },
                maskPhone(phone) { return phone ? String(phone).replace(/(\\d{3})\\d{4}(\\d{4})/, '\$1****\$2') : ''; },
                isUnlocked(leadId) {
                    if (!this.currentUser) return false;
                    const curUser = String(this.currentUser.username).trim();
                    return this.purchaseLogs.some(log => String(log.username).trim() === curUser && String(log.lead_id) === String(leadId));
                },
                openLeadDetail(lead) {
                    Swal.fire({
                        title: '客户: ' + lead.name,
                        html: '<div class="text-left text-sm space-y-2"><p><b>电话：</b><span class="text-emerald-600 font-bold font-mono-tech">' + lead.phone + '</span></p><p><b>地区：</b>' + lead.region + '</p><p><b>来源：</b>' + lead.source + '</p></div>',
                        icon: 'info'
                    });
                },
                extractSingle(lead) {
                    Swal.fire({ title: '确认购买线索？', text: '扣除余额 ¥' + lead.price, icon: 'question', showCancelButton: true }).then((r) => {
                        if (r.isConfirmed) {
                            socket.emit('extract-leads', { userId: this.currentUser.id, targetLeads: [lead] }, (res) => {
                                if (res.success) { this.currentUser.balance = res.newBalance; Swal.fire('提取成功', '', 'success'); }
                                else Swal.fire('提取失败', res.message, 'error');
                            });
                        }
                    });
                },
                batchExtract() {
                    const targetLeads = this.leads.filter(l => this.selectedLeadIds.includes(l.id) && !this.isUnlocked(l.id));
                    if (targetLeads.length === 0) return Swal.fire('提示', '线索已解锁过', 'info');
                    Swal.fire({ title: '批量提取 ' + targetLeads.length + ' 条线索', icon: 'warning', showCancelButton: true }).then((r) => {
                        if (r.isConfirmed) {
                            socket.emit('extract-leads', { userId: this.currentUser.id, targetLeads }, (res) => {
                                if (res.success) { this.currentUser.balance = res.newBalance; this.selectedLeadIds = []; Swal.fire('提取成功', '', 'success'); }
                                else Swal.fire('失败', res.message, 'error');
                            });
                        }
                    });
                },
                addManualLead() {
                    socket.emit('add-manual-lead', this.manualForm, (res) => {
                        if (res.success) { Swal.fire('成功', '', 'success'); this.manualForm.phone = ''; }
                        else Swal.fire('查重拦截', res.message, 'warning');
                    });
                },
                handleFileUpload(e) {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                        const data = new Uint8Array(evt.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });
                        const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
                        let insertList = [];
                        json.forEach(row => {
                            const p = row['电话'] || row['手机号'] || row['phone'];
                            if (p && String(p).replace(/\\D/g, '').length === 11) {
                                insertList.push({ name: row['姓名']||'无', phone: String(p).replace(/\\D/g, ''), region: row['地区']||'无', source: row['来源']||'WPS导入', price: Number(row['单价']||20) });
                            }
                        });
                        socket.emit('add-batch-leads', insertList, (res) => {
                            Swal.fire('导入完成', '新导入 ' + res.addedCount + ' 条，重复拦截 ' + res.duplicateCount + ' 条', 'success');
                            e.target.value = '';
                        });
                    };
                    reader.readAsArrayBuffer(file);
                },
                batchDeleteLeads() {
                    socket.emit('delete-leads', this.selectedLeadIds, () => { this.selectedLeadIds = []; Swal.fire('已删除', '', 'success'); });
                },
                deleteSingleLead(lead) { socket.emit('delete-leads', [lead.id], () => Swal.fire('已删除', '', 'success')); },
                createNewSubAccount() {
                    Swal.fire({
                        title: '开通新子账号',
                        html: '<input id="u" class="swal2-input" placeholder="账号"><input id="p" class="swal2-input" placeholder="密码"><input id="b" type="number" class="swal2-input" placeholder="余额" value="0">',
                        showCancelButton: true,
                        preConfirm: () => [document.getElementById('u').value, document.getElementById('p').value, document.getElementById('b').value]
                    }).then((r) => {
                        if (r.isConfirmed) {
                            socket.emit('create-user', { username: r.value[0], password: r.value[1], balance: r.value[2] }, (res) => {
                                if (res.success) Swal.fire('创建成功', '', 'success');
                                else Swal.fire('失败', res.message, 'error');
                            });
                        }
                    });
                },
                adminChangeSubPassword(user) {
                    Swal.fire({ title: '修改密码', input: 'text', inputValue: user.password, showCancelButton: true }).then((r) => {
                        if (r.isConfirmed) socket.emit('update-user-field', { userId: user.id, updateData: { password: r.value } });
                    });
                },
                updateUserPerm(user) { socket.emit('update-user-field', { userId: user.id, updateData: { can_access: user.can_access, can_extract: user.can_extract } }); },
                adminRechargeUser(user) {
                    Swal.fire({ title: '变动余额', input: 'number', showCancelButton: true }).then((r) => {
                        if (r.isConfirmed) socket.emit('update-user-field', { userId: user.id, updateData: { balance: (user.balance||0) + Number(r.value) } });
                    });
                },
                exportMyLeads() {
                    const data = this.myUnlockedLeads.map(l => ({ '姓名': l.name, '明文电话': l.phone, '地区': l.region, '来源': l.source, '单价': l.price }));
                    XLSX.writeFile(XLSX.utils.book_new(), '已提取线索_' + new Date().toLocaleDateString() + '.xlsx');
                },
                resetFilters() { this.filters = { region: '', phoneTail: '', source: '' }; },
                toggleSelectAll(e) {
                    if (e.target.checked) this.selectedLeadIds = this.pagedLeads.map(l => l.id);
                    else this.selectedLeadIds = [];
                },
                prevPage() { if (this.currentPage > 1) this.currentPage--; },
                nextPage() { if (this.currentPage < this.totalPages) this.currentPage++; },
                goToPage(p) { this.currentPage = p; },
                jumpToPage() { if (this.jumpPage >= 1 && this.jumpPage <= this.totalPages) this.currentPage = Number(this.jumpPage); }
            }
        });

        app.mount('#app');
    </script>
</body>
</html>
    `);
});

io.on('connection', (socket) => {
    socket.on('login', ({ username, password }, callback) => {
        const user = db.users.find(u => u.username === username && u.password === password);
        if (!user) return callback({ success: false, message: '账号或密码错误！' });
        if (!user.can_access || user.status === 'banned') {
            return callback({ success: false, message: '账号已被禁用！' });
        }
        callback({ success: true, user });
    });

    socket.on('fetch-all-data', (callback) => {
        callback({ users: db.users, leads: db.leads, purchaseLogs: db.purchaseLogs });
    });

    socket.on('add-manual-lead', (leadData, callback) => {
        const cleanPhone = String(leadData.phone).trim();
        const exist = db.leads.some(l => String(l.phone).trim() === cleanPhone);
        if (exist) {
            return callback({ success: false, message: `手机号 ${cleanPhone} 已存在！` });
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

    socket.on('add-batch-leads', (insertList, callback) => {
        let added = 0;
        let dup = 0;
        const existingPhones = new Set(db.leads.map(l => String(l.phone).trim()));

        insertList.forEach(item => {
            const cleanPhone = String(item.phone).trim();
            if (existingPhones.has(cleanPhone)) {
                dup++;
            } else {
                existingPhones.add(cleanPhone);
                db.leads.unshift({
                    id: 'lead_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
                    name: item.name || '无',
                    gender: item.gender || '无',
                    phone: cleanPhone,
                    region: item.region || '无',
                    source: item.source || 'WPS批量导入',
                    price: Number(item.price) || 20,
                    create_time: new Date().toLocaleString()
                });
                added++;
            }
        });

        io.emit('realtime-db-update');
        callback({ success: true, addedCount: added, duplicateCount: dup });
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
