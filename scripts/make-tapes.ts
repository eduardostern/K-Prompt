/** npm run tapes: rebuilds the programs on the shelf (src/programs/*.tap) from programs/*.asm. */
import { writeFileSync } from 'node:fs';
import { buildI1termTap, buildTermTap } from './build-term';
import { buildUlaTap } from './build-ula';
import { buildUla2Tap } from './build-ula2';

for (const [name, tap] of [['TERM', buildTermTap()], ['I1TERM', buildI1termTap()], ['ULA', buildUlaTap()], ['ULA2', buildUla2Tap()]] as const) {
  writeFileSync(new URL(`../src/programs/${name}.tap`, import.meta.url), tap);
  console.log(`${name}.tap: ${tap.length} bytes`);
}
