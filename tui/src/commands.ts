export type SlashCommand = {
	name: string;
	help: string;
};

export const slashCommands: SlashCommand[] = [
	{name: '/help', help: 'show commands and keybindings'},
	{name: '/?', help: 'show commands and keybindings'},
	{name: '/skill', help: 'pick or clear a skillplus package for the next message'},
	{name: '/status', help: 'show project, model, reasoning, and token status'},
	{name: '/history', help: 'print the message log so far'},
	{name: '/save', help: 'write the conversation to a file (jsonl)'},
	{name: '/clear', help: 'forget the conversation history'},
	{name: '/model', help: 'switch the text model'},
	{name: '/model-image', help: 'switch or disable image generation'},
	{name: '/settings', help: 'open project settings'},
	{name: '/copy', help: 'copy transcript via OSC52 when wired'},
	{name: '/session', help: 'show current session information'},
	{name: '/events', help: 'show recent runtime events'},
	{name: '/space', help: 'show creative-space memory summary'},
	{name: '/compact', help: 'preview context compaction'},
	{name: '/exit', help: 'exit OpenMelon'}
];

export function filterSlashCommands(input: string): SlashCommand[] {
	const firstLine = input.split('\n')[0]?.trimStart() ?? '';
	if (!firstLine.startsWith('/') || /\s/.test(firstLine)) {
		return [];
	}
	const matches = slashCommands.filter(command => command.name.startsWith(firstLine));
	if (matches.length === 0 && firstLine === '/') {
		return slashCommands;
	}
	return matches;
}
