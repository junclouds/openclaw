# Engineering Dashboard Skill

用于在 iOS 工程驾驶舱中查看项目进展和驱动 AI 任务执行。

---

## 目标

1. **查看**: 跨项目查看整体迭代进展，按项目/任务维度看到「现在在做什么、做到哪一步」
2. **驱动**: 在手机上对某个任务发出简单指令，让 AI（通过 GasTown + Claude Code）继续写代码、跑测试或汇报进度

---

## 核心数据模型

### ProjectSummary

```typescript
interface ProjectSummary {
  id: string; // 项目 ID，来自 beads issues 的 rig 字段
  name: string; // 展示用名字
  repoPath: string; // 本地 git 路径

  openTasks: number; // status=open
  inProgressTasks: number; // status=in_progress
  doneTasks: number; // status in (closed, done)

  lastUpdatedAt: string; // ISO 8601 格式
  status: "healthy" | "risky" | "blocked";
}
```

### TaskSummary

```typescript
type TaskStatus = "ready" | "in_progress" | "blocked" | "waiting_review" | "done";

interface TaskSummary {
  id: string; // beads issue id，如 "bd-a3f8.1"
  projectId: string; // 对应 ProjectSummary.id (rig)
  title: string;
  status: TaskStatus;
  priority: number; // 0=P0, 1=P1, ...
  assignee?: string;
  tags: string[]; // 来自 labels
  createdAt: string;
  updatedAt: string;

  relatedConvoyId?: string; // 来自 metadata["gastown_convoy_id"]
  branch?: string; // 来自 metadata["git_branch"]
  lastSummary?: string; // 来自 metadata["summary"]
}
```

### TaskProgressSummary

```typescript
interface TaskProgressSummary {
  taskId: string;
  status: TaskStatus;
  progressSummary: string; // 面向人的简明进度摘要
  risks?: string[];
  nextSteps?: string[];
  relatedCommits?: string[];
  relatedPRs?: string[];
}
```

---

## Beads CLI 使用指南

### 列出所有 Issues

```bash
bd list --json
```

返回 JSON 数组，每个 issue 包含:

- `id`: issue ID
- `title`: 标题
- `status`: open, in_progress, closed
- `priority`: 数字优先级
- `issue_type`: 类型
- `assignee`: 指派者
- `created_at`, `updated_at`, `closed_at`: 时间戳
- `metadata`: JSON 对象，可包含 `gastown_convoy_id`, `git_branch`, `summary`
- `labels`: 标签数组
- `rig`: 项目标识（重要：JSON 中没有 `source_repo`，使用 `rig`）

### 查看单个 Issue

```bash
bd show <taskId> --json
```

### 更新 Issue

```bash
bd update <taskId> --status <status> --notes "备注"
```

### 按 rig 过滤

```bash
bd list --rig <projectName> --json
```

---

## Gas Town CLI 使用指南

### 创建 Convoy

```bash
gt convoy create "任务描述" <bead-id> --human
```

### Sling 任务给 Worker

```bash
gt sling <bead-id> <rig>/<worker-name>
```

### 常用 rigs

- `beads`: beads 项目自身
- `gastown`: gastown 项目
- `openclaw`: openclaw 项目

---

## 核心接口实现

### 1. listProjects() → ProjectSummary[]

**目标**: 展示所有受管项目的高层进度

**实现步骤**:

1. 调用 `bd list --json` 获取所有 issues
2. 按 `rig` 字段分组（没有 rig 的归为 "default"）
3. 对每个项目统计:
   - `openTasks`: status=open 的数量
   - `inProgressTasks`: status=in_progress 的数量
   - `doneTasks`: status in (closed, done) 的数量
   - `lastUpdatedAt`: 所有 issues 的 updated_at 最大值
4. 计算 `status`:
   - "blocked": 有 blocked 状态的任务
   - "risky": 长时间未更新但 open 任务很多
   - "healthy": 其他情况

### 2. listTasks(params) → { items: TaskSummary[]; nextCursor? }

**目标**: 展示某个项目的所有任务

**参数**:

- `projectId`: 必填，对应 rig
- `statusFilter`: 可选，按状态过滤
- `limit`: 可选，分页上限
- `cursor`: 可选，游标分页

**实现步骤**:

1. 调用 `bd list --json` 或 `bd list --rig <projectId> --json`
2. 过滤:
   - 只保留 `rig === projectId` 的 issues
   - 过滤掉 `issue_type == "message"`
   - 过滤掉临时/模板 issue
3. 映射 status:
   - `open` → `ready`
   - `in_progress` → `in_progress`
   - `closed`/`done` → `done`
4. 提取 metadata 中的 `gastown_convoy_id`, `git_branch`, `summary`

### 3. nudgeTask(params) → TaskSummary

**目标**: 驱动 AI 继续执行任务

**参数**:

- `taskId`: 任务 ID
- `action`: "continue" | "test" | "deploy" | "plan" | "fix"

**实现步骤 (MVP)**:

1. 调用 `bd show <taskId> --json` 获取 issue 详情
2. 提取 `rig` 作为项目名
3. 更新 beads 状态:
   ```bash
   bd update <taskId> --status in_progress --notes "Nudged from iOS: action=continue"
   ```
4. (可选) 创建或加入 convoy:
   ```bash
   gt convoy create "任务描述" <taskId> --human
   ```
5. (可选) Sling 给 worker:
   ```bash
   gt sling <taskId> <rig>/<worker-name>
   ```
6. 返回更新后的 TaskSummary

### 4. summarizeTask(taskId) → TaskProgressSummary

**目标**: 生成任务进度摘要

**实现步骤 (MVP)**:

1. 聚合上下文:
   - Beads: `bd show <taskId> --json` 获取基础信息
   - Notes/History: 从 issue 中提取
2. 调用 Claude 生成摘要:
   - 输入: issue 的 title, description, notes, status 历史
   - 输出: progressSummary, risks[], nextSteps[]
3. (可选) 持久化到 beads metadata
4. 返回 TaskProgressSummary

---

## 示例代码

### 执行 Shell 命令

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function runBd(args: string[]): Promise<any> {
  const { stdout } = await execAsync(`bd ${args.join(" ")}`);
  return JSON.parse(stdout);
}

// 使用示例
const issues = await runBd(["list", "--json"]);
```

### 聚合项目数据

```typescript
function aggregateProjects(issues: any[]): ProjectSummary[] {
  const grouped = new Map<string, any[]>();

  // 按 rig 分组
  for (const issue of issues) {
    const rig = issue.rig || "default";
    if (!grouped.has(rig)) grouped.set(rig, []);
    grouped.get(rig)!.push(issue);
  }

  // 计算每个项目的统计
  return Array.from(grouped.entries()).map(([rig, issues]) => ({
    id: rig,
    name: rig,
    repoPath: "", // 从配置或 metadata 获取
    openTasks: issues.filter((i) => i.status === "open").length,
    inProgressTasks: issues.filter((i) => i.status === "in_progress").length,
    doneTasks: issues.filter((i) => ["closed", "done"].includes(i.status)).length,
    lastUpdatedAt: issues.reduce(
      (max, i) => (new Date(i.updated_at) > new Date(max) ? i.updated_at : max),
      issues[0]?.updated_at,
    ),
    status: calculateStatus(issues),
  }));
}
```

---

## 注意事项

1. **source_repo 不存在**: beads JSON 输出中没有 `source_repo` 字段，使用 `rig` 作为项目标识
2. **Dolt 服务器**: beads 需要 Dolt sql-server 在端口 3307 或 14304 运行
3. **Gas Town 集成**: MVP 阶段可以先不真正调用 gt，仅更新 beads 状态
4. **错误处理**: 所有 shell 命令需要处理非零退出码和 JSON 解析错误
5. **性能**: `bd list --json` 可能返回大量数据，考虑分页和缓存

---

## 相关文档

- `docs/mvp-ios-eng-dashboard.md`: MVP 设计文档
- `docs/checklist-eng-dashboard-mvp.md`: 验证检查清单
- `docs/eng-dashboard-placement-and-corrections.md`: 模块放置说明
