import type { TaskSort } from "../shared/pagination.js";
import type { TaskStatusDefinition } from "../shared/statuses.js";
import type { Evidence } from "../shared/contract.js";
import type {
  PRESET_ENVIRONMENT_KINDS,
  PresetPermissionMode,
  PresetReasoningLevel,
  PresetServiceTier,
  TASK_THREAD_LIVE_STATUSES,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "../shared/contract.js";

export type { TaskPriority, TaskStatus };

type CommentKind = "user" | "agent" | "system";

export type TaskThreadLiveStatus = (typeof TASK_THREAD_LIVE_STATUSES)[number];

export type PresetEnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];

export interface Folder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  nextTaskNumber: number;
  statuses?: TaskStatusDefinition[];
  color: string;
  folderId: string | null;
  linkedBbProjectId: string | null;
  createdAt: string;
}

export interface Task {
  archivedAt?: string | null;
  id: string;
  projectId: string;
  number: number;
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  parentTaskId: string | null;
  type: TaskType;
  executionTarget: "agent" | "owner";
  requesterThreadId: string | null;
  epicId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

export interface TaskLabel {
  taskId: string;
  labelId: string;
}

export interface Comment {
  evidence?: Evidence;
  id: string;
  taskId: string;
  kind: CommentKind;
  authorName: string;
  presetName: string | null;
  threadId: string | null;
  body: string;
  notifiedCount: number;
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId: string | null;
  commentId: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  isImage: boolean;
  createdAt: string;
}

export interface TaskThread {
  id: string;
  taskId: string;
  threadId: string;
  presetName: string;
  title: string;
  liveStatus: TaskThreadLiveStatus;
  attachedAt: string;
  updatedAt: string;
}

export interface Preset {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: PresetReasoningLevel;
  serviceTier: PresetServiceTier | null;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
  instructions: string;
  builtin: boolean;
  createdAt: string;
}

export interface CreateFolderInput {
  name: string;
  parentFolderId?: string | null;
}

export interface UpdateFolderInput {
  name?: string;
  parentFolderId?: string | null;
}

export interface DeleteFolderResult {
  deleted: boolean;
  movedProjectIds: string[];
  movedFolderIds: string[];
}

export interface CreateProjectInput {
  name: string;
  prefix: string;
  color: string;
  folderId?: string | null;
  linkedBbProjectId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  prefix?: string;
  color?: string;
  folderId?: string | null;
  linkedBbProjectId?: string | null;
  statuses?: TaskStatusDefinition[];
}

export interface CreateTaskInput {
  requesterThreadId?: string | null;
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
  type?: TaskType;
  executionTarget?: "agent" | "owner";
  epicId?: string | null;
}

export interface UpdateTaskInput {
  requesterThreadId?: string | null;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
  type?: TaskType;
  executionTarget?: "agent" | "owner";
  epicId?: string | null;
}

export interface MoveTaskToProjectResult {
  task: Task;
  moved: Array<{ previousKey: string; task: Task }>;
}

export interface ListTasksFilters {
  archive?: "active" | "archived" | "all";
  projectId?: string;
  statuses?: readonly TaskStatus[];
  excludeStatuses?: readonly TaskStatus[];
  priorities?: readonly TaskPriority[];
  labelIds?: readonly string[];
  activeOnly?: boolean;
  parentTaskId?: string | null;
  type?: TaskType;
  executionTarget?: "agent" | "owner";
  epicId?: string | null;
  search?: string;
  sort?: TaskSort;
  limit?: number;
  cursor?: string;
}

export interface ListTasksPage {
  tasks: Task[];
  nextCursor: string | null;
}

export interface UpdateTaskPositionInput {
  status: TaskStatus;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}

export interface CreateLabelInput {
  projectId: string;
  name: string;
  color: string;
}

export interface UpdateLabelInput {
  name?: string;
  color?: string;
}

export interface CreateCommentInput {
  evidence?: Evidence;
  taskId: string;
  kind: CommentKind;
  authorName: string;
  presetName?: string | null;
  threadId?: string | null;
  body: string;
}

export interface UpdateCommentInput {
  notifiedCount: number;
}

export interface CreateAttachmentInput {
  taskId?: string | null;
  commentId?: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  isImage: boolean;
}

export interface UpdateAttachmentInput {
  blobPath: string;
}

export interface UpsertTaskThreadInput {
  taskId: string;
  threadId: string;
  presetName: string;
  title: string;
  liveStatus: TaskThreadLiveStatus;
}

export interface CreatePresetInput {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: PresetReasoningLevel;
  serviceTier: PresetServiceTier | null;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
  instructions: string;
  builtin?: boolean;
}

export interface UpdatePresetInput {
  name?: string;
  providerId?: string;
  modelId?: string;
  reasoningLevel?: PresetReasoningLevel;
  serviceTier?: PresetServiceTier | null;
  permissionMode?: PresetPermissionMode;
  environmentKind?: PresetEnvironmentKind;
  baseBranch?: string | null;
  machineId?: string | null;
  instructions?: string;
  builtin?: boolean;
}
