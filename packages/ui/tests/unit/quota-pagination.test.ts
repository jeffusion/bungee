import { expect, test } from 'bun:test';
import { paginateCarouselRows as paginateQuotaAccounts } from '../../src/components/industrial/carousel-pagination';

test('seven accounts pack as 3/3/1 when three complete rows fit', () => {
  expect(paginateQuotaAccounts(Array(7).fill(100), 352, 10)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
});
test('actual row heights and divider spacing determine each page', () => {
  expect(paginateQuotaAccounts([60, 120, 50, 90], 254, 10)).toEqual([[0, 1], [2, 3]]);
  expect(paginateQuotaAccounts([60, 120, 50, 90], 255, 0)).toEqual([[0, 1, 2], [3]]);
});
test('all accounts fitting exactly use the full height without reserving controls', () => {
  expect(paginateQuotaAccounts([100, 100], 210, 10)).toEqual([[0, 1]]);
  expect(paginateQuotaAccounts([100, 100], 209, 10)).toEqual([[0], [1]]);
});
test('short cards and oversized accounts keep every row without an empty page', () => {
  expect(paginateQuotaAccounts([500, 80, 80], 204, 10)).toEqual([[0], [1, 2]]);
  expect(paginateQuotaAccounts([100, 100], 20, 10)).toEqual([[0], [1]]);
  expect(paginateQuotaAccounts([], 200, 10)).toEqual([]);
  expect(paginateQuotaAccounts([0, 100], 200, 10)).toEqual([[0], [1]]);
});
