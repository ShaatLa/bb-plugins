// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
afterEach(cleanup);
import { ContextRing, type ContextUsage } from './context-ring';

const snapshot = { autoCompactAtTokens: null, capturedAt: '2026-11-15T00:00:00.000Z', contextWindowTokens: 1000, estimated: false, model: 'm', providerSessionId: 's', providerTurnId: null, usedTokens: 800,
  categories: [{ id: 'msgs', kind: 'used', label: 'Messages', tokens: 700, entries: [] }, { id: 'tools', kind: 'used', label: 'Tools', tokens: 100, entries: [{ id: 'bash', label: 'Bash', tokens: 100 }] }, { id: 'free', kind: 'free', label: 'Free space', tokens: 200, entries: [] }, { id: 'mcp', kind: 'deferred', label: 'MCP tools (deferred)', tokens: 50, entries: [] }] } as const;

describe('ContextRing', () => {
  it('opens bb\'s context card on click: used, left and cost, in bb\'s warning tone from 75%', () => {
    const usage: ContextUsage = { usedTokens: 800, modelContextWindow: 1000, estimated: false, cost: { amount: 1.5, currency: 'USD' } };
    const view = render(<ContextRing usage={usage} />), ring = view.getByRole('button', { name: 'Context window 80% used' });
    expect(ring.querySelector('svg')!.getAttribute('class')).toContain('text-warning-text');
    fireEvent.click(ring);
    const card = view.getByRole('dialog', { name: 'Context window' });
    expect(card.textContent).toContain('80% used'); expect(card.textContent).toContain('800 / 1k tokens'); expect(card.textContent).toContain('20% left'); expect(card.textContent).toContain('Session cost');
    expect(view.queryByText('Show details')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(view.queryByRole('dialog')).toBeNull();
  });
  it('shows the provider\'s breakdown behind Show details, deferred items apart', () => {
    const view = render(<ContextRing usage={{ usedTokens: 800, modelContextWindow: 1000, estimated: true, snapshot: snapshot as unknown as ContextUsage['snapshot'] }} />);
    fireEvent.click(view.getByRole('button', { name: 'Context window 80% used' }));
    expect(view.getByRole('dialog', { name: 'Estimated context' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Show details' }));
    expect(view.getByText('In context')).toBeTruthy(); expect(view.getByText('70.0%')).toBeTruthy(); expect(view.getByText('Available on demand')).toBeTruthy(); expect(view.getByText('MCP tools')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Tools/ })); expect(view.getByText('Bash')).toBeTruthy();
  });
});
