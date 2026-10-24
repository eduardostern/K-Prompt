/** npm run term: rebuilds src/programs/TERM.tap from programs/TERM.asm. */
import { writeFileSync } from 'node:fs';
import { buildTermTap } from './build-term';

const tap = buildTermTap();
writeFileSync(new URL('../src/programs/TERM.tap', import.meta.url), tap);
console.log(`TERM.tap: ${tap.length} bytes`);
