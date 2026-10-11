import {attachPhysicalNotices} from '../../../scripts/lib/physical-module-notices';
const [stage,...supplements]=process.argv.slice(2);
if(!stage)throw new Error('Explicit physical stage required');
attachPhysicalNotices(stage,supplements);
