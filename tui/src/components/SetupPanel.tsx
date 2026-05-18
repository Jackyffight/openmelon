import React from 'react';
import {Box, Text} from 'ink';
import type {BootstrapState} from '../core/bootstrap.js';
import {accentColor} from '../theme.js';

type Props = {
	bootstrap: BootstrapState;
};

export function SetupPanel({bootstrap}: Props) {
	return (
		<Box flexDirection="column" marginTop={1} marginBottom={1}>
			<Text color="yellow">Setup required</Text>
			{bootstrap.issues.map(issue => (
				<Text key={issue} color="red">
					! {issue}
				</Text>
			))}
			<Text> </Text>
			{bootstrap.needsTrust && (
				<Text color="white">
					Type <Text color={accentColor}>trust</Text> and press Enter to trust this project directory.
				</Text>
			)}
			{bootstrap.needsProject && (
				<Text color="white">
					Type <Text color={accentColor}>init</Text> and press Enter to initialize this directory as an OpenMelon project.
				</Text>
			)}
			{bootstrap.needsKey && (
				<Text color="white">
					Type <Text color={accentColor}>key sk-...</Text> and press Enter to save a {bootstrap.provider} API key.
				</Text>
			)}
		</Box>
	);
}
