import React from 'react';
import {Box, Text} from 'ink';
import type {SlashCommand} from '../commands.js';
import {accentColor} from '../theme.js';

type Props = {
	commands: SlashCommand[];
	active: number;
};

export function SlashPalette({commands, active}: Props) {
	if (commands.length === 0) {
		return null;
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			{commands.slice(0, 8).map((command, index) => (
				<Box key={command.name}>
					<Text
						color={index === active ? 'black' : accentColor}
						backgroundColor={index === active ? accentColor : undefined}
					>
						{index === active ? '› ' : '  '}
						{command.name.padEnd(14)}
					</Text>
					<Text color="gray"> {command.help}</Text>
				</Box>
			))}
		</Box>
	);
}
