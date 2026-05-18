export function osc52Copy(text: string) {
	const payload = Buffer.from(text, 'utf8').toString('base64');
	const sequence = `\u001B]52;c;${payload}\u0007`;
	if (process.env.TMUX) {
		process.stderr.write(`\u001BPtmux;\u001B${sequence.replace(/\u001B/g, '\u001B\u001B')}\u001B\\`);
		return;
	}
	process.stderr.write(sequence);
}
