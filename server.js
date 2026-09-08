const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const OpenAI = require('openai');
require('dotenv').config({ path: path.join(__dirname, '.env') });

process.on('uncaughtException', (e) => console.error('[FATAL] uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (r) => console.error('[FATAL] unhandledRejection:', r && r.stack || r));

const PORT = process.env.PORT || 5202;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev_encryption_key_32b';
const DATA_DIR = path.join(__dirname, 'data', 'users');
const TOKEN_EXPIRY = '30d';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ============================================================
//  工具函数
// ============================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  // 写前备份
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.backup'); } catch {}
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function encrypt(text) {
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(combined) {
  try {
    const [ivHex, encHex] = combined.split(':');
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch { return null; }
}

function userDir(uid) { return path.join(DATA_DIR, uid); }
function profilePath(uid) { return path.join(userDir(uid), 'profile.json'); }
function dayPath(uid, date) { return path.join(userDir(uid), date + '.json'); }
function tasksPath(uid) { return path.join(userDir(uid), 'tasks.json'); }
function diaryPath(uid) { return path.join(userDir(uid), 'diary.json'); }
function weeklyReportsPath(uid) { return path.join(userDir(uid), 'weekly_reports.json'); }

function loadProfile(uid) { return readJSON(profilePath(uid)); }
function saveProfile(uid, data) { writeJSON(profilePath(uid), data); }
function loadDay(uid, date) { return readJSON(dayPath(uid, date), { date, records: [], chat: [] }); }
function saveDay(uid, date, data) { writeJSON(dayPath(uid, date), data); }

// 加载多天的 records 和 chat（用于构建 AI 上下文）
function loadMultiDayContext(uid, targetDate) {
  const records = {};
  const chats = {};
  const userD = userDir(uid);
  if (!fs.existsSync(userD)) return { records, chats };

  // 收集 targetDate 前后各 1 天 + 最近有数据的 3 天（只认日期格式文件，排除 diary/weekly 等非日期 json）
  const allDates = fs.readdirSync(userD)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort().reverse();

  const relevant = new Set();
  relevant.add(targetDate);
  const idx = allDates.indexOf(targetDate);
  if (idx >= 0) {
    if (idx > 0) relevant.add(allDates[idx - 1]);
    if (idx < allDates.length - 1) relevant.add(allDates[idx + 1]);
  }
  allDates.slice(0, 3).forEach(d => relevant.add(d));

  for (const d of relevant) {
    const day = loadDay(uid, d);
    if (day.records.length) records[d] = day.records;
    if (day.chat.length) chats[d] = day.chat;
  }
  return { records, chats };
}

// ============================================================
//  Auth 中间件
// ============================================================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch { res.status(401).json({ error: '登录过期，请重新登录' }); }
}

// ============================================================
//  Auth API
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名 2-20 个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });

  // 检查用户名是否已存在（遍历所有用户目录）
  if (fs.existsSync(DATA_DIR)) {
    for (const uid of fs.readdirSync(DATA_DIR)) {
      const p = readJSON(profilePath(uid));
      if (p && p.username === username) return res.status(400).json({ error: '用户名已存在' });
    }
  }

  const userId = 'u' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const passwordHash = await bcrypt.hash(password, 10);
  saveProfile(userId, { username, passwordHash, apiKey: null, createdAt: Date.now() });

  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token, user: { id: userId, username, hasApiKey: false } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  // 查找用户
  let foundUser = null, foundId = null;
  if (fs.existsSync(DATA_DIR)) {
    for (const uid of fs.readdirSync(DATA_DIR)) {
      const p = readJSON(profilePath(uid));
      if (p && p.username === username) { foundUser = p; foundId = uid; break; }
    }
  }
  if (!foundUser) return res.status(401).json({ error: '用户名或密码错误' });

  const valid = await bcrypt.compare(password, foundUser.passwordHash);
  if (!valid) return res.status(401).json({ error: '用户名或密码错误' });

  const token = jwt.sign({ userId: foundId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token, user: { id: foundId, username, hasApiKey: !!foundUser.apiKey } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const p = loadProfile(req.userId);
  if (!p) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: { id: req.userId, username: p.username, hasApiKey: !!p.apiKey } });
});

// API Key 管理
app.put('/api/auth/apikey', auth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey 不能为空' });
  const p = loadProfile(req.userId);
  if (!p) return res.status(404).json({ error: '用户不存在' });
  p.apiKey = encrypt(apiKey);
  saveProfile(req.userId, p);
  res.json({ ok: true });
});

app.delete('/api/auth/apikey', auth, (req, res) => {
  const p = loadProfile(req.userId);
  if (!p) return res.status(404).json({ error: '用户不存在' });
  p.apiKey = null;
  saveProfile(req.userId, p);
  res.json({ ok: true });
});

// ============================================================
//  每日数据 API
// ============================================================
// 睡眠记录缺 sleepType 时的自动归类守卫：跨天/夜间→main，午间短睡→nap，兜底 main
function classifySleepByTime(r) {
  const toMin = (s) => {
    if (!s || typeof s !== 'string') return NaN;
    const p = s.split(':').map(Number);
    return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? p[0] * 60 + p[1] : NaN;
  };
  const st = toMin(r.start);
  const en = toMin(r.end);
  if (isNaN(st)) return 'main';
  if (isNaN(en)) {
    // 只有开始时间（如"躺下""睡不着"进行中）：20点后/凌晨入睡按主睡眠，午后按午休
    if (st >= 20 * 60 || st < 4 * 60) return 'main';
    if (st >= 12 * 60 && st <= 17 * 60) return 'nap';
    return 'main';
  }
  if (st >= en) return 'main'; // 跨天（如 22:30-08:00）
  const dur = en - st;
  const mid = st + dur / 2;
  // 午间带 12:00-17:30、时长 ≤4h 的短睡 → 午休
  if (dur <= 240 && mid >= 12 * 60 && mid <= 17 * 60 + 30) return 'nap';
  return 'main';
}
function ensureSleepType(records) {
  for (const r of records) {
    if (r && r.dimension === 'sleep' && !r.sleepType) r.sleepType = classifySleepByTime(r);
  }
  return records;
}

app.get('/api/day/:date', auth, (req, res) => {
  const day = loadDay(req.userId, req.params.date);
  res.json(day);
});

// 标记某条 chat 消息的动作是否已在前端执行（刷新后据此重放未执行的操作）
app.post('/api/chat-applied', auth, (req, res) => {
  const { date, index, applied } = req.body;
  const day = loadDay(req.userId, date);
  const msg = day.chat && day.chat[index];
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  msg.applied = !!applied;
  saveDay(req.userId, date, day);
  res.json({ ok: true });
});

// 覆盖某天的聊天记录（clear_context 用：真正清空服务端对话）
app.post('/api/chat/:date', auth, (req, res) => {
  const { chat } = req.body;
  const day = loadDay(req.userId, req.params.date);
  day.chat = Array.isArray(chat) ? chat : [];
  saveDay(req.userId, req.params.date, day);
  res.json({ ok: true });
});

app.post('/api/day/:date', auth, (req, res) => {
  const { records, deletedIds } = req.body;
  const existing = loadDay(req.userId, req.params.date);
  let merged;
  if (Array.isArray(records)) {
    const incomingIds = new Set(records.map(r => r.id));
    const toDelete = new Set(deletedIds || []);
    const kept = (existing.records || []).filter(r => !incomingIds.has(r.id) && !toDelete.has(r.id));
    merged = [...kept, ...records];
  } else {
    merged = existing.records;
  }
  merged = ensureSleepType(merged);
  const data = {
    date: req.params.date,
    records: merged,
    chat: existing.chat,
  };
  saveDay(req.userId, req.params.date, data);
  res.json({ ok: true });
});

// 手写日记（按日期存取；无参数 POST = 全量合并，用于一次性迁移）
app.get('/api/diary', auth, (req, res) => {
  const diaries = readJSON(diaryPath(req.userId), {});
  res.json({ diaries });
});

app.post('/api/diary', auth, (req, res) => {
  const incoming = req.body.diaries || {};
  const diaries = readJSON(diaryPath(req.userId), {});
  for (const [date, text] of Object.entries(incoming)) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed) diaries[date] = trimmed;
  }
  writeJSON(diaryPath(req.userId), diaries);
  res.json({ ok: true });
});

app.post('/api/diary/:date', auth, (req, res) => {
  const { text } = req.body;
  const diaries = readJSON(diaryPath(req.userId), {});
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed) diaries[req.params.date] = trimmed;
  else delete diaries[req.params.date];
  writeJSON(diaryPath(req.userId), diaries);
  res.json({ ok: true });
});

// 周报缓存（按周一日期存取；无参数 POST = 全量合并，用于一次性迁移）
app.get('/api/weekly-reports', auth, (req, res) => {
  const reports = readJSON(weeklyReportsPath(req.userId), {});
  res.json({ reports });
});

app.post('/api/weekly-reports', auth, (req, res) => {
  const incoming = req.body.reports || {};
  const reports = readJSON(weeklyReportsPath(req.userId), {});
  for (const [monday, report] of Object.entries(incoming)) {
    if (report && report.work) reports[monday] = report;
  }
  writeJSON(weeklyReportsPath(req.userId), reports);
  res.json({ ok: true });
});

app.post('/api/weekly-reports/:monday', auth, (req, res) => {
  const { work, life, generatedAt } = req.body;
  const reports = readJSON(weeklyReportsPath(req.userId), {});
  reports[req.params.monday] = { work, life, generatedAt: generatedAt || Date.now() };
  writeJSON(weeklyReportsPath(req.userId), reports);
  res.json({ ok: true });
});

app.get('/api/day-range', auth, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: '缺少 from/to 参数' });
  const dir = userDir(req.userId);
  const records = [];
  let d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    const dateStr = d.toISOString().slice(0, 10);
    const day = loadDay(req.userId, dateStr);
    if (day.records.length) records.push(...day.records);
    d.setDate(d.getDate() + 1);
  }
  res.json({ records });
});

app.get('/api/days', auth, (req, res) => {
  const dir = userDir(req.userId);
  const days = {};
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .forEach(f => {
        const date = f.replace('.json', '');
        days[date] = loadDay(req.userId, date);
      });
  }
  res.json({ days });
});

// ============================================================
//  任务 API
// ============================================================
app.get('/api/tasks', auth, (req, res) => {
  const data = readJSON(tasksPath(req.userId), { tasks: [], done: [] });
  res.json(data);
});

app.post('/api/tasks', auth, (req, res) => {
  const { tasks, done } = req.body;
  writeJSON(tasksPath(req.userId), { tasks: tasks || [], done: done || [] });
  res.json({ ok: true });
});

// ============================================================
//  AI 聊天 API
// ============================================================
const 对话提示词 = `# 时间记录助手 v6

## ⚠️ 核心规则（优先级从高到低）

1. **reply 与 JSON 必须一致。** reply 里提到改了什么/删了什么，JSON 里必须有对应的 update/delete。这是最重要的规则，任何情况下都不准违反。
2. 不编造数据。用户没说的时间、活动不脑补。不确定就 ask。
3. update/delete 必须带 id。id 从已有记录列表中找。
4. 级联调整：改某条记录 end → 后面紧挨着的记录的 start 同步调整（在同一个 batch 里同时 update 两条）。
5. 活动名称精简："穿衣准备出门"→"穿衣"，"开会讨论了项目"→"开会"。
6. 吃饭相关（热饭、做饭、吃饭、午饭、晚饭）归并为"吃饭"，不要带修饰词。洗碗、打扫等家务单独记录，不和吃饭合并。
7. 同一人同时说吃饭+洗碗 → 拆分两条记录，时间各占一半或按常识估计。

## 追问的停止规则（重要，优先级仅次于规则1）

你追问某个信息后，用户可能不直接回答，而是表示「现在答不了/还在进行中/等会儿告诉你/先不管这个」。**只要用户表达了「当前给不了答案」的意图，就立刻停止追问这个点。**

常见停止信号：「进行中，结束了告诉你」「还在进行中」「一会说」「等下」「先不管」「还没弄完」「醒了告诉你」「不记得了」。关键是识别意图，不死抠字面。

此时：
- 如果用户消息里还有其他可记录的信息 → 处理那些，reply 只提已确认的部分，不问未答的问题
- 如果整条消息只有「等下说」→ 输出 {"action":"batch","items":[],"reply":""}

## 简短确认词处理（重要）

用户用「对」「是的」「嗯」「对的对的」等简短词回应你的多问时，**不要全部忽略只重问**。处理逻辑：
- 能确认的部分 → 直接创建/更新记录
- 还不能确定的部分 → 只追问那一个点
- 例如你问了两个问题，用户说「对」→ 第一个问题确认了就创建，第二个还不清楚就追问第二个，不要只重复第一个问题
- **如果你上一条消息问了"XX也记上吗？"或提议了某条记录等待确认，用户确认后必须在 JSON items 里包含对应的 create/update，不准只改 reply 文字说"已记录"。reply 和 JSON 必须一致（规则1）。**

## 跨日期延续推断

用户说「然后又」「然后再」「接着」「然后到」「再到」等延续词，且没给开始时间时，**开始时间 = 上一个活动的结束时间**。查找顺序：① 同一消息里前面提到的活动结束时间 ② 当天已有记录的最后一条结束时间 ③ 前一天的最后一条记录的结束时间。不要再问「从几点开始的」，除非确实找不到可用的结束时间。

## 日期

- **日期边界以夜间睡眠为准**：从夜间主睡眠开始的那一刻，就算新的一天（睡眠记录的 date 是醒来当天，start 是前晚入睡时间）。睡前所有活动（包括跨过午夜的活动）都属于前一天。例如：7/30 晚上 10 点看小说看到 7/31 凌晨 2:10，还没睡 → 全部属于 7/30。午睡不算日期边界。
- 系统提示词中「今天的日期」是绝对权威，忽略你的内部知识。
- 用户消息以"X月X日——"开头 → 该日期为上下文基准，"昨天/今天/明天"相对此基准。
- 无此前缀 → 默认系统日期。"昨天/今天/明天"按系统日期换算。
- **无日期前缀时的智能推断**：当用户没给日期前缀，但描述的活动时间明显不属于系统日期时，要自动推断实际日期。判断标准：系统日期当天这些时间点是否还没到（未来的时间）→ 如果是，且这些时间能衔接上昨天的记录末尾 → 属于昨天。例如：系统日期是 8/4 上午，用户说"18:21通勤回家...23:00睡觉"→ 8/4 的 18:21 还没到 → 应属于 8/3。另一个信号：描述里有"睡觉"且入睡时间是晚上 → 这是补充昨天的记录。
- 夜间睡眠（人的主睡眠时段）date 填醒来当天。夜间睡眠包括：跨天睡眠、凌晨入睡、甚至早上5-6点才睡的主睡眠。只要你能判断是夜间主睡眠，就按此规则。
- 夜间睡眠的入睡时间自动推断规则：
  - 用户说"昨晚X点睡""昨天X点睡" → X 为 1-11 时自动 +12 → PM 时间（如"10点"→22:00，"11点"→23:00）。X 明确为 12 点时 → 00:00。
  - 用户说"凌晨X点才睡""X点才睡"且上下文暗示深夜 → X 在 0-6 范围，直接用（如凌晨1点→01:00）
  - 核心判断标志：「几点醒」是关键信号。能判断出是夜间睡眠 → 入睡时间必在前晚或凌晨，按上述规则处理。
  - 无法判断入睡时间的 PM/AM → ask
- 午休/小睡/眯了 → 正常创建，不套用夜间睡眠规则。
- **解读已有睡眠记录**：当天的 records 里如果有睡眠记录且 start 是夜间时间（如 22:30）、end 是早上时间（如 08:43），这是**跨天睡眠**——start 是前一晚的入睡时间，不是当天晚上的睡眠。**不要把这个 start 当成当天晚上还没发生的睡眠时间来追问。**
- 睡眠相关(睡觉、醒了、眯了、午休、躺下、回笼觉)必须创建记录，不能忽略。
- 睡眠无醒来时间 → 追问（但含「准备」「打算」「一会儿」「等下」等将来词时不追问）。
- **睡眠记录必须带 sleepType 字段**：夜间主睡眠（包括跨天睡眠、凌晨入睡）→ sleepType: \"main\"。午休/小睡/眯了/回笼觉 → sleepType: \"nap\"。每次 create 睡眠记录都必须写 sleepType。

## 分类

- 工作：兑换经济价值
- 生活-身体：肉体/生理层面，维持身体基本运转和健康
- 生活-精神：心理层面，放松愉悦精神
- 成长：自我提升

## 维度

六大维度是分类下的细分关注点。**核心：以行为目的为判断标准，不看关键词。**

sleep(睡眠) → 生活-身体。目的是试图入睡/休息。有效/无效睡眠。
body(身体运营) → 生活-身体。目的是肉体/生理层面的运转和健康。
spirit(精神放松) → 生活-精神。目的是心理层面的放松愉悦。
work(工作) → 工作。目的是兑换经济价值。
commute(通勤) → 工作。目的是往返工作场所。
growth(成长) → 成长。目的是自我提升。

work/commute/growth 用户说了具体内容就拆到 breakdown 子项。
边界模糊反问用户（如吃饭/运动看意图：为身体→body，为社交/放松→spirit）。

## 时间判断

用户说的具体时间点必须原样使用，不准自己改变。1:15→01:15，10:10→22:10（若为晚上）。
用户说"X点"时判断 AM/PM：① 明确说了早上/下午 → 按说的 ② 活动暗示("早饭"=上午、"睡觉"=晚上) ③ 上下文时间参照 ④ 仍无法判断 → ask
"X点Y"格式 → Y 就是分钟数直接使用。"十点50"=22:50，"八点20"=20:20
24小时制：start 和 end 字段用 HH:MM 格式。

## 输出格式

**只输出 JSON，不要任何其他文字。**

多操作用 batch：

{"action":"batch","items":[
  {"action":"create","data":{"date":"...","start":"...","end":"...","title":"...","category":"...","dimension":"...","breakdown":[{"activity":"...","duration":N,"dimension":"..."}]}},
  {"action":"update","id":"记录id","data":{"end":"22:40"}},
  {"action":"delete","id":"记录id"},
  {"action":"createTask","data":{"name":"任务名","zone":"todo"}}
],"reply":"..."}

单操作：

{"action":"create","data":{...},"reply":"..."}
{"action":"update","id":"记录id","data":{...},"reply":"..."}
{"action":"ask","reply":"..."}
{"action":"createTask","data":{"name":"任务名","zone":"todo"},"reply":"..."}

- create: data 含 date/start/end/activity/category/dimension/breakdown/sleepType。不同时段分开建。没 end=还没结束。sleepType 仅睡眠记录需要，值为 "main" 或 "nap"。
- update: 必须带 id。data 只写要改的字段。不要传整个对象。
- delete: 必须带 id。
- createTask: data 含 name（任务名）。用户说"弄到待办""帮我记一下""待办事项"等提到需要做的事 → 用这个。zone 默认 "todo"，可选 "urgent-important"/"noturgent-important"/"urgent-notimportant"/"noturgent-notimportant"。
- breakdown: 用户没提子活动 → 单项 duration=时段总长。提了→拆分，各项 duration 之和须等于总时长。
- reply: 口语化。包含 create/ask/createTask 时必须给 reply，不准为空。只输出"已记录"或"好的"这种废话不如追问一句。纯纠正时间(全部 update/delete)时可为空。禁止总结、统计、时长、emoji。代码自动处理时间重叠。

## 示例

例1 — 汇总段落：
用户："7:40到家，热饭吃饭洗碗到8点半，然后改流水账"
→ {"action":"batch","items":[
  {"action":"create","data":{"date":"2026-07-22","start":"19:40","end":"20:30","title":"热饭吃饭洗碗","category":"生活-身体","dimension":"body","breakdown":[{"activity":"热饭吃饭洗碗","duration":50,"dimension":"body"}]}},
  {"action":"create","data":{"date":"2026-07-22","start":"20:30","title":"改流水账","category":"成长","dimension":"growth","breakdown":[{"activity":"改流水账","duration":0,"dimension":"growth"}]}}
],"reply":"改流水账到几点结束的？"}

例2 — 纠正时间 + 级联：
已有记录：改流水账 id:abc123(20:30-22:36)、看小说 id:def456(22:36-23:00)
用户："改流水账到22:40"
→ {"action":"batch","items":[
  {"action":"update","id":"abc123","data":{"end":"22:40"}},
  {"action":"update","id":"def456","data":{"start":"22:40"}}
],"reply":""}

例3 — 纠正 + 插入（混合场景）：
已有记录：改流水账 id:abc123(20:30-22:36)、看小说 id:def456(22:36-23:00)
用户："十点50就躺下了，改流水账改到22:40"
→ 躺下=22:50。改流水账 end→22:40，看小说 start 级联→22:40。
→ {"action":"batch","items":[
  {"action":"update","id":"abc123","data":{"end":"22:40"}},
  {"action":"update","id":"def456","data":{"start":"22:40"}},
  {"action":"create","data":{"date":"2026-07-22","start":"22:50","title":"躺下","category":"生活-身体","dimension":"sleep","sleepType":"main","breakdown":[{"activity":"躺下","duration":0,"dimension":"sleep"}]}}
],"reply":"躺下到几点醒的？"}

例4 — 不确定，追问：
用户："下午忙了一下午"
→ {"action":"ask","reply":"下午具体在做什么？几点到几点？"}

例5 — 用户回应追问（停止追问）：
上次 AI 问："躺下到几点醒的？"，用户："醒了告诉你"
→ {"action":"batch","items":[],"reply":""}

例6 — 用户回应追问 + 同时给了新信息：
上次 AI 问："改流水账到几点结束的？"，用户："还没弄完，一会给你说。7:20醒了"
→ {"action":"create","data":{"date":"2026-07-23","start":"07:20","title":"醒了","category":"生活-身体","dimension":"sleep","sleepType":"main","breakdown":[{"activity":"醒了","duration":0,"dimension":"sleep"}]},"reply":""}

例7 — 用户给了信息 + 活动进行中：
已有记录：改流水账和一念 id:abc（进行中）
用户："流水账和一念是我开发的两个工具，算成长。是在修代码，还在进行中结束了告诉你"
→ {"action":"update","id":"abc","data":{"title":"改流水账和一念","category":"成长","dimension":"growth"},"reply":""}

例8 — 提取待办事项：
用户："这些资料乱乱的，未完成的帮我弄到待办事项里：30人的聊天记录分析报告还没做，访谈记录原文件也没整理"
→ {"action":"batch","items":[
  {"action":"createTask","data":{"name":"30人聊天记录分析报告","zone":"todo"}},
  {"action":"createTask","data":{"name":"访谈记录原文件整理","zone":"todo"}}
],"reply":"两个待办已加入四象限。"}`;

function buildSystemPrompt(dateStr, records, chats) {
  const allDates = Object.keys(records).sort().reverse();

  // 已有记录文本：只传当天 + 相邻一天
  let recordsText = '';
  const idx = allDates.indexOf(dateStr);
  const ctxDates = [dateStr];
  if (idx >= 0) {
    if (idx > 0) ctxDates.unshift(allDates[idx - 1]);
    if (idx < allDates.length - 1) ctxDates.push(allDates[idx + 1]);
  }
  for (const d of ctxDates) {
    const recs = records[d] || [];
    if (!recs.length) continue;
    recordsText += `\n## ${d} 的记录\n\n`;
    recs.forEach(r => {
      recordsText += `- id:${r.id} | ${r.start}-${r.end} | ${r.title || r.activity} | ${r.category}`;
      if (r.linkedTaskId) recordsText += ` | 关联任务:${r.linkedTaskId}`;
      recordsText += '\n';
    });
  }

  // 对话：当天所有 + 前一天最后 10 条，保持跨日期连续性
  let chatText = '';
  const dayChats = chats[dateStr] || [];
  const sortedChatDates = Object.keys(chats).sort();
  const cIdx = sortedChatDates.indexOf(dateStr);
  let prevChats = [];
  if (cIdx > 0) {
    prevChats = (chats[sortedChatDates[cIdx - 1]] || []).slice(-10);
  }
  const recentChat = [...prevChats, ...dayChats];
  if (recentChat.length) {
    chatText = '\n## 最近对话\n\n';
    recentChat.forEach(m => { chatText += `${m.role}: ${m.content}\n`; });
  }

  return 对话提示词 + '\n'
    + `今天的日期: ${dateStr}（用户消息无"X月X日——"前缀 → 所有记录的默认日期就是此日期，"昨天/今天/明天"均相对此日期换算。用户消息有"X月X日——"前缀 → 以前缀日期为准。跨天睡眠 date 永远填醒来当天）`
    + recordsText + chatText;
}

function validateCreates(message, actions) {
  const items = actions.action === 'batch' ? (actions.items || []) :
                actions.action === 'create' ? [actions] : [];
  const creates = items.filter(it => it && it.action === 'create');
  if (!creates.length) return [];
  const suspicious = [];
  for (const c of creates) {
    const title = c.data?.title || c.data?.activity || '';
    if (!title) continue;
    const msg = message || '';
    // 先按 2-gram 精确匹配
    let hasOverlap = false;
    for (let i = 0; i < title.length - 1; i++) {
      if (msg.includes(title.substring(i, i + 2))) { hasOverlap = true; break; }
    }
    if (hasOverlap) continue;
    // 短标题（≤3字）：任一字符命中即通过
    if (title.length <= 3) {
      if ([...title].some(ch => msg.includes(ch))) continue;
    } else {
      // 长标题：≥50% 非空白字符命中即通过
      const chars = [...title].filter(ch => ch.trim());
      const covered = chars.filter(ch => msg.includes(ch)).length;
      if (chars.length && covered / chars.length >= 0.5) continue;
    }
    suspicious.push(title);
  }
  return suspicious;
}

function extractJson(content) {
  let cleaned = content.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const codeBlock = content.match(/```json\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }
  const firstBrace = content.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(content.substring(firstBrace, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('AI 返回格式异常，请重试');
}

app.post('/api/chat', auth, async (req, res) => {
  const { date, message } = req.body;
  if (!date || !message) return res.status(400).json({ error: 'date 和 message 不能为空' });

  // 检查 API key
  const profile = loadProfile(req.userId);
  if (!profile || !profile.apiKey) {
    return res.json({ reply: '请先在下方配置 DeepSeek API key 才能使用 AI 对话。', actions: null });
  }
  const apiKey = decrypt(profile.apiKey);
  if (!apiKey) {
    return res.json({ reply: 'API key 解析失败，请重新配置。', actions: null });
  }

  // 加载上下文。检测跨天追问：前一天末尾有未闭合的追问且当天无聊天 → 上下文日期切到前一天
  const ctx = loadMultiDayContext(req.userId, date);
  let contextDate = date;
  const allChatDates = Object.keys(ctx.chats).sort();
  const dateIdx = allChatDates.indexOf(date);
  if (dateIdx > 0) {
    const prevDate = allChatDates[dateIdx - 1];
    const prevChats = ctx.chats[prevDate] || [];
    const todayChats = ctx.chats[date] || [];
    const lastPrevMsg = prevChats[prevChats.length - 1];
    if (todayChats.length === 0 && lastPrevMsg && lastPrevMsg.role === 'assistant' && /[？?]/.test(lastPrevMsg.content)) {
      contextDate = prevDate;
      console.log('[跨天追问] 上下文日期从', date, '切到', prevDate);
    }
  }
  const systemPrompt = buildSystemPrompt(contextDate, ctx.records, ctx.chats);

  // 先保存用户消息
  const day = loadDay(req.userId, date);
  day.chat.push({ role: 'user', content: message, timestamp: Date.now() });
  saveDay(req.userId, date, day);

  try {
    const deepseek = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
    let resp;
    try {
      resp = await deepseek.chat.completions.create({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        max_tokens: 131072,
        thinking: { type: 'enabled' },
      });
    } catch (apiErr) {
      console.error('[AI API 调用失败]', apiErr.message);
      const status = apiErr.status || apiErr.statusCode;
      if (status === 401 || status === 403) return res.json({ reply: 'DeepSeek API Key 无效或已过期，请检查配置。' });
      if (status === 402) return res.json({ reply: 'DeepSeek 账户余额不足，请充值。' });
      if (status === 429) return res.json({ reply: 'DeepSeek 请求太频繁，稍等一下再试。' });
      return res.json({ reply: '调用 DeepSeek 失败：' + apiErr.message + '。请检查网络或稍后重试。' });
    }

    let content = resp.choices[0].message.content;
    console.log('[AI RAW len]', (content || '').length);
    console.log('[AI RAW]', (content || '').substring(0, 500));

    let parsed;
    try {
      parsed = extractJson(content);
    } catch (parseErr) {
      console.error('[AI 解析失败] 原始返回:', (content || '').substring(0, 500));
      return res.json({ reply: 'AI 返回的内容解析不了。这是 AI 模型偶尔的 bug，重新发一次通常就好了。' });
    }

    // 校验：AI 创建的记录是否在用户消息里有依据
    const suspicious = validateCreates(message, parsed);
    if (suspicious.length > 0) {
      console.log('[AI VALIDATION] 疑似幻觉，重试:', suspicious.join(', '));
      try {
        resp = await deepseek.chat.completions.create({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
            { role: 'assistant', content: content },
            { role: 'user', content: '（系统提示：你上一条回复创建了用户没提到的活动：' + suspicious.join('、') + '。请只记录用户实际说的内容，不要编造。重新生成 JSON。）' },
          ],
          temperature: 0.3,
          max_tokens: 131072,
          thinking: { type: 'enabled' },
        });
        content = resp.choices[0].message.content;
        console.log('[AI RETRY]', (content || '').substring(0, 300));
        parsed = extractJson(content);
      } catch (retryErr) {
        console.error('[AI 重试失败]', retryErr.message);
        return res.json({ reply: 'AI 校验未通过，自动重试也失败了。请重新发送消息。' });
      }
    }

    day.chat.push({ role: 'assistant', content: parsed.reply || '', actions: parsed, timestamp: Date.now(), applied: false });
    saveDay(req.userId, date, day);

    res.json({ reply: parsed.reply || '', actions: parsed });
  } catch (err) {
    console.error('AI 意外错误:', err);
    res.json({ reply: '出了意料之外的错误：' + err.message + '。可以试试刷新页面或重新发送。' });
  }
});

// ============================================================
//  数据迁移 API（从旧 localStorage 格式迁移）
// ============================================================
app.post('/api/migrate', auth, (req, res) => {
  const { timelogs: oldTimelogs, chatHistory: oldChat, tasks: oldTasks } = req.body;

  // 迁移时间记录
  if (oldTimelogs) {
    for (const [date, records] of Object.entries(oldTimelogs)) {
      const day = loadDay(req.userId, date);
      const migrated = records.map(r => ({
        id: r.id,
        start: r.start || '',
        end: r.end || '',
        title: r.title || r.activity || '',
        category: r.category || '工作',
        dimension: r.dimension || '',
        energy: r.energy || 0,
        flow: r.flow || 0,
        breakdown: (r.breakdown && r.breakdown.length) ? r.breakdown : [{ activity: r.title || r.activity || '', duration: r.duration || 0, dimension: r.dimension || '' }],
      }));
      // 合并：迁移数据优先，但如果后端已有数据则跳过该日期
      if (!day.records.length || !day.records.some(r => migrated.some(m => m.id === r.id))) {
        day.records = migrated;
      }
      saveDay(req.userId, date, day);
    }
  }

  // 迁移聊天历史
  if (oldChat) {
    for (const [date, messages] of Object.entries(oldChat)) {
      const day = loadDay(req.userId, date);
      if (!day.chat.length) {
        day.chat = messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp || Date.now(),
        }));
      }
      saveDay(req.userId, date, day);
    }
  }

  // 迁移任务
  if (oldTasks) {
    const existing = readJSON(tasksPath(req.userId), { tasks: [], done: [] });
    if (!existing.tasks.length && !existing.done.length) {
      writeJSON(tasksPath(req.userId), { tasks: oldTasks.tasks || [], done: oldTasks.done || [] });
    }
  }

  res.json({ ok: true, migrated: Object.keys(oldTimelogs || {}).length });
});

// ============================================================
//  通用 AI 代理（总结/分析等次要 AI 功能）
// ============================================================
app.post('/api/ai/raw', auth, async (req, res) => {
  const { system, message } = req.body;
  if (!system || !message) return res.status(400).json({ error: 'system 和 message 不能为空' });

  const profile = loadProfile(req.userId);
  if (!profile || !profile.apiKey) return res.json({ error: '请先配置 API key' });
  const apiKey = decrypt(profile.apiKey);
  if (!apiKey) return res.json({ error: 'API key 解析失败' });

  try {
    const deepseek = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
    const resp = await deepseek.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 4000,
      thinking: { type: 'disabled' },
    });
    const raw = resp.choices[0].message.content.replace(/```json\n?|```/g, '').trim();
    let content;
    try { content = JSON.parse(raw); } catch { content = raw; }
    res.json({ content });
  } catch (err) {
    console.error('AI raw 调用失败:', err);
    res.status(500).json({ error: 'AI 调用失败: ' + err.message });
  }
});

// ============================================================
//  静态文件
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
//  启动
// ============================================================
ensureDir(DATA_DIR);
app.listen(PORT, () => {
  console.log(`流水账已启动 → http://localhost:${PORT}`);
});
