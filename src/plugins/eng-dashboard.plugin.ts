/**
 * Engineering Dashboard Plugin
 * 工程驾驶舱插件 - 提供项目管理和任务驱动 HTTP API
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { registerPluginHttpRoute } from "./http-registry.js";
import type { PluginRegistry } from "./registry.js";

const execAsync = promisify(exec);

// Beads 数据库目录配置 (Gas Town workspace .beads directories)
const BEADS_DIRS = [
  "/Users/lijun/work_github/gt-workspace/.beads",
  "/Users/lijun/work_github/gt-workspace/data_analysis_tool/.beads",
  "/Users/lijun/work_github/gt-workspace/letterflow/.beads",
];

// 数据模型类型定义
type ProjectStatus = "healthy" | "risky" | "blocked";
type TaskStatus = "ready" | "in_progress" | "blocked" | "waiting_review" | "done";

interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  openTasks: number;
  inProgressTasks: number;
  doneTasks: number;
  lastUpdatedAt: string;
  status: ProjectStatus;
}

interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: number;
  assignee?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  relatedConvoyId?: string;
  branch?: string;
  lastSummary?: string;
}

interface TaskProgressSummary {
  taskId: string;
  status: TaskStatus;
  progressSummary: string;
  risks?: string[];
  nextSteps?: string[];
  relatedCommits?: string[];
  relatedPRs?: string[];
}

// bd 命令路径
const BD_BIN = "/Users/lijun/.local/bin/bd";

// Beads issue 类型
interface BeadsIssue {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  updated_at?: string;
  created_at?: string;
  issue_type?: string;
  ephemeral?: boolean;
  is_template?: boolean;
  metadata?: Record<string, unknown>;
  notes?: string;
  assignee?: string;
  labels?: string[];
  [key: string]: unknown;
}

// 执行 bd 命令（在第一个可用的 beads 目录中）
async function runBd(args: string[]): Promise<BeadsIssue[]> {
  for (const dir of BEADS_DIRS) {
    try {
      const { stdout } = await execAsync(`${BD_BIN} ${args.join(" ")}`, {
        cwd: dir,
        env: { ...process.env, BEADS_DIR: dir },
      });
      return JSON.parse(stdout);
    } catch {
      // 尝试下一个目录
      continue;
    }
  }
  throw new Error(`No beads database found in any of: ${BEADS_DIRS.join(", ")}`);
}

// Convoy 状态类型
interface ConvoyStatus {
  status?: string;
  progress?: number;
  lastLog?: string;
  [key: string]: unknown;
}

// 从所有 beads 目录获取 issues
async function runBdAll(args: string[]): Promise<BeadsIssue[]> {
  const allIssues: BeadsIssue[] = [];
  for (const dir of BEADS_DIRS) {
    try {
      const { stdout } = await execAsync(`${BD_BIN} ${args.join(" ")}`, {
        cwd: dir,
        env: { ...process.env, BEADS_DIR: dir },
      });
      const issues = JSON.parse(stdout) as BeadsIssue[];
      allIssues.push(...issues);
    } catch {
      // 跳过无法访问的目录
      continue;
    }
  }
  return allIssues;
}

// gt 命令路径
const GT_BIN = "/Users/lijun/.local/bin/gt";

// Gas Town 工作目录
const GT_DIR = "/Users/lijun/work_github/gt-workspace";

// 执行 gt 命令
async function runGt(args: string[]): Promise<string> {
  try {
    const { stdout } = await execAsync(`${GT_BIN} ${args.join(" ")}`, { cwd: GT_DIR });
    return stdout;
  } catch (error) {
    console.error(`gt command failed: ${args.join(" ")}`, error);
    throw error;
  }
}

// 映射 beads status 到 TaskStatus
function mapStatus(status: string): TaskStatus {
  switch (status) {
    case "open":
      return "ready";
    case "in_progress":
      return "in_progress";
    case "closed":
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return "ready";
  }
}

// 计算项目状态
function calculateProjectStatus(issues: BeadsIssue[]): ProjectStatus {
  const hasBlocked = issues.some((i) => i.status === "blocked");
  if (hasBlocked) {
    return "blocked";
  }

  const openCount = issues.filter((i) => i.status === "open").length;
  const oldIssues = issues.filter((i) => {
    if (!i.updated_at) {
      return false;
    }
    const updated = new Date(i.updated_at);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return updated < weekAgo && i.status === "open";
  }).length;

  if (oldIssues > 3 || (openCount > 10 && oldIssues > 0)) {
    return "risky";
  }
  return "healthy";
}

// 从 issue ID 提取项目名 (如 "beads-p6n" -> "beads")
function extractProjectFromId(issueId: string): string {
  const match = issueId.match(/^([^-]+)-/);
  return match ? match[1] : "default";
}

// API 实现
async function listProjects(): Promise<ProjectSummary[]> {
  const issues = await runBdAll(["list", "--json"]);

  // 按 issue ID 前缀分组
  const grouped = new Map<string, BeadsIssue[]>();
  for (const issue of issues) {
    const project = extractProjectFromId(issue.id);
    if (!grouped.has(project)) {
      grouped.set(project, []);
    }
    grouped.get(project)!.push(issue);
  }

  // 计算每个项目的统计
  return Array.from(grouped.entries()).map(([rig, issues]) => {
    const sortedByDate = issues.toSorted(
      (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime(),
    );

    return {
      id: rig,
      name: rig,
      repoPath: "", // 可以从配置或 metadata 获取
      openTasks: issues.filter((i) => i.status === "open").length,
      inProgressTasks: issues.filter((i) => i.status === "in_progress").length,
      doneTasks: issues.filter((i) => i.status && ["closed", "done"].includes(i.status)).length,
      lastUpdatedAt: String(sortedByDate[0]?.updated_at || new Date().toISOString()),
      status: calculateProjectStatus(issues),
    };
  });
}

async function listTasks(params: {
  projectId: string;
  statusFilter?: TaskStatus[];
  limit?: number;
  cursor?: string;
}): Promise<{ items: TaskSummary[]; nextCursor?: string }> {
  // 获取所有 issues，然后按项目 ID 前缀过滤
  const issues = await runBdAll(["list", "--json"]);

  // 过滤和映射
  let tasks: TaskSummary[] = issues
    .filter((issue) => {
      // 过滤掉消息类型和临时 issue
      if (issue.issue_type === "message") {
        return false;
      }
      if (issue.ephemeral || issue.is_template) {
        return false;
      }

      // 按 projectId 过滤（使用 issue ID 前缀）
      const project = extractProjectFromId(issue.id);
      if (project !== params.projectId) {
        return false;
      }

      return true;
    })
    .map((issue) => ({
      id: issue.id || "",
      projectId: extractProjectFromId(issue.id || ""),
      title: issue.title || "Untitled",
      status: mapStatus(issue.status || ""),
      priority: issue.priority || 0,
      assignee: issue.assignee,
      tags: (issue.labels as string[]) || [],
      createdAt: issue.created_at || new Date().toISOString(),
      updatedAt: issue.updated_at || new Date().toISOString(),
      relatedConvoyId: issue.metadata?.gastown_convoy_id as string | undefined,
      branch: issue.metadata?.git_branch as string | undefined,
      lastSummary: issue.metadata?.summary as string | undefined,
    }));

  // 按状态过滤
  if (params.statusFilter && params.statusFilter.length > 0) {
    tasks = tasks.filter((t) => params.statusFilter!.includes(t.status));
  }

  // 分页 (MVP: 简单 slice)
  const limit = params.limit || 50;
  const startIndex = params.cursor ? parseInt(params.cursor, 10) : 0;
  const endIndex = startIndex + limit;
  const paginatedTasks = tasks.slice(startIndex, endIndex);

  return {
    items: paginatedTasks,
    nextCursor: endIndex < tasks.length ? String(endIndex) : undefined,
  };
}

async function nudgeTask(params: { taskId: string; action: string }): Promise<TaskSummary> {
  // 1. 获取任务详情 (bd show 返回数组)
  const issues = await runBd(["show", params.taskId, "--json"]);
  const issue = issues[0];

  if (!issue) {
    throw new Error(`Task ${params.taskId} not found`);
  }

  // 2. 更新状态 (bd update 返回文本，不是 JSON)
  try {
    await execAsync(
      `${BD_BIN} update ${params.taskId} --status in_progress --notes "Nudged from iOS: action=${params.action}"`,
      {
        cwd: BEADS_DIRS[0],
        env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] },
      },
    );
  } catch (error) {
    console.error("[eng-dashboard] Failed to update task status:", error);
    // 继续执行，因为状态更新失败不应阻止 Gas Town 调用
  }

  // 3. 调用 Gas Town (创建 convoy 并 sling 给 worker)
  const rig = extractProjectFromId(issue.id);
  const metadata = issue.metadata;
  let convoyId: string | undefined =
    metadata && typeof metadata.gastown_convoy_id === "string"
      ? metadata.gastown_convoy_id
      : undefined;

  try {
    if (!convoyId) {
      // 创建新的 convoy
      // 格式: gt convoy create <name> [issues...]
      const convoyName = `iOS-${params.action}-${Date.now()}`;
      const convoyOutput = await runGt(["convoy", "create", convoyName, params.taskId]);
      // 尝试从输出中提取 convoy ID
      // 输出格式可能是: "Created convoy <id>" 或 convoy ID 在行尾
      const match = convoyOutput.match(/(?:convoy[\s]+)?([a-z]+-[a-z0-9]+)/i);
      convoyId = match ? match[1] : undefined;

      if (convoyId) {
        // 保存 convoy ID 到 beads metadata (bd update 需要 JSON 格式)
        try {
          const metadataJson = JSON.stringify({ gastown_convoy_id: convoyId });
          await execAsync(`${BD_BIN} update ${params.taskId} --metadata '${metadataJson}'`, {
            cwd: BEADS_DIRS[0],
            env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] },
          });
        } catch (err) {
          console.error("[eng-dashboard] Failed to save convoy ID:", err);
        }
      }
    }

    // Sling 任务给 worker (基于 action 选择不同的 worker)
    const workerName = mapActionToWorker(params.action);
    try {
      await runGt(["sling", params.taskId, `${rig}/${workerName}`]);
    } catch (slingError) {
      console.error(`[eng-dashboard] Sling failed:`, slingError);
    }
  } catch (gtError) {
    // Gas Town 调用失败不应影响主流程，仅记录日志
    console.error("[eng-dashboard] Gas Town integration failed:", gtError);
  }

  // 4. 返回更新后的任务
  const issueId = String(issue.id || "");
  return {
    id: issueId,
    projectId: extractProjectFromId(issueId),
    title: issue.title || "Untitled",
    status: "in_progress",
    priority: issue.priority || 0,
    assignee: issue.assignee,
    tags: (issue.labels as string[]) || [],
    createdAt: issue.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    relatedConvoyId: convoyId || undefined,
    branch: undefined,
    lastSummary: undefined,
  };
}

// 根据 action 选择 worker 名称
function mapActionToWorker(action: string): string {
  const workerMap: Record<string, string> = {
    continue: "worker",
    test: "tester",
    deploy: "deployer",
    plan: "planner",
    fix: "fixer",
    review: "reviewer",
  };
  return workerMap[action] || "worker";
}

// Worker 状态查询 (Phase 1: 轮询 API)
async function getWorkerStatus(taskId: string): Promise<{
  taskId: string;
  status: "coding" | "waiting_review" | "blocked" | "completed";
  progress: number;
  lastLog: string;
  needsConfirmation: boolean;
  questions?: Array<{
    id: string;
    question: string;
    options?: string[];
    context?: string;
  }>;
}> {
  // 1. 获取任务详情
  const issues = await runBd(["show", taskId, "--json"]);
  const issue = issues[0];

  if (!issue) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 2. 尝试获取 convoy 状态
  let convoyStatus: ConvoyStatus | null = null;
  try {
    const convoyId = issue.metadata?.gastown_convoy_id as string | undefined;
    if (convoyId) {
      const convoyOutput = await runGt(["convoy", "status", convoyId]);
      // 解析 convoy 状态输出
      convoyStatus = parseConvoyStatus(convoyOutput);
    }
  } catch (error) {
    console.error("[eng-dashboard] Failed to get convoy status:", error);
  }

  // 3. 映射到 worker 状态
  const mappedStatus = mapToWorkerStatus(String(issue.status || ""), convoyStatus);

  return {
    taskId,
    status: mappedStatus.status,
    progress: mappedStatus.progress,
    lastLog: convoyStatus?.lastLog || (issue.metadata?.last_log as string) || "No recent activity",
    needsConfirmation: (issue.metadata?.needs_confirmation as boolean) || false,
    questions: issue.metadata?.questions as
      | { id: string; question: string; options?: string[]; context?: string }[]
      | undefined,
  };
}

// 解析 convoy 状态输出
function parseConvoyStatus(output: string): ConvoyStatus {
  // 简化解析，实际应根据 gt convoy status 的输出格式调整
  const lines = output.split("\n");
  const status: ConvoyStatus = {};

  for (const line of lines) {
    if (line.includes("Status:")) {
      status.state = line.split(":")[1]?.trim();
    }
    if (line.includes("Progress:")) {
      const match = line.match(/(\d+)%/);
      status.progress = match ? parseInt(match[1]) : 0;
    }
  }

  return status;
}

// 映射 beads/convoy 状态到 worker 状态
function mapToWorkerStatus(
  issueStatus: string,
  convoyStatus: ConvoyStatus | null,
): { status: "coding" | "waiting_review" | "blocked" | "completed"; progress: number } {
  // 如果 issue 已完成
  if (issueStatus === "closed" || issueStatus === "done") {
    return { status: "completed", progress: 100 };
  }

  // 如果 issue 被阻塞
  if (issueStatus === "blocked") {
    return { status: "blocked", progress: convoyStatus?.progress || 0 };
  }

  // 如果有 convoy 状态
  if (convoyStatus) {
    if (convoyStatus.state === "waiting_review") {
      return { status: "waiting_review", progress: convoyStatus.progress || 80 };
    }
    if (convoyStatus.state === "completed") {
      return { status: "completed", progress: 100 };
    }
    return { status: "coding", progress: convoyStatus.progress || 50 };
  }

  // 默认状态
  return { status: "coding", progress: issueStatus === "in_progress" ? 30 : 0 };
}

// 用户确认/回复 (Phase 1)
async function respondToConfirmation(params: {
  taskId: string;
  questionId: string;
  response: string;
  action: "continue" | "pause" | "cancel" | "retry";
}): Promise<void> {
  const { taskId, response, action } = params;

  // 1. 获取任务详情
  const issues = await runBd(["show", taskId, "--json"]);
  const issue = issues[0];

  if (!issue) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 2. 根据 action 执行不同操作
  switch (action) {
    case "continue":
      // 继续执行：更新 metadata，通知 worker 继续
      // bd update --metadata 需要 JSON 格式
      const metadataJson = JSON.stringify({
        user_response: response,
        needs_confirmation: false,
        response_time: new Date().toISOString(),
      });
      await execAsync(`${BD_BIN} update ${taskId} --metadata '${metadataJson}'`, {
        cwd: BEADS_DIRS[0],
        env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] },
      });

      // 如果有 convoy，尝试 resume
      const convoyId = issue.metadata?.gastown_convoy_id as string | undefined;
      if (convoyId) {
        try {
          await runGt(["convoy", "resume", convoyId]);
        } catch {
          console.error("[eng-dashboard] Failed to resume convoy");
        }
      }
      break;

    case "pause":
      // 暂停任务
      await execAsync(
        `${BD_BIN} update ${taskId} --status open --notes "Paused by user: ${response}"`,
        { cwd: BEADS_DIRS[0], env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] } },
      );
      break;

    case "cancel":
      // 取消任务
      await execAsync(
        `${BD_BIN} update ${taskId} --status blocked --notes "Cancelled by user: ${response}"`,
        { cwd: BEADS_DIRS[0], env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] } },
      );
      break;

    case "retry":
      // 重试任务
      await execAsync(
        `${BD_BIN} update ${taskId} --status in_progress --notes "Retry requested by user: ${response}"`,
        { cwd: BEADS_DIRS[0], env: { ...process.env, BEADS_DIR: BEADS_DIRS[0] } },
      );
      break;
  }

  // 3. 记录用户回复到任务历史
  console.log(`[eng-dashboard] User responded to ${taskId}: ${response} (action: ${action})`);
}

async function summarizeTask(taskId: string): Promise<TaskProgressSummary> {
  // 1. 获取任务详情 (bd show 返回数组)
  const issues = await runBd(["show", taskId, "--json"]);
  const issue = issues[0];

  if (!issue) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 2. (MVP) 基于 issue 信息生成简单摘要
  // 后续可以调用 Claude API 生成更详细的摘要
  const progressSummary = `Task "${String(issue.title || "Untitled")}" is currently ${String(issue.status || "unknown")}. ${issue.notes ? `Notes: ${String(issue.notes).substring(0, 100)}...` : ""}`;

  // 计算进度百分比 (基于状态映射)
  const statusToProgress: Record<string, number> = {
    open: 0,
    ready: 10,
    in_progress: 30,
    waiting_review: 70,
    done: 100,
    blocked: 0,
  };
  const progressPercent = statusToProgress[String(issue.status)] ?? 0;

  return {
    taskId,
    progressPercent,
    risks: issue.status === "blocked" ? ["Task is currently blocked"] : [],
    nextActions: issue.status === "open" ? ["Start working on this task"] : [],
    branch: issue.metadata?.branch as string | undefined,
    lastSummary: progressSummary,
  };
}

// ServerResponse 类型
interface ServerResponse {
  setHeader(name: string, value: string): void;
}

// CORS 头设置
function setCorsHeaders(res: ServerResponse, origin: string = "*"): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// 插件注册函数
export function registerEngDashboardPlugin(registry: PluginRegistry): void {
  // OPTIONS 预检请求处理 (全局 CORS)
  registerPluginHttpRoute({
    path: "/eng-dashboard/*",
    handler: async (req, res) => {
      const origin = req.headers.origin || "*";
      setCorsHeaders(res, origin);
      res.statusCode = 204;
      res.end();
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // GET /eng-dashboard/projects
  registerPluginHttpRoute({
    path: "/eng-dashboard/projects",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        const projects = await listProjects();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(projects));
      } catch (error) {
        console.error("listProjects error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // GET /eng-dashboard/tasks?projectId=xxx
  registerPluginHttpRoute({
    path: "/eng-dashboard/tasks",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        const url = new URL(req.url || "/", "http://localhost");
        const projectId = url.searchParams.get("projectId");

        if (!projectId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "projectId is required" }));
          return;
        }

        const statusFilter = url.searchParams.get("statusFilter")?.split(",") as
          | TaskStatus[]
          | undefined;
        const limit = url.searchParams.get("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : undefined;
        const cursor = url.searchParams.get("cursor") || undefined;

        const result = await listTasks({
          projectId,
          statusFilter,
          limit,
          cursor,
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error("listTasks error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // POST /eng-dashboard/nudge?taskId=xxx
  registerPluginHttpRoute({
    path: "/eng-dashboard/nudge",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        const url = new URL(req.url || "/", "http://localhost");
        const taskId = url.searchParams.get("taskId");

        if (!taskId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "taskId is required" }));
          return;
        }

        // 读取 POST body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const params = body ? JSON.parse(body) : {};
        const action = params.action || "continue";

        const result = await nudgeTask({ taskId, action });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error("nudgeTask error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // GET /eng-dashboard/summary?taskId=xxx
  registerPluginHttpRoute({
    path: "/eng-dashboard/summary",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        const url = new URL(req.url || "/", "http://localhost");
        const taskId = url.searchParams.get("taskId");

        if (!taskId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "taskId is required" }));
          return;
        }

        const result = await summarizeTask(taskId);

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error("summarizeTask error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // GET /eng-dashboard/worker-status?taskId=xxx (Phase 1: 轮询 API)
  registerPluginHttpRoute({
    path: "/eng-dashboard/worker-status",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        const url = new URL(req.url || "/", "http://localhost");
        const taskId = url.searchParams.get("taskId");

        if (!taskId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "taskId is required" }));
          return;
        }

        const result = await getWorkerStatus(taskId);

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error("getWorkerStatus error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  // POST /eng-dashboard/respond (Phase 1: 用户确认/回复)
  registerPluginHttpRoute({
    path: "/eng-dashboard/respond",
    handler: async (req, res) => {
      try {
        const origin = req.headers.origin || "*";
        setCorsHeaders(res, origin);
        // 读取 POST body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const params = body ? JSON.parse(body) : {};

        // 验证必填字段
        if (!params.taskId || !params.questionId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "taskId and questionId are required" }));
          return;
        }

        await respondToConfirmation({
          taskId: params.taskId,
          questionId: params.questionId,
          response: params.response || "",
          action: params.action || "continue",
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error("respondToConfirmation error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
    pluginId: "eng-dashboard",
    registry,
  });

  console.log("[eng-dashboard] Plugin registered with 7 HTTP routes (including CORS support)");
}

// 插件定义 (符合 OpenClaw 插件规范)
export default {
  id: "eng-dashboard",
  name: "Engineering Dashboard",
  description: "工程驾驶舱 - 项目管理和任务驱动 API",
  version: "0.1.0",
  register: registerEngDashboardPlugin,
};
