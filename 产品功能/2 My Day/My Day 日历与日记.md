# My Day 日历与日记

## 一、功能说明

My Day 是第二个 tab，提供日历视图 + 日记功能。左右两栏布局：

**左栏**：
- 日历组件：月视图，可前后翻月，点击日期切换
- 原始日记：用户自己写的日记，和 AI 对话的聊天记录一起展示

**右栏**：
- 今天的时间：当日记录的数据摘要（按维度/分类的时长分布）
- AI 日记：基于原始日记 + 时间记录，AI 生成结构化的四板块日记

## 二、技术原理

### 日历组件

```
calShift(-1/1) → 调整 calYear/calMonth
  → renderCalendar()
    → 生成月视图 grid（42 格，含前后月填充）
    → 当天日期高亮
    → 有数据的日期打圆点标记
    → 点击日期 → calSelected = date → 刷新右侧面板
```

日历上的圆点：检测 `timelogs[date]` 是否有记录，有则打点。

### 原始日记

原始日记内容来自两部分：
1. **用户自己写的日记文本**（存后端 `diary.json`，未登录时存 localStorage `qt_diary`）
2. **当天的 AI 对话聊天记录**（`chat[]` 数组的内容）

二者合并显示在左栏下半的预览区。点击预览区弹出大编辑弹窗，可编辑日记正文。

### AI 日记

```
用户选择日期 → 点击"生成"
  → renderAiLogPanel(dateStr)
    → 检查缓存（aiLogs[dateStr]）
    → 构建 records 文本 + 原始日记
    → POST /api/ai/raw
      → 四板块结构 prompt：
        ## 生活·身体 / ## 生活·精神 / ## 工作 / ## 成长
    → AI 返回结构化日记
    → 缓存并显示
```

AI 日记的四板块规则：
- 信息不足的板块输出「（无记录）」，不编造
- 语气像朋友整理，自然亲切
- 每个板块 1-3 句话

AI 日记结果缓存在前端 `aiLogs[dateStr]` 中，下次查看同一日期直接显示缓存。

### 今天的时间（数据面板）

右侧上半部分展示当天时间记录的维度分布和分类分布：

- 维度分布条：六维度横向堆叠条
- 分类分布：四分类饼图或横向条
- 具体活动的时长明细

## 三、代码位置

### 前端（index.html）

| 行号范围 | 内容 | 用途 |
|----------|------|------|
| 882-920 | My Day tab HTML | 左右两栏布局 |
| 922-936 | diaryModal HTML | 日记编辑弹窗 |
| 3039-3147 | `renderAiLogPanel()` | AI 日记生成与渲染 |
| — | `renderCalendar()` | 日历渲染 |
| — | `calShift()` `calGoToday()` | 日历翻页 |
| — | `openDiaryModal()` `closeDiaryModal()` | 日记编辑器 |
| — | My Day 数据面板 | 当日时长统计 |

### 后端（server.js）

| 端点 | 用途 |
|------|------|
| `GET /api/day/:date` | 读某天数据（records/chat） |
| `POST /api/day/:date` | 写某天数据（records + deletedIds） |
| `GET/POST /api/diary` | 手写日记批量读写 |
| `POST /api/diary/:date` | 写某天日记（空文本 = 删除） |
| `POST /api/ai/raw` | AI 日记生成 |

## 四、跨模块关联

### 对外提供的数据

| 给谁 | 给什么 | 用途 |
|------|--------|------|
| — | — | My Day 主要是消费端，不对外提供数据 |

### 依赖的外部数据

| 来自谁 | 读什么 | 在哪用 |
|--------|--------|--------|
| 时间记录管理 | `records[]` | 数据面板统计 + AI 日记输入 |
| AI 对话 | `chat[]` | 原始日记聊天记录区 |
| 日记 | `diaries[]` → 后端 `diary.json` | 原始日记正文 |
| API key | profile.apiKey | AI 日记生成需要 key |

## 五、修改注意事项

1. **AI 日记缓存在前端**：`aiLogs[dateStr]` 是内存变量，刷新页面后清空。如果要持久化缓存，需要存在 day 文件中。

2. **AI 日记 prompt 的四板块结构不变**：prompt 中定义了四个板块（生活·身体/精神/工作/成长），改板块名称需要同步改 prompt。

3. **日历数据点判断**：圆点标记只看 `timelogs[date]` 是否有记录。如果某天只有 diary 没有 time records，不会打点。

4. **原始日记不存储在 tasks.json**：日记走后端独立 `diary.json`（前端 `diaries[]`）。编辑日记后调 `POST /api/diary/:date` 保存（空文本 = 删除该天）；未登录时存 localStorage `qt_diary`，登录后一次性迁移到后端。
