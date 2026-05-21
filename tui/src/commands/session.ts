import {loadSessionEvents} from '../core/session.js';
import {formatTable, numberFlag, parseArgs, resolveProjectWorkdir} from './common.js';

export async function runSessionCommand(args: string[]) {
	const [subcommand, ...rest] = args;
	switch (subcommand) {
		case 'events':
			return sessionEvents(rest);
		default:
			throw new Error('usage: openmelon session <events> ...');
	}
}

async function sessionEvents(args: string[]) {
	const parsed = parseArgs(args, {n: 'number'});
	const id = parsed.positionals[0];
	if (!id) {
		throw new Error('usage: openmelon session events <session-id> [-n 50]');
	}
	const {workdir} = await resolveProjectWorkdir();
	const events = await loadSessionEvents(workdir, id, numberFlag(parsed, 'n', 50));
	if (events.length === 0) {
		console.log('No events recorded for this session.');
		return;
	}
	console.log(
		formatTable(
			['TIME', 'TYPE', 'STEP', 'TOOL', 'SPACE', 'STATUS'],
			events.map(event => [formatDate(event.at), event.type ?? '', event.step ?? '', event.tool ?? '', event.space_id ?? '', event.status ?? ''])
		)
	);
}

function formatDate(value?: string) {
	const date = value ? new Date(value) : new Date(0);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
