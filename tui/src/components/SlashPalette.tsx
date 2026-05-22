import React from 'react';
import {Box, Text} from 'ink';
import type {SlashCommand} from '../commands.js';
import {accentColor} from '../theme.js';

type Props = {
	commands: SlashCommand[];
	active: number;
	visibleRows?: number;
};

export function SlashPalette({commands, active, visibleRows = 8}: Props) {
	if (commands.length === 0) {
		return null;
	}
	const total = commands.length;
	const limit = Math.max(1, Math.min(visibleRows, total));
	const safeActive = Math.max(0, Math.min(active, total - 1));
	const start = Math.min(Math.max(0, safeActive - limit + 1), Math.max(0, total - limit));
	const visible = commands.slice(start, start + limit);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{visible.map((command, index) => {
				const commandIndex = start + index;
				const isActive = commandIndex === safeActive;
				return (
					<Box key={command.name}>
						<Text color={isActive ? 'black' : accentColor} backgroundColor={isActive ? accentColor : undefined}>
							{isActive ? '› ' : '  '}
							{command.name.padEnd(14)}
						</Text>
						<Text color="gray"> {command.help}</Text>
					</Box>
				);
			})}
			{total > limit && <Text color="gray">  {safeActive + 1}/{total}</Text>}
		</Box>
	);
}
