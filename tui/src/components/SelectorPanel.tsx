import React from 'react';
import {Box, Text} from 'ink';
import {accentColor} from '../theme.js';

export type SelectorRow = {
	id: string;
	title: string;
	subtitle?: string;
	checked?: boolean;
	disabled?: boolean;
};

type Props = {
	title: string;
	description?: string;
	rows: SelectorRow[];
	active: number;
	footer?: string;
};

export function SelectorPanel({title, description, rows, active, footer}: Props) {
	return (
		<Box flexDirection="column" marginTop={1} marginBottom={1}>
			<Text bold>{title}</Text>
			{description && <Text color="gray">{description}</Text>}
			<Text> </Text>
			{rows.map((row, index) => (
				<Box key={row.id || row.title} flexDirection="column" marginBottom={1}>
					<Text color={index === active ? accentColor : row.disabled ? 'gray' : 'white'} bold={index === active}>
						{index === active ? '› ' : '  '}
						{index + 1}. {row.title}
						{row.checked ? ' ✓' : ''}
					</Text>
					{row.subtitle && (
						<Box marginLeft={5}>
							<Text color="gray">{row.subtitle}</Text>
						</Box>
					)}
				</Box>
			))}
			{footer && <Text color="gray">{footer}</Text>}
		</Box>
	);
}
