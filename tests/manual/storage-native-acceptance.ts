import { runStorageAcceptance } from '../helpers/storage-acceptance';
const binary = process.argv[2];
if (!binary) throw new Error('Provide an absolute native executable path after building it');
await runStorageAcceptance(binary);
