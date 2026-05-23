const placeholders = [
	'/settings configures project defaults, bash permissions, and reasoning.',
	'/model switches the text model for the current project.',
	'/model-image switches or disables image generation.',
	'/space shows the current creative-space memory summary.',
	'/copy copies the transcript when the runtime bridge is wired.',
	'Implement a creator workflow for a new content series.',
	'Continue yesterday’s post and keep the visual style consistent.'
];

export function randomPlaceholder() {
	return placeholders[Math.floor(Math.random() * placeholders.length)] ?? placeholders[0];
}
