import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { z } from 'zod';
import { AgentError } from '@realtime-agent/agent';
import type { CuaTool, CuaResult } from './cua-transport.js';

export interface CuaConnection {
  readonly tools: CuaTool[];
  readonly metadata: Record<string, unknown>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult>;
  close(): Promise<void>;
}
export interface ComputerWindow { id: string; pid: number; title: string; appName: string; zIndex: number | null; minimized: boolean }
export interface ComputerEvidence {
  id: string;
  taskId: string | null;
  tool: string;
  arguments: Record<string, unknown>;
  capturedAt: number;
  data: unknown;
  text: string;
  isError: boolean;
  errorCode?: string;
  verified?: boolean;
  degraded?: boolean;
  truncated: boolean;
}
export interface ComputerStep { tool: string; arguments: Record<string, unknown>; purpose: string }

const checkSchema = z.object({
  evidenceId: z.string().min(1).max(100),
  pointer: z.string().max(500),
  operator: z.enum(['equals', 'contains']),
  expected: z.union([z.string().min(1).max(20000), z.number().finite(), z.boolean()]),
  description: z.string().min(1).max(500),
}).strict();
export const computerPlanSchema = z.object({
  summary: z.string().min(1).max(1000),
  steps: z.array(z.object({ tool: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()), purpose: z.string().min(1).max(500) }).strict()).max(6),
  completion: z.object({ summary: z.string().min(1).max(1000), checks: z.array(checkSchema).max(8),
    visual: z.object({ evidenceId: z.string().min(1).max(100), description: z.string().min(1).max(1200) }).strict().optional(),
  }).strict().nullable(),
  blocked: z.string().min(1).max(1000).nullable(),
}).strict().superRefine((plan, context) => {
  if ([plan.steps.length > 0, plan.completion !== null, plan.blocked !== null].filter(Boolean).length !== 1) {
    context.addIssue({ code: 'custom', message: 'Return exactly one of next steps, evidence-backed completion, or a blocked explanation.' });
  }
  if (plan.completion && plan.completion.checks.length === 0 && !plan.completion.visual) context.addIssue({ code: 'custom', message: 'Completion requires observed data or a grounded visual check.' });
});
export type ComputerPlan = z.infer<typeof computerPlanSchema>;

// The model receives actual installed schemas for computer-use operations. Runtime
// administration, arbitrary code execution and permission changes remain host APIs.
const supported = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state', 'get_screen_size', 'get_cursor_position',
  'launch_app', 'activate_app', 'activate_window', 'focus_window', 'open_url', 'open_file', 'close_window', 'resize_window', 'move_window',
  'bring_to_front', 'set_window_frame', 'zoom', 'page', 'browser_download',
  'click', 'right_click', 'double_click', 'move_cursor', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'select_menu_item',
  'get_menu', 'get_menus', 'invoke_menu', 'verify_state', 'perform_ax_action', 'perform_uia_action', 'verify_file',
  'browser_prepare', 'get_browser_state', 'browser_navigate', 'browser_click', 'browser_type', 'browser_fill', 'browser_select',
  'browser_press_key', 'browser_key', 'browser_scroll', 'browser_pointer', 'browser_dialog', 'browser_set_input_files',
  'parse_visual_regions', 'clipboard_read', 'clipboard_write',
]);
export const observationTools = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state',
  'get_screen_size', 'get_cursor_position', 'get_browser_state', 'parse_visual_regions', 'clipboard_read', 'verify_state', 'zoom']);
const evidenceTools = new Set(['get_window_state', 'get_browser_state', 'clipboard_read', 'verify_file', 'verify_state']);
const hostFields = new Set(['session', 'screenshot_out_file', 'user_has_confirmed_enabling', 'capability_manifest', 'permission_mode']);

export const fileVerificationTool: CuaTool = {
  name: 'verify_file',
  description: 'Read back an explicitly requested local output file after saving it through the GUI. Read-only: never creates or edits a file. The absolute path must occur in the user goal. Returns exists, text (for a bounded UTF-8/UTF-16 text file), byteLength and sha256. Use this to verify the saved artifact rather than an unsaved editor.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['path'], additionalProperties: false },
};

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export class ComputerTools {
  readonly tools: CuaTool[];
  private validators = new Map<string, ValidateFunction>();
  constructor(catalog: readonly CuaTool[]) {
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, coerceTypes: false });
    this.tools = catalog.filter(tool => supported.has(tool.name)).map(tool => {
      const schema = structuredClone(tool.inputSchema);
      delete schema.$schema;
      const properties = record(schema.properties);
      for (const name of hostFields) delete properties[name];
      schema.properties = properties;
      if (Array.isArray(schema.required)) schema.required = schema.required.filter(name => !hostFields.has(String(name)));
      schema.additionalProperties = false;
      this.validators.set(tool.name, ajv.compile(schema));
      return { name: tool.name, description: tool.description.slice(0, 1600), inputSchema: schema };
    });
  }
  has(name: string): boolean { return this.validators.has(name); }
  validate(step: ComputerStep): void {
    const validate = this.validators.get(step.tool);
    if (!validate) throw new AgentError('unsupported_cua_tool', `当前 Cua Driver 未提供操作 ${step.tool}。`, 0);
    if (!validate(step.arguments)) {
      const detail = validate.errors?.[0];
      throw new AgentError('invalid_cua_arguments', `${step.tool} 参数不符合实际 Driver 接口：${detail?.instancePath || '/'} ${detail?.message ?? 'invalid'}。`, 0);
    }
    if (JSON.stringify(step.arguments).length > 64000) throw new AgentError('input_limit', '操作参数超过长度上限。', 0);
    for (const field of hostFields) if (Object.hasOwn(step.arguments, field)) throw new AgentError('host_only', '该参数由运行宿主管理。', 0);
    // Bound expensive captures without fabricating or changing model coordinates.
    if (step.tool === 'get_window_state') {
      const { max_elements, max_depth } = step.arguments;
      if (typeof max_elements === 'number' && max_elements > 1000 || typeof max_depth === 'number' && max_depth > 40) {
        throw new AgentError('capture_limit', '请使用 max_elements<=1000、max_depth<=40，并按需查询控件。', 0);
      }
    }
  }
  modelCatalog(): CuaTool[] {
    const reduce = (value: unknown): unknown => Array.isArray(value) ? value.map(reduce)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'title' && key !== 'examples')
        .map(([key, child]) => [key, key === 'description' && typeof child === 'string' ? child.slice(0, 240) : reduce(child)])) : value;
    return this.tools.map(tool => ({ name: tool.name, description: tool.description.slice(0, 700), inputSchema: reduce(tool.inputSchema) as Record<string, unknown> }));
  }
}

/** Keep real JSON paths and identities intact; report every projection explicitly. */
export function compactData(value: unknown, maxChars = 36000): { data: unknown; truncated: boolean } {
  let budget = maxChars, truncated = false;
  const visit = (item: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 12) { truncated = true; return null; }
    if (typeof item === 'string') {
      const limit = Math.min(budget, 12000); budget -= Math.min(limit, item.length);
      if (item.length > limit) truncated = true;
      return item.slice(0, limit);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') { budget -= 16; return item; }
    if (Array.isArray(item)) {
      if (item.length > 180) truncated = true;
      return item.slice(0, 180).map(child => visit(child, depth + 1));
    }
    if (typeof item === 'object' && item) {
      const entries: [string, unknown][] = [];
      for (const [key, child] of Object.entries(item)) {
        if (['tree_markdown', 'screenshot', 'screenshot_base64', 'data_base64', 'png_base64', 'image_base64'].includes(key)) continue;
        if (budget <= 0) { truncated = true; break; }
        budget -= key.length;
        entries.push([key, visit(child, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return null;
  };
  return { data: visit(value, 0), truncated };
}

export function windowsFrom(data: unknown): ComputerWindow[] {
  const source = record(data);
  const values = Array.isArray(source.windows) ? source.windows : Array.isArray(data) ? data : [];
  return values.flatMap(value => {
    const window = record(value), id = window.window_id ?? window.windowId ?? window.id;
    if ((typeof id !== 'number' && typeof id !== 'string') || !Number.isSafeInteger(window.pid)) return [];
    return [{ id: String(id), pid: window.pid, title: String(window.title ?? window.window_title ?? ''),
      appName: String(window.app_name ?? window.name ?? ''), minimized: window.minimized === true,
      zIndex: Number.isFinite(window.z_index) ? window.z_index : null }];
  });
}

export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function checkCompletion(plan: ComputerPlan, evidence: readonly ComputerEvidence[], taskStartedAt: number, taskId?: string, visualEvidenceId?: string): boolean {
  if (!plan.completion || plan.steps.length || !plan.completion.checks.length && !plan.completion.visual) return false;
  const visual = plan.completion.visual;
  if (visual) {
    const source = evidence.find(item => item.id === visual.evidenceId);
    if (visual.evidenceId !== visualEvidenceId || !source || source.isError || source.taskId !== taskId
      || !['get_desktop_state', 'get_window_state', 'get_browser_state', 'zoom'].includes(source.tool)
      || source.capturedAt < taskStartedAt || Date.now() - source.capturedAt > 120000) return false;
  }
  return plan.completion.checks.every(check => {
    const source = evidence.find(item => item.id === check.evidenceId);
    if (!source || source.isError || taskId !== undefined && source.taskId !== taskId || !evidenceTools.has(source.tool)
      || source.capturedAt < taskStartedAt || Date.now() - source.capturedAt > 120000) return false;
    // Only native data or an explicitly requested read-back is evidence, never
    // reflected tool arguments, planner text, receipt success flags or summaries.
    const actual = jsonPointer(source.data, check.pointer);
    return check.operator === 'equals' ? actual === check.expected
      : typeof actual === 'string' && typeof check.expected === 'string' && actual.includes(check.expected);
  });
}
