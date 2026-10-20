import {readFileSync} from 'node:fs';
import {attachPhysicalNotices} from '../../../scripts/lib/physical-module-notices';
const [stage,...supplements]=process.argv.slice(2);
if(!stage)throw new Error('Explicit physical stage required');
const registry=supplements[0]==='--registry-lock';
if(registry&&supplements.length<3)throw new Error('Registry notice lock and supplements required');
attachPhysicalNotices(stage,registry?supplements.slice(2):supplements,registry?readFileSync(supplements[1]!):undefined);
