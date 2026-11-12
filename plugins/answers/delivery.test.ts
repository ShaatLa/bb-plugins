import { expect, it } from 'vitest';
import { deliveryError } from './delivery';

it('tells a refused send from one that may have reached the thread', () => {
  expect(deliveryError(Object.assign(new Error('Bad input'), { status: 400 }))).toBe('Not sent: Bad input');
  expect(deliveryError(Object.assign(new Error('No thread'), { code: 'not_found' }))).toBe('Not sent: No thread');
  expect(deliveryError(new Error('Failed to fetch'))).toBe('Delivery uncertain — check the thread before retrying. Failed to fetch');
  expect(deliveryError(Object.assign(new Error('Boom'), { status: 502 }))).toMatch(/^Delivery uncertain/);
  expect(deliveryError(new Error('Not sent: that time has passed'))).toBe('Not sent: that time has passed');
  expect(deliveryError(new Error('Delivery uncertain — check the thread before retrying. Offline'))).toBe('Delivery uncertain — check the thread before retrying. Offline');
});
