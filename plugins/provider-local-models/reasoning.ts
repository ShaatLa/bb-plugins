import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export type Caps = { knob: 'reasoning_effort' | 'reasoning_strength' | null; levels: string[]; none: boolean; checkedAt: number };
export function deriveCaps(body: any): Caps {
  const template = String(body.chat_template ?? ''), caps = body.chat_template_caps;
  const levels = caps?.supports_reasoning_effort && Array.isArray(caps.reasoning_effort_levels) ? caps.reasoning_effort_levels.filter((x: unknown) => ['low','medium','high','xhigh'].includes(String(x))) : [];
  return { knob: levels.length ? 'reasoning_effort' : template.includes('reasoning_strength') ? 'reasoning_strength' : null, levels: levels.length ? levels : template.includes('reasoning_strength') ? ['low','medium','high','xhigh'] : [], none: template.includes('enable_thinking'), checkedAt: Date.now() };
}
export function reasoningParams(caps: Caps | undefined, effort: string | undefined) {
  if (!caps || !effort) return {};
  if (effort === 'none' && caps.none) return { reasoning_effort: 'none' };
  const order = ['low','medium','high','xhigh'];
  const level = order.filter(value => caps.levels.includes(value)).reduce<string | undefined>((best, value) => !best || Math.abs(order.indexOf(value)-order.indexOf(effort)) <= Math.abs(order.indexOf(best)-order.indexOf(effort)) ? value : best, undefined);
  return !level || !caps.knob ? {} : caps.knob === 'reasoning_effort' ? { reasoning_effort: level } : { chat_template_kwargs: { reasoning_strength: level } };
}
export function readCaps(dataDir: string): Record<string, Caps> {
  try { return JSON.parse(readFileSync(join(dataDir,'model-caps.json'),'utf8')); } catch { return {}; }
}
