import { generateRepoOrientation } from '../apps/server/src/lib/repoOrientation.js';
const target = process.argv[2];
if (!target) { console.error('usage: tsx scripts/orientation-probe.ts <repo-path>'); process.exit(1); }
const b = generateRepoOrientation(target);
console.log('repo:', target);
console.log('chars:', b.length, '| approx tokens:', Math.round(b.length / 4), '| partial:', b.includes('partial'));
console.log('---');
console.log(b.slice(0, 2000));
