# 流水账

个人时间管理 + AI 记录助手。用四象限管理任务、自动记录时间，接入 DeepSeek AI 生成对话记录、每日总结与周期洞察。

## 功能

- 四象限任务管理（重要 / 紧急矩阵，拖拽排序）
- 时间记录与统计
- AI 对话记录（接入 DeepSeek）
- 每日总结、周报、周期洞察

## 技术栈

- 前端：原生 HTML / CSS / JS（单文件 `index.html`）
- 后端：Node.js + Express
- 认证：JWT + bcrypt
- AI：DeepSeek API（OpenAI 兼容接口）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：把 JWT_SECRET 和 ENCRYPTION_KEY 换成随机字符串

# 3. 启动
node server.js
```

打开 http://localhost:5202 ，首次使用先注册一个账号。

## 配置 AI

登录后，在设置页填入你的 DeepSeek API key（在 https://platform.deepseek.com 创建）。

## 目录结构

```
server.js          后端服务
index.html         前端（单文件）
data/              运行后生成的本地数据（首次运行自动创建）
.env.example       环境变量模板
```

## 许可证

MIT
