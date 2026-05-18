import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Static, Text, render, useApp, useInput, useStdout} from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

type Command = {
	name: string;
	help: string;
};

type TranscriptItem = {
	id: number;
	kind: 'user' | 'assistant' | 'tool' | 'result' | 'info' | 'error';
	text: string;
};

const commands: Command[] = [
	{name: '/help', help: 'show commands and keybindings'},
	{name: '/status', help: 'show model, reasoning, project, and tokens'},
	{name: '/history', help: 'print the simulated transcript'},
	{name: '/clear', help: 'clear the current spike transcript'},
	{name: '/model', help: 'switch the text model'},
	{name: '/model-image', help: 'switch the image model'},
	{name: '/settings', help: 'open settings'},
	{name: '/copy', help: 'copy transcript via OSC52 in production'},
	{name: '/exit', help: 'exit the spike'}
];

const longLine =
	'这是一段很长的中文输出，用来验证 resize、自动换行、复制和滚动行为；it also includes a very long English segment_that_should_wrap_without_breaking_the_prompt_or_overflowing_the_terminal_width.';

function App() {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const width = Math.max(32, stdout.columns ?? 88);
	const [items, setItems] = useState<TranscriptItem[]>([]);
	const [input, setInput] = useState('');
	const [history, setHistory] = useState<string[]>([]);
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const [historyDraft, setHistoryDraft] = useState('');
	const [paletteIndex, setPaletteIndex] = useState(0);
	const [pending, setPending] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const [quitArmedAt, setQuitArmedAt] = useState<number | null>(null);
	const [notice, setNotice] = useState('');
	const nextId = useRef(1);
	const latestInput = useRef(input);

	useEffect(() => {
		latestInput.current = input;
	}, [input]);

	const append = useCallback((kind: TranscriptItem['kind'], text: string) => {
		setItems(previous => [...previous, {id: nextId.current++, kind, text}]);
	}, []);

	const filteredCommands = useMemo(() => {
		const firstLine = input.split('\n')[0]?.trimStart() ?? '';
		if (!firstLine.startsWith('/') || /\s/.test(firstLine)) {
			return [];
		}
		return commands.filter(command => command.name.startsWith(firstLine));
	}, [input]);

	useEffect(() => {
		if (paletteIndex >= filteredCommands.length) {
			setPaletteIndex(0);
		}
	}, [filteredCommands.length, paletteIndex]);

	const runSimulatedTurn = useCallback((text: string) => {
		append('user', `› ${text}`);
		setRunning(true);
		const steps: Array<[TranscriptItem['kind'], string]> = [
			['tool', '● planning simulated creator workflow'],
			['assistant', ` ${longLine}`],
			['tool', '● bash  echo validating static transcript and prompt redraw'],
			['result', ' tool result: ok; output stayed in scrollback'],
			['assistant', `assistant received: ${text}`]
		];

		let index = 0;
		const timer = setInterval(() => {
			const step = steps[index++];
			if (step) {
				append(step[0], step[1]);
				return;
			}

			clearInterval(timer);
			setRunning(false);
			setPending(current => {
				if (current.length === 0) {
					return current;
				}
				const merged = current.join('\n\n');
				setTimeout(() => {
					append('info', '↳ applying pending input at next model-call boundary');
					runSimulatedTurn(merged);
				}, 0);
				return [];
			});
		}, 650);
	}, [append]);

	const submit = useCallback((raw: string) => {
		const text = raw.trim();
		if (text.length === 0) {
			return;
		}
		setQuitArmedAt(null);
		setNotice('');
		setHistory(previous => previous[previous.length - 1] === text ? previous : [...previous, text]);
		setHistoryIndex(null);
		setHistoryDraft('');
		setInput('');

		if (text === '/exit' || text === '/quit' || text === '/q') {
			exit();
			return;
		}
		if (text === '/help') {
			append('info', 'Commands:\n' + commands.map(command => `  ${command.name.padEnd(13)} ${command.help}`).join('\n'));
			return;
		}
		if (text === '/clear') {
			setItems([]);
			append('info', 'history cleared');
			return;
		}

		if (running) {
			setPending(previous => [...previous, text]);
			append('info', `queued pending input (${pending.length + 1})`);
			return;
		}

		runSimulatedTurn(text);
	}, [append, exit, pending.length, runSimulatedTurn, running]);

	useInput((chunk, key) => {
		if (key.ctrl && chunk === 'c') {
			const hasInput = latestInput.current.trim().length > 0;
			if (hasInput) {
				setHistory(previous => previous[previous.length - 1] === latestInput.current ? previous : [...previous, latestInput.current]);
				setInput('');
				setHistoryIndex(null);
				setNotice('input cleared');
				return;
			}
			const now = Date.now();
			if (quitArmedAt && now - quitArmedAt < 2000) {
				exit();
				return;
			}
			setQuitArmedAt(now);
			setNotice('press Ctrl-C again to quit');
			return;
		}

		if (key.escape) {
			if (latestInput.current.trim().length > 0) {
				setHistory(previous => previous[previous.length - 1] === latestInput.current ? previous : [...previous, latestInput.current]);
				setInput('');
				setHistoryIndex(null);
				setNotice('input cleared');
			} else {
				setNotice('');
			}
			return;
		}

		if (filteredCommands.length > 0 && key.upArrow) {
			setPaletteIndex(index => (index <= 0 ? filteredCommands.length - 1 : index - 1));
			return;
		}

		if (filteredCommands.length > 0 && key.downArrow) {
			setPaletteIndex(index => (index + 1) % filteredCommands.length);
			return;
		}

		if (filteredCommands.length > 0 && key.tab) {
			setInput(`${filteredCommands[paletteIndex]?.name ?? '/'} `);
			setPaletteIndex(0);
			return;
		}

		if (key.upArrow && !input.includes('\n') && history.length > 0) {
			setHistoryIndex(index => {
				if (index === null) {
					setHistoryDraft(input);
					const next = history.length - 1;
					setInput(history[next] ?? '');
					return next;
				}
				const next = Math.max(0, index - 1);
				setInput(history[next] ?? '');
				return next;
			});
			return;
		}

		if (key.downArrow && historyIndex !== null) {
			const next = historyIndex + 1;
			if (next >= history.length) {
				setHistoryIndex(null);
				setInput(historyDraft);
			} else {
				setHistoryIndex(next);
				setInput(history[next] ?? '');
			}
			return;
		}

		if (key.return) {
			if (key.shift) {
				setInput(value => `${value}\n`);
				return;
			}
			if (filteredCommands.length > 0 && input.trim() === '/') {
				setInput(`${filteredCommands[paletteIndex]?.name ?? '/'} `);
				return;
			}
			submit(input);
			return;
		}

		if (key.backspace || key.delete) {
			setInput(value => Array.from(value).slice(0, -1).join(''));
			setHistoryIndex(null);
			return;
		}

		if (chunk) {
			setInput(value => value + chunk);
			setHistoryIndex(null);
			setNotice('');
		}
	});

	return (
		<Box flexDirection="column">
			<Static items={items}>
				{item => <Transcript key={item.id} item={item} width={width} />}
			</Static>
			<Box flexDirection="column" marginTop={1}>
				{running && (
					<Text color="cyan">
						⠋ Thinking · {pending.length} pending · enter queues context
					</Text>
				)}
				{filteredCommands.length > 0 && (
					<Palette commands={filteredCommands} active={paletteIndex} />
				)}
				<Prompt input={input} width={width} />
				<Box>
					<Text color="white">gpt-5.5 · xhigh · bigone</Text>
					<Text color="white">  </Text>
					<Text color={notice ? 'yellow' : 'white'}>
						{notice || 'Ctrl-J/Shift-Enter newline · Esc clears · Ctrl-C twice exits'}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function Transcript({item, width}: {item: TranscriptItem; width: number}) {
	const color = {
		user: 'cyan',
		assistant: 'white',
		tool: 'green',
		result: 'gray',
		info: 'gray',
		error: 'red'
	}[item.kind] as 'cyan' | 'white' | 'green' | 'gray' | 'red';
	const wrapped = wrapBlock(item.text, width - 2);
	return (
		<Box flexDirection="column" marginBottom={item.kind === 'tool' ? 1 : 0}>
			{wrapped.map((line, index) => (
				<Text key={`${item.id}-${index}`} color={color}>
					{line}
				</Text>
			))}
		</Box>
	);
}

function Palette({commands, active}: {commands: Command[]; active: number}) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			{commands.slice(0, 8).map((command, index) => (
				<Box key={command.name}>
					<Text color={index === active ? 'black' : 'cyan'} backgroundColor={index === active ? 'cyan' : undefined}>
						{index === active ? '› ' : '  '}
						{command.name.padEnd(13)}
					</Text>
					<Text color="gray"> {command.help}</Text>
				</Box>
			))}
		</Box>
	);
}

function Prompt({input, width}: {input: string; width: number}) {
	const prompt = '› ';
	const available = Math.max(12, width - stringWidth(prompt) - 4);
	const lines = input.length === 0 ? ['Ask OpenMelon'] : wrapBlock(input, available);
	return (
		<Box flexDirection="column">
			{lines.map((line, index) => (
				<Box key={index}>
					<Text color="cyan">{index === 0 ? prompt : '  '}</Text>
					<Text color={input.length === 0 ? 'gray' : 'white'}>{line}</Text>
					{index === lines.length - 1 && <Text color="cyan">▌</Text>}
				</Box>
			))}
		</Box>
	);
}

function wrapBlock(text: string, width: number): string[] {
	const columns = Math.max(12, width);
	return text.split('\n').flatMap(line => {
		if (line.length === 0) {
			return [''];
		}
		return wrapAnsi(line, columns, {hard: false, trim: false}).split('\n');
	});
}

render(<App />);
