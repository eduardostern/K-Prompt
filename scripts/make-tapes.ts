/** npm run tapes: rebuilds the programs on the shelf (src/programs/*.tap) from programs/*.asm. */
import { writeFileSync } from 'node:fs';
import { buildTermTap } from './build-term';
import { buildUlaTap } from './build-ula';

for (const [name, tap] of [['TERM', buildTermTap()], ['ULA', buildUlaTap()]] as const) {
  writeFileSync(new URL(`../src/programs/${name}.tap`, import.meta.url), tap);
  console.log(`${name}.tap: ${tap.length} bytes`);
}
