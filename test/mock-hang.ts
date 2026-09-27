import { createInterface } from 'node:readline';

// Accept ACP input and never answer, so discovery timeouts can be tested.
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', () => undefined);
