// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@get-bb/plugin-sdk/app', () => ({ experimental_copyToClipboard: vi.fn(), experimental_Icon: ({ name }: { name: string }) => <span>{name}</span> }));
import { experimental_copyToClipboard } from '@get-bb/plugin-sdk/app';
import { MessageCopy, messageLink } from './message-copy';
afterEach(cleanup);
it('copies Markdown and reports success or failure', async () => {
  vi.mocked(experimental_copyToClipboard).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('denied'));
  render(<MessageCopy text="**Reply**" />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByRole('button', { name: 'Copied' });
  expect(experimental_copyToClipboard).toHaveBeenCalledWith({ text: '**Reply**' });
  fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
  await screen.findByRole('button', { name: 'Copy failed' });
});
it('builds native message and thread links', () => {
  expect(messageLink('proj_example', 'thr_example', 12)).toBe(window.location.origin + '/projects/proj_example/threads/thr_example?msg=12');
  expect(messageLink('proj_example', 'thr_example', null)).toBe(window.location.origin + '/projects/proj_example/threads/thr_example');
});
