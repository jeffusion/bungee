import { test } from 'bun:test';
import { runStorageAcceptance } from '../helpers/storage-acceptance';
test('management login, proxy data and sessions survive a dist restart', () => runStorageAcceptance(), 180_000);
