// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_VoiceInputTextarea: ({ onValueChange, onVoiceInputActiveChange, ...props }: any) => <><textarea {...props} onChange={event => onValueChange(event.target.value)} /><button onClick={() => onVoiceInputActiveChange(true)}>Start voice</button><button onClick={() => onVoiceInputActiveChange(false)}>Stop voice</button></> }));
import { Composer } from './composer';
afterEach(cleanup);
it('blocks keyboard and send controls while voice input is active', () => {
  const onSend = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value="Hello" onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId={null} onSend={onSend} /> }, {});
  fireEvent.click(slot.getByRole('button', { name:'More send options' }));
  fireEvent.click(slot.getByRole('button', { name:'Start voice' }));
  const editor = slot.getByRole('textbox', { name:'Reply' }); fireEvent.keyDown(editor, { key:'Enter' });
  fireEvent.click(slot.getByRole('menuitem', { name:'Steer' }));
  expect(slot.getByRole('button', { name:'Send' }).hasAttribute('disabled')).toBe(true);
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button', { name:'Stop voice' })); fireEvent.keyDown(editor, { key:'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
});
